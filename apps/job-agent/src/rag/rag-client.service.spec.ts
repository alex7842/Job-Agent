import { describe, expect, it, vi, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { INTERNAL_TOKEN_HEADER, internalToken } from '@job-agent/shared/internal-auth';
import { RagClientService } from './rag-client.service.js';

const SECRET = 's'.repeat(48);
const PROFILE = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

const config = (env: Record<string, string> = {}) =>
  ({
    get: (key: string, fallback?: unknown) => env[key] ?? (fallback as string | undefined),
  }) as unknown as ConfigService;

/** Records the requests a test made without needing a live service. */
function stubFetch(response: unknown = { ok: true }, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(response),
      json: async () => response,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('RagClientService', () => {
  // ---------- configuration ----------

  it('is disabled without a secret, so a missing key cannot half-work', () => {
    // A short or missing secret means there is no call this service could
    // legitimately make; every method would return null anyway.
    expect(new RagClientService(config()).enabled).toBe(false);
    expect(new RagClientService(config({ RAG_INTERNAL_SECRET: 'short' })).enabled).toBe(false);
    expect(new RagClientService(config({ RAG_INTERNAL_SECRET: SECRET })).enabled).toBe(true);
  });

  it('returns null instead of throwing when it is not configured', async () => {
    const client = new RagClientService(config());
    expect(await client.search({ profileId: PROFILE, userId: USER })).toBeNull();
    expect(await client.putResume(PROFILE, 'r.txt', Buffer.from('x'), 'text/plain')).toBeNull();
  });

  // ---------- signing ----------

  it('signs every call with the method and path it actually used', async () => {
    const calls = stubFetch({ ok: true });
    const client = new RagClientService(config({ RAG_INTERNAL_SECRET: SECRET }));

    await client.putResume(PROFILE, 'r.txt', Buffer.from('x'), 'text/plain');

    // The RAG service's guard recomputes HMAC(METHOD:/path); signing anything
    // else — or leaving the query string in — is a 401 in production.
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers[INTERNAL_TOKEN_HEADER]).toBe(internalToken(SECRET, 'POST', '/internal/resumes'));
  });

  it('keeps the query string out of the signed path', async () => {
    const calls = stubFetch({ ok: true });
    const client = new RagClientService(config({ RAG_INTERNAL_SECRET: SECRET }));

    await client.search({ profileId: PROFILE, userId: USER, topK: 5 });

    // A query string in the request would not be part of what the guard signs,
    // and the two sides would disagree about the canonical path.
    expect(calls[0].init.headers).toBeDefined();
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers[INTERNAL_TOKEN_HEADER]).toBe(internalToken(SECRET, 'POST', '/internal/search'));
  });

  // ---------- resume upload ----------

  it('relays the resume bytes with its name and profile as headers', async () => {
    const calls = stubFetch({ objectKey: 'resumes/p/a.txt', text: 'hello', detected: 'text' });
    const client = new RagClientService(config({ RAG_INTERNAL_SECRET: SECRET }));
    const content = Buffer.from('resume bytes');

    await client.putResume(PROFILE, 'my resume.pdf', content, 'application/pdf');

    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].init.method).toBe('POST');
    expect(headers['x-rag-profile-id']).toBe(PROFILE);
    // The file name picks the extractor, so it cannot be percent-encoded into
    // something the sniffer will not recognise.
    expect(decodeURIComponent(headers['x-rag-file-name'])).toBe('my resume.pdf');
    expect(headers['content-type']).toBe('application/pdf');
    expect(headers[INTERNAL_TOKEN_HEADER]).toBe(internalToken(SECRET, 'POST', '/internal/resumes'));
  });

  it('trims trailing slashes from the configured base url', async () => {
    const calls = stubFetch({ ok: true });
    const client = new RagClientService(
      config({ RAG_INTERNAL_SECRET: SECRET, RAG_SERVICE_URL: 'http://rag.internal:3001//' }),
    );

    await client.health();
    expect(calls[0].url).toBe('http://rag.internal:3001/health');
  });

  // ---------- failure handling ----------

  it('returns null on an error response instead of throwing', async () => {
    stubFetch({ message: 'boom' }, 503);
    const client = new RagClientService(config({ RAG_INTERNAL_SECRET: SECRET }));
    // Retrieval is optional: an unavailable search service must not stop the
    // caller from doing its job.
    expect(await client.search({ profileId: PROFILE, userId: USER })).toBeNull();
  });

  it('returns null when the request itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const client = new RagClientService(config({ RAG_INTERNAL_SECRET: SECRET }));
    expect(await client.search({ profileId: PROFILE, userId: USER })).toBeNull();
  });

  it('sends no body on the health probe', async () => {
    const calls = stubFetch({ ok: true });
    const client = new RagClientService(config({ RAG_INTERNAL_SECRET: SECRET }));
    await client.health();
    // fetch rejects a GET with a body.
    expect(calls[0].init.body).toBeUndefined();
  });
});
