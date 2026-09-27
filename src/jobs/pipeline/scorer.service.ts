import Anthropic from '@anthropic-ai/sdk';
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

Respond with ONLY a JSON object, no markdown:
{"score": <integer 0-100>, "reason": "<max 200 chars, why this score>", "highlights": ["<max 3 short strengths>"], "redFlags": ["<max 3 short concerns, e.g. seniority mismatch, missing skill, low pay, onsite-only>"]}`;

@Injectable()
export class ScorerService {
  private readonly client = new Anthropic(); // reads ANTHROPIC_API_KEY
  private readonly model: string;

  constructor(config: ConfigService) {
    this.model = config.get<string>('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001');
  }

  async score(job: Job, profile: Profile): Promise<ScoreResult> {
    const p = profile.preferences;
    const prompt = `## Candidate preferences
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

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error(`Scorer returned no JSON: ${text.slice(0, 120)}`);

    const parsed = ResultSchema.parse(JSON.parse(json));
    return {
      score: Math.round(parsed.score),
      reason: parsed.reason.slice(0, 300),
      highlights: parsed.highlights.slice(0, 3),
      redFlags: parsed.redFlags.slice(0, 3),
    };
  }
}
