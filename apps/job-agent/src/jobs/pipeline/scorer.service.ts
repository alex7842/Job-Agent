import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
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

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
/**
 * Flash-Lite is the stable, cheap tier and it supports structured output, which
 * this call depends on. Raise it to gemini-3.8-flash for better reasoning at
 * roughly 5x the input price if the scores look shallow.
 */
export const DEFAULT_SCORING_MODEL = 'gemini-3.1-flash-lite';

/** The subset of JSON Schema that Gemini's structured output accepts. */
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    score: { type: 'NUMBER', description: 'Integer 0-100 fit score' },
    reason: { type: 'STRING', description: 'Max 200 characters explaining the score' },
    highlights: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Up to 3 short strengths',
    },
    redFlags: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description:
        'Up to 3 short concerns, e.g. seniority mismatch, missing skill, low pay, onsite-only',
    },
  },
  required: ['score', 'reason', 'highlights', 'redFlags'],
} as const;

interface GenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  promptFeedback?: { blockReason?: string };
}

@Injectable()
export class ScorerService {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: ConfigService) {
    // Resolved at construction but never asserted here: a missing key must not
    // stop the API from booting, it must surface as a scoreError on the rows
    // that needed it, which is what "Rescore" retries.
    this.apiKey =
      config.get<string>('GEMINI_API_KEY') ?? config.get<string>('GOOGLE_API_KEY') ?? '';
    this.model = config.get<string>('GEMINI_SCORING_MODEL') ?? DEFAULT_SCORING_MODEL;
  }

  async score(job: Job, profile: Profile): Promise<ScoreResult> {
    if (!this.apiKey) {
      throw new Error(
        'GEMINI_API_KEY is not set, so nothing can be scored. Get a free key at https://aistudio.google.com/apikey and restart the API.',
      );
    }

    const res = await fetch(`${ENDPOINT}/${this.model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt(job, profile) }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1024,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Gemini scoring failed: ${res.status} ${clip(detail, 300)}`);
    }

    const json = (await res.json()) as GenerateContentResponse;
    if (json.promptFeedback?.blockReason) {
      throw new Error(`Gemini refused the request: ${json.promptFeedback.blockReason}`);
    }

    // Thinking models put their reasoning in `thought` parts first; the answer
    // is the rest. Falls back to a regex because responseMimeType already
    // promises JSON but a truncated response can still arrive as prose.
    const text =
      json.candidates?.[0]?.content?.parts
        ?.filter((p) => !p.thought)
        .map((p) => p.text ?? '')
        .join('') ?? '';
    const payload = text.match(/\{[\s\S]*\}/)?.[0];
    if (!payload) throw new Error(`Gemini returned no JSON: ${clip(text, 120)}`);

    const parsed = ResultSchema.safeParse(JSON.parse(payload));
    if (!parsed.success)
      throw new Error(`Gemini returned an unusable shape: ${parsed.error.message}`);

    return {
      score: Math.round(parsed.data.score),
      reason: parsed.data.reason.slice(0, 300),
      highlights: parsed.data.highlights.slice(0, 3),
      redFlags: parsed.data.redFlags.slice(0, 3),
    };
  }
}

function prompt(job: Job, profile: Profile): string {
  const p = profile.preferences;
  return `## Candidate preferences
Roles: ${p.roles.join(', ') || 'any'}
Skills: ${p.skills.join(', ') || 'n/a'}
Locations: ${p.locations.join(', ') || 'any'}
Remote only: ${p.remoteOnly}
Min salary: ${p.minSalary ?? 'n/a'}

## Resume
${profile.resumeText.slice(0, 8000) || '(not provided)'}

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
