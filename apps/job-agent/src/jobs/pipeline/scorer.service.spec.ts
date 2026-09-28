import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../entities/job.entity.js';
import type { Profile } from '../../profile/profile.entity.js';
import { DEFAULT_SCORING_MODEL, ScorerService } from './scorer.service.js';

const profile = {
  id: 'p1',
  resumeText: 'Senior backend engineer with Node.js and Kafka experience.',
  preferences: {
    roles: ['backend engineer'],
    skills: ['nestjs'],
    locations: ['berlin'],
    remoteOnly: true,
    minSalary: 90000,
  },
} as unknown as Profile;

const job = {
  id: 'j1',
  title: 'Backend Engineer',
  company: 'Acme',
  location: 'Berlin',
  remote: true,
  salaryText: '100k',
  description: 'Build distributed services.',
} as unknown as Job;

function svc(env: Record<string, string | undefined> = {}) {
  return new ScorerService(
    new ConfigService({ GEMINI_API_KEY: 'key-123', ...env }) as unknown as ConfigService,
  );
}

/** A generateContent body the way Gemini answers a schema-constrained call. */
function answer(text: string) {
  return {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  } as unknown as Response;
}

describe('ScorerService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('asks Gemini for schema-constrained JSON and returns a rounded score', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      answer(
        JSON.stringify({
          score: 87.4,
          reason: 'Strong match',
          highlights: ['Kafka', 'Node.js'],
          redFlags: ['onsite sometimes'],
        }),
      ),
    );

    const result = await svc().score(job, profile);

    expect(result).toEqual({
      score: 87,
      reason: 'Strong match',
      highlights: ['Kafka', 'Node.js'],
      redFlags: ['onsite sometimes'],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_SCORING_MODEL}:generateContent`,
    );
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('key-123');
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema.required).toContain('score');
    expect(body.contents[0].parts[0].text).toContain('Backend Engineer');
    expect(body.systemInstruction.parts[0].text).toContain('job-matching assistant');
  });

  it('honours GEMINI_SCORING_MODEL', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(answer('{"score":10,"reason":"no","highlights":[],"redFlags":[]}'));

    await svc({ GEMINI_SCORING_MODEL: 'gemini-3.8-flash' }).score(job, profile);

    expect(fetchMock.mock.calls[0][0]).toContain('models/gemini-3.8-flash:generateContent');
  });

  it('drops thinking parts and keeps the answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                { text: 'the candidate has Kafka', thought: true },
                { text: '{"score":72,"reason":"good","highlights":[],"redFlags":[]}' },
              ],
            },
          },
        ],
      }),
    } as unknown as Response);

    expect((await svc().score(job, profile)).score).toBe(72);
  });

  it('fails with a setup message when no key is configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const s = new ScorerService(new ConfigService({}) as unknown as ConfigService);

    await expect(s.score(job, profile)).rejects.toThrow(/GEMINI_API_KEY is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the status when Gemini rejects the call', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'quota exceeded',
    } as unknown as Response);

    await expect(svc().score(job, profile)).rejects.toThrow(/429 quota exceeded/);
  });

  it('reports a blocked prompt instead of a parse error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }),
    } as unknown as Response);

    await expect(svc().score(job, profile)).rejects.toThrow(/refused the request: SAFETY/);
  });

  it('rejects a score outside 0-100 rather than storing it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('{"score":140,"reason":"x"}'));

    await expect(svc().score(job, profile)).rejects.toThrow(/unusable shape/);
  });

  it('rejects prose with no JSON at all', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('I cannot help with that.'));

    await expect(svc().score(job, profile)).rejects.toThrow(/returned no JSON/);
  });

  it('truncates an overlong reason and caps the lists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      answer(
        JSON.stringify({
          score: 50,
          reason: 'r'.repeat(500),
          highlights: ['a', 'b', 'c', 'd'],
          redFlags: ['e', 'f', 'g', 'h'],
        }),
      ),
    );

    const result = await svc().score(job, profile);
    expect(result.reason).toHaveLength(300);
    expect(result.highlights).toHaveLength(3);
    expect(result.redFlags).toHaveLength(3);
  });
});
