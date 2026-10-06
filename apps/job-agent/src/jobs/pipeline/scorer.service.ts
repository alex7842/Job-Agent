import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { DEFAULT_PREFERENCES } from '@job-agent/shared';
import {
  createResilientChatModel,
  FallbackChatModel,
  resolveChatChain,
  type ChatModel,
} from '@job-agent/ai';
import { Profile } from '../../profile/profile.entity.js';
import { Job } from '../entities/job.entity.js';

const ResultSchema = z.object({
  score: z.number().min(0).max(100),
  reason: z.string(),
  highlights: z.array(z.string()).default([]),
  redFlags: z.array(z.string()).default([]),
});
export type ScoreResult = z.infer<typeof ResultSchema>;

const SYSTEM = `You are a job-matching assistant. Given a candidate (resume + preferences) and one job posting, rate how well the job fits the candidate.

Scoring guide:
- 85-100: meets nearly all must-have skills, role/seniority/location/salary preferences match
- 65-84: good fit, minor gaps
- 40-64: partial fit, notable gaps or preference mismatches
- 0-39: poor fit

Be strict: a job that shares only a generic word with the resume is a poor fit. Return the same shape the schema requires and nothing else.`;

/**
 * Used when `SCORING_PROVIDER` is unset. The model is *not* named here: it
 * comes from the provider descriptor in @job-agent/ai, so there is exactly one
 * place that decides which model each provider defaults to.
 */
const DEFAULT_SCORING_PROVIDER = 'openrouter';

/**
 * OpenRouter applies this schema as a decoding constraint rather than asking
 * nicely, so the model cannot emit prose or a partial object. The schema is
 * still repeated in the prompt: the model never sees it as context, only as a
 * generation constraint, and repeating it keeps its reason strings on-topic.
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    score: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description:
        'Fit score as a whole number from 0 to 100 inclusive, e.g. 87. Never a fraction.',
    },
    reason: {
      type: 'string',
      maxLength: 200,
      description: 'Max 200 characters explaining the score',
    },
    highlights: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 3,
      description: 'Up to 3 short strengths',
    },
    redFlags: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 3,
      description:
        'Up to 3 short concerns, e.g. seniority mismatch, missing skill, low pay, onsite-only',
    },
  },
  required: ['score', 'reason', 'highlights', 'redFlags'],
  additionalProperties: false,
} as const;

@Injectable()
export class ScorerService {
  /**
   * Provider-agnostic on purpose. The endpoint, the key env var, the default
   * model and the retry behaviour all come from the descriptor, so swapping
   * provider is a `.env` change rather than a code change — and every provider
   * gets the retry-on-429 handling the free tiers require.
   *
   * With `SCORING_FALLBACK_PROVIDER` set the model is a failover chain: a
   * primary that is rate-limited or out of quota hands the request to the
   * fallback instead of failing the row. The fallback is the *same model* by
   * default, so a failover costs latency and nothing else.
   */
  private readonly chat: ChatModel;
  private readonly apiKeyEnv: string;
  private readonly signupUrl: string;
  private readonly missingCredential: boolean;
  /** Provider labels in the order they are tried, for the admin dashboard. */
  readonly chain: string[];
  /** The model the primary provider was configured with. */
  readonly model: string;

  constructor(config: ConfigService) {
    const chain = resolveChatChain((name) => config.get<string>(name), {
      defaultProvider: DEFAULT_SCORING_PROVIDER,
      providerEnv: 'SCORING_PROVIDER',
      modelEnv: 'SCORING_MODEL',
      fallbackProviderEnv: 'SCORING_FALLBACK_PROVIDER',
      fallbackModelEnv: 'SCORING_FALLBACK_MODEL',
      onFailover: ({ from, to, error }) =>
        new Logger(ScorerService.name).warn(
          `Scoring failover ${from} -> ${to}: ${error}. ` +
            `The primary is parked for a minute; requests use ${to} meanwhile.`,
        ),
    });

    this.chain = chain.order;
    this.model = chain.config.model ?? chain.config.fallbacks?.[0]?.model ?? '';
    this.apiKeyEnv = chain.apiKeyEnv;
    this.signupUrl = chain.signupUrl;
    // The credential must come from the env vars *this* provider declares;
    // resolveChatChain handles that. A chain only counts as unusable when no
    // provider in it has a key, since one working provider is enough to score.
    this.missingCredential = chain.missingCredentials.length === chain.order.length;
    this.chat = createResilientChatModel(chain.config);
  }

  /**
   * Live provider state for the admin dashboard: which provider will answer the
   * next request, and what each one last did. Null when no fallback is
   * configured, since there is no chain to describe.
   */
  chainStatus(): ReturnType<FallbackChatModel['status']> | null {
    return this.chat instanceof FallbackChatModel ? this.chat.status() : null;
  }

  async score(job: Job, profile: Profile): Promise<ScoreResult> {
    // Not asserted in the constructor: a missing key must not stop the API from
    // booting, it must surface as a scoreError on the rows that needed it,
    // which is what "Rescore" retries.
    if (this.missingCredential) {
      throw new Error(
        `${this.apiKeyEnv} is not set, so nothing can be scored. Create one at ${this.signupUrl} and restart the API.`,
      );
    }

    const result = await this.chat.complete<unknown>({
      system: SYSTEM,
      // The schema is not repeated here: the chat adapter appends it to the
      // prompt whenever `schema` is set, and doing it in both places spent
      // input tokens restating the constraint twice per job.
      prompt: prompt(job, profile),
      schema: RESPONSE_SCHEMA,
      schemaName: 'ScoreResult',
      temperature: 0.3,
      // Generous for an object this small on purpose: OpenRouter's :free
      // defaults include reasoning models, and their thinking tokens come out of
      // `max_tokens` before the answer begins. At 1024 a scoring answer came
      // back cut off mid-sentence, which zod then rejected as unparseable.
      maxTokens: 2048,
    });

    // Constrained decoding makes this near-certain, but a truncated response
    // (finish_reason "length") or a free-tier model that ignored the constraint
    // can still arrive as prose, so zod remains the last word. The adapter has
    // already retried a truncated reply once with a larger budget, so getting
    // here on "length" means it was not the budget — say so, rather than leaving
    // a truncated string in the log to be decoded later.
    if (!result.data) {
      const truncated = result.finishReason === 'length';
      throw new Error(
        `${this.chat.provider} returned no JSON` +
          (truncated ? ', cut off at the output-token limit even after a larger retry' : '') +
          `: ${clip(result.text, 120)}`,
      );
    }
    const parsed = ResultSchema.safeParse(result.data);
    if (!parsed.success)
      throw new Error(`${this.chat.provider} returned an unusable shape: ${parsed.error.message}`);

    return {
      score: Math.round(parsed.data.score),
      reason: parsed.data.reason.slice(0, 300),
      highlights: parsed.data.highlights.slice(0, 3),
      redFlags: parsed.data.redFlags.slice(0, 3),
    };
  }
}

function prompt(job: Job, profile: Profile): string {
  // preferences is a jsonb column, so it can hold a partial object: a row
  // written before a field existed, or one posted straight to the API. Reading
  // .roles/.join off a missing key throws and takes the whole score with it,
  // so every field is defaulted here rather than trusted.
  const p = { ...DEFAULT_PREFERENCES, ...profile.preferences };
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join(', ') : '');
  return `## Candidate preferences
Roles: ${list(p.roles) || 'any'}
Skills: ${list(p.skills) || 'n/a'}
Locations: ${list(p.locations) || 'any'}
Remote only: ${p.remoteOnly}
Min salary: ${p.minSalary ?? 'n/a'}

## Resume
${(profile.resumeText ?? '').slice(0, 8000) || '(not provided)'}

## Job
Title: ${job.title}
Company: ${job.company}
Location: ${job.location ?? 'n/a'}${job.remote ? ' (remote)' : ''}
Salary: ${job.salaryText ?? 'n/a'}
Description:
${(job.description ?? '').slice(0, 4000)}`;
}

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
