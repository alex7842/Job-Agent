import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../entities/job.entity.js';
import type { Profile } from '../../profile/profile.entity.js';
import { ScorerService } from './scorer.service.js';

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

/** Defaults to the OpenRouter key, since that is what .env sets. */
function svc(env: Record<string, string | undefined> = {}) {
  return new ScorerService(
    new ConfigService({ OPENROUTER_API_KEY: 'key-123', ...env }) as unknown as ConfigService,
  );
}

/** A chat completion the way a schema-constrained provider answers. */
function answer(text: string, finishReason = 'stop') {
  return {
    ok: true,
    json: async () => ({ choices: [{ finish_reason: finishReason, message: { content: text } }] }),
  } as unknown as Response;
}

describe('ScorerService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('asks for schema-constrained JSON on the configured provider and rounds the score', async () => {
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
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer key-123');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('nvidia/nemotron-3-super-120b-a12b:free');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema.required).toContain('score');
    // A reasoning model will happily answer "0.95" for a 0-100 score, which
    // passes a loose range check and then rounds down to 1. The schema is what
    // stops it, so assert the constraint is actually sent.
    expect(body.response_format.json_schema.schema.properties.score).toMatchObject({
      type: 'integer',
      minimum: 0,
      maximum: 100,
    });
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: expect.stringContaining('job-matching assistant'),
    });
    expect(body.messages[1].content).toContain('Backend Engineer');
  });

  it('sends OpenRouter attribution headers, which it asks for on every request', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(answer('{"score":50,"reason":"ok","highlights":[],"redFlags":[]}'));

    await svc().score(job, profile);

    const headers = fetchMock.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers['X-Title']).toBe('job-agent');
    expect(headers['HTTP-Referer']).toBe('https://github.com/job-agent');
  });

  it('switches provider and endpoint from SCORING_PROVIDER alone', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(answer('{"score":10,"reason":"no","highlights":[],"redFlags":[]}'));

    await svc({ SCORING_PROVIDER: 'mistral', MISTRAL_API_KEY: 'mi-key' }).score(job, profile);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer mi-key');
    expect(JSON.parse(init.body as string).model).toBe('mistral-small-latest');
  });

  it('honours SCORING_MODEL, and treats a blank value as unset', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(answer('{"score":10,"reason":"no","highlights":[],"redFlags":[]}'));

    await svc({ SCORING_MODEL: 'qwen/qwen3-235b-a22b' }).score(job, profile);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).model).toBe(
      'qwen/qwen3-235b-a22b',
    );

    // `.env` ships SCORING_MODEL= so the provider default can be picked up;
    // an empty string must not win over it.
    await svc({ SCORING_MODEL: '' }).score(job, profile);
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string).model).toBe(
      'nvidia/nemotron-3-super-120b-a12b:free',
    );
  });

  it('does not hand the OpenRouter key to another provider', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    // Only OPENROUTER_API_KEY is set, so Mistral must still report its own
    // missing key rather than being handed a credential it cannot use.
    await expect(
      svc({ SCORING_PROVIDER: 'mistral', MISTRAL_API_KEY: '' }).score(job, profile),
    ).rejects.toThrow(/MISTRAL_API_KEY is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails with a setup message when no key is configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const s = new ScorerService(
      new ConfigService({ SCORING_PROVIDER: 'openrouter' }) as unknown as ConfigService,
    );

    await expect(s.score(job, profile)).rejects.toThrow(
      /OPENROUTER_API_KEY is not set.*openrouter.ai\/keys/s,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries a rate-limited free endpoint instead of failing the row', async () => {
    // OpenRouter's ":free" models return 429 while upstream is throttling,
    // which is routine rather than fatal, so the layer backs off and retries.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '0' }),
        text: async () => 'rate limited',
      } as unknown as Response)
      .mockResolvedValue(answer('{"score":77,"reason":"ok","highlights":[],"redFlags":[]}'));

    // retry-after: 0 keeps the backoff instant so the test does not sleep.
    const result = await svc().score(job, profile);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(result.score).toBe(77);
  }, 10_000);

  it('surfaces the status when the provider rejects the call', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'no credits',
    } as unknown as Response);

    await expect(svc().score(job, profile)).rejects.toThrow(/401 no credits/);
  });

  it('reports a blocked prompt instead of a parse error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('', 'content_filter'));

    await expect(svc().score(job, profile)).rejects.toThrow(/content_filter/);
  });

  it('rejects an answer truncated before the closing brace', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('{"score":72,"reason":"good', 'length'));

    await expect(svc().score(job, profile)).rejects.toThrow(/returned no JSON/);
  });

  it('recovers a score the model ran out of tokens to finish', async () => {
    // The reported failure: OpenRouter's :free default is a reasoning model, and
    // its thinking tokens come out of max_tokens before the answer starts, so the
    // reply came back cut off mid-reason and zod rejected the whole row.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        answer('{"score": 55, "reason": "Strong skill and location match, but salary', 'length'),
      )
      .mockResolvedValue(answer('{"score":55,"reason":"ok","highlights":[],"redFlags":[]}'));

    const result = await svc().score(job, profile);

    expect(result.score).toBe(55);
    // The retry asks for more room rather than repeating the same request.
    const retry = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).max_tokens).toBe(2048);
    expect(retry.max_tokens).toBeGreaterThan(2048);
  });

  it('names the token limit when even the larger retry comes back truncated', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('{"score":72,"reason":"good', 'length'));

    // "no JSON" alone reads like a parsing bug; the budget is what actually ran out.
    await expect(svc().score(job, profile)).rejects.toThrow(
      /returned no JSON.*output-token limit.*reason/s,
    );
  });

  it('rejects a score outside 0-100 rather than storing it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('{"score":140,"reason":"x"}'));

    await expect(svc().score(job, profile)).rejects.toThrow(/unusable shape/);
  });

  it('rejects prose with no JSON at all', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('I cannot help with that.'));

    await expect(svc().score(job, profile)).rejects.toThrow(/returned no JSON/);
  });

  it('scores a profile whose preferences jsonb is missing every array', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(answer('{"score":61,"reason":"ok","highlights":[],"redFlags":[]}'));

    // preferences is a jsonb column, so a row written before a field existed
    // has no `roles` at all. Reading .join off that throws and the score is
    // lost, which is how five rows ended up with "reading 'map'" on them.
    const partial = { ...profile, preferences: { postedWithinDays: 7 } } as unknown as Profile;
    const result = await svc().score(job, partial);

    expect(result.score).toBe(61);
    const sent = JSON.parse(fetchMock.mock.calls[0][1]!.body as string).messages[1].content;
    expect(sent).toContain('Roles: any');
    expect(sent).toContain('Locations: any');
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
