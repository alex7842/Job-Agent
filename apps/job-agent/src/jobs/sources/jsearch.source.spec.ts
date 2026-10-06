import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Profile } from '../../profile/profile.entity.js';
import { AdzunaSource } from './adzuna.source.js';
import { JSearchSource } from './jsearch.source.js';

const profile = {
  id: 'p1',
  preferences: {
    // Two roles so searchQueries issues two requests: the point of the first
    // test is that a later 403 does not discard an earlier page of results.
    roles: ['backend engineer', 'platform engineer'],
    locations: ['bengaluru'],
    remoteOnly: false,
    postedWithinDays: 7,
    sources: [],
    greenhouseBoards: [],
  },
} as unknown as Profile;

const job = {
  data: [
    {
      job_id: '1',
      job_title: 'Backend Engineer',
      employer_name: 'Acme',
      job_city: 'Bengaluru',
      job_apply_link: 'https://apply',
    },
  ],
};

function svc(key = 'rapid-key') {
  return new JSearchSource(new ConfigService({ RAPIDAPI_KEY: key }) as unknown as ConfigService);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('credential-gated job sources', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('queries the search endpoint, not the salary estimator', async () => {
    // /estimated-salary takes job_title + location for one named role, so a
    // search query against it comes back 400 "Missing job_title parameter" on
    // every attempt, and Temporal retried that until the run gave up.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json(job)));
    vi.stubGlobal('fetch', fetchMock);

    await svc().fetch(profile);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(new URL(url).pathname).toBe('/search');
    expect(new URL(url).searchParams.get('query')).toBe('backend engineer in bengaluru');
  });

  it('disables itself on a 403 and still returns what earlier queries found', async () => {
    // RapidAPI answers "You are not subscribed to this API" to a key that is
    // valid but not subscribed to JSearch. Retrying that is pointless, and
    // propagating it failed the whole workflow.
    // A fresh Response per call: a body can only be read once.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => Promise.resolve(json(job)))
        .mockImplementationOnce(() =>
          Promise.resolve(json({ message: 'You are not subscribed to this API.' }, 403)),
        ),
    );

    const source = svc();
    const found = await source.fetch(profile);

    expect(found).toHaveLength(1);
    expect(source.isEnabled()).toBe(false);
  });

  it('reports the provider reason and where to fix it', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: 'not subscribed' }, 403)));

    await svc().fetch(profile);

    // The message has to carry the provider's own wording, since "403" alone
    // does not distinguish a bad key from an unsubscribed one.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not subscribed'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rapidapi.com'));
  });

  it('keeps propagating a rate limit, which is transient and worth retrying', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('slow down', { status: 429 })));

    const source = svc();
    await expect(source.fetch(profile)).rejects.toThrow(/429/);
    // Still enabled: the credential is fine, the provider is just busy.
    expect(source.isEnabled()).toBe(true);
  });

  it('does not disable on a server error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 503 })));

    const source = svc();
    await expect(source.fetch(profile)).rejects.toThrow(/503/);
    expect(source.isEnabled()).toBe(true);
  });

  it('sends the key as a header, so it cannot leak into logs', async () => {
    // A fresh Response per call: a body can only be read once.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json(job)));
    vi.stubGlobal('fetch', fetchMock);

    await svc().fetch(profile);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('rapid-key');
    expect((init.headers as Record<string, string>)['X-RapidAPI-Key']).toBe('rapid-key');
  });

  it('disables adzuna on a rejected credential too', async () => {
    const source = new AdzunaSource(
      new ConfigService({ ADZUNA_APP_ID: 'id', ADZUNA_APP_KEY: 'key' }) as unknown as ConfigService,
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 })));

    expect(await source.fetch(profile)).toEqual([]);
    expect(source.isEnabled()).toBe(false);
  });
});
