import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RESUME_RESPONSE_SCHEMA, ResumeDataSchema, type ResumeData } from '@job-agent/shared';
import { createResilientChatModel, resolveChatChain, type ChatModel } from '@job-agent/ai';

/**
 * Same provider, key and constrained-decoding contract the job scorer uses, with
 * a schema built for a document rather than a verdict. The model is left to the
 * provider descriptor unless RESUME_PARSING_MODEL names one, so there is one
 * place that decides the default; the token budget is separate because a resume
 * is a much longer input than a posting.
 */

/** Ceiling on what is sent. A resume past this is trimmed from the tail. */
const MAX_RESUME_CHARS = 20_000;
const TIMEOUT_MS = 90_000;
const MAX_TOKENS = 4096;

/**
 * Copy every bullet; a truncated experience entry loses the only evidence of what
 * the candidate actually did.
 */
const SYSTEM = `You extract structured data from a person's resume.

Rules:
- Copy what is written. Never invent a skill, employer, date or credential that is not on the page.
- If a field is absent, return an empty string, an empty array, or null. Do not guess and do not pad.
- Keep the candidate's own wording for summaries and highlights, trimmed of leading bullets and role labels.
- skills: the technologies, tools and methods they demonstrably used. One entry per item, no sentences.
- roles: the job titles they have held, most recent first, as written ("Senior Backend Engineer", not "backend dev").
- yearsOfExperience: total years across all roles, or null when the dates are missing or unreadable. Do not derive it from entry count.
- experience: one entry per role, most recent first. current is true only for a role with no end date.
- Dates stay as written: "Mar 2021", "2020", "Present". Never reformat them.
- links: URLs only (portfolio, GitHub, LinkedIn). An email address is not a link.`;

/** Never lose the top of the document: name, contact and the current role live there. */
export function clipResume(text: string, max = MAX_RESUME_CHARS): string {
  const clean = text.trim();
  return clean.length <= max ? clean : clean.slice(0, max);
}

@Injectable()
export class ResumeParserService {
  private readonly log = new Logger(ResumeParserService.name);
  private readonly chat: ChatModel;
  private readonly apiKeyEnv: string;
  private readonly missingCredential: boolean;
  /** Provider labels in the order they are tried, for the admin dashboard. */
  readonly chain: string[];
  /** The model the primary provider was configured with. */
  readonly model: string;

  constructor(config: ConfigService) {
    // The same chain the scorer uses, so a free tier that runs out mid-upload
    // does not also cost the parse. A resume is one request for the whole
    // profile, which makes failing it more expensive than failing one row.
    const chain = resolveChatChain((name) => config.get<string>(name), {
      defaultProvider: 'openrouter',
      providerEnv: 'SCORING_PROVIDER',
      // The scorer's model unless the parse names its own; a resume is the
      // longer input, so it gets an override only if the cheaper model starts
      // truncating.
      modelEnv: ['RESUME_PARSING_MODEL', 'SCORING_MODEL'],
      fallbackProviderEnv: 'SCORING_FALLBACK_PROVIDER',
      fallbackModelEnv: 'SCORING_FALLBACK_MODEL',
      shared: { timeoutMs: TIMEOUT_MS },
      onFailover: ({ from, to, error }) =>
        this.log.warn(`Resume parsing failover ${from} -> ${to}: ${error}`),
    });

    this.apiKeyEnv = chain.apiKeyEnv;
    this.chain = chain.order;
    this.model = chain.config.model ?? chain.config.fallbacks?.[0]?.model ?? '';
    this.chat = createResilientChatModel(chain.config);
    // One usable provider in the chain is enough to parse; only a chain with no
    // credentials at all is treated as unavailable.
    this.missingCredential = chain.missingCredentials.length === chain.order.length;
  }

  /**
   * The text is returned even when the model is unavailable or answers with
   * something unusable: a resume that could be extracted but not parsed is still
   * worth storing and still works as a search query. The caller decides what to
   * do with a failure and shows the reason.
   */
  async parse(text: string): Promise<{ data: ResumeData | null; warning: string | null }> {
    if (this.missingCredential) {
      return {
        data: null,
        warning: `${this.apiKeyEnv} is not set, so the resume was saved as text but not parsed into fields.`,
      };
    }
    if (!text.trim()) return { data: null, warning: 'The resume had no readable text.' };

    try {
      const result = await this.chat.complete<unknown>({
        system: SYSTEM,
        prompt:
          `## Resume\n${clipResume(text)}\n\n` +
          `Respond with JSON matching this schema and nothing else:\n${JSON.stringify(RESUME_RESPONSE_SCHEMA)}`,
        schema: RESUME_RESPONSE_SCHEMA,
        schemaName: 'ResumeData',
        temperature: 0.1,
        maxTokens: MAX_TOKENS,
      });

      // A content_filter refusal is an empty body with a finish reason, so the
      // layer reports it separately from "the model said nothing useful".
      if (result.finishReason === 'content_filter') {
        return { data: null, warning: 'The provider refused to parse this resume.' };
      }
      if (!result.data) {
        return { data: null, warning: `The model returned no JSON: ${clip(result.text, 120)}` };
      }

      const parsed = ResumeDataSchema.safeParse(result.data);
      if (!parsed.success) {
        this.log.warn(`Unusable resume shape: ${parsed.error.message}`);
        return { data: null, warning: 'The model returned a resume in an unexpected shape.' };
      }

      return { data: parsed.data, warning: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`Resume parsing failed: ${message}`);
      return { data: null, warning: `Resume parsing failed: ${message}` };
    }
  }
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
