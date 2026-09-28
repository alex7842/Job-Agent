import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { internalToken } from '@job-agent/shared/internal-auth';
import { InternalGuard } from './internal.guard.js';

const SECRET = 'a'.repeat(48);
const config = (secret: string | undefined) =>
  ({
    get: (key: string) => (key === 'RAG_INTERNAL_SECRET' ? secret : undefined),
  }) as unknown as ConfigService;

describe('InternalGuard', () => {
  it('refuses to be constructed without a secret', () => {
    // Fail closed: a service that came up with an empty secret would serve the
    // internal routes to anything that can reach the port.
    expect(() => new InternalGuard(config(undefined))).toThrow(/RAG_INTERNAL_SECRET/);
    expect(() => new InternalGuard(config(''))).toThrow(/RAG_INTERNAL_SECRET/);
  });

  it('refuses a secret that is too short to be meaningful', () => {
    expect(() => new InternalGuard(config('short'))).toThrow(/at least 32/);
  });

  it('accepts a token signed for the same method and path', () => {
    const guard = new InternalGuard(config(SECRET));
    const token = internalToken(SECRET, 'post', '/internal/search');
    expect(guard.verify(token, 'POST', '/internal/search')).toBe(true);
  });

  it('is case-insensitive about the HTTP method, as express is', () => {
    const guard = new InternalGuard(config(SECRET));
    const token = internalToken(SECRET, 'post', '/internal/search');
    expect(guard.verify(token, 'POST', '/internal/search')).toBe(true);
  });

  it('rejects a token signed with the wrong secret', () => {
    const guard = new InternalGuard(config(SECRET));
    const forged = internalToken('b'.repeat(48), 'POST', '/internal/search');
    expect(guard.verify(forged, 'POST', '/internal/search')).toBe(false);
  });

  it('rejects a token signed for a different path', () => {
    // This is what stops a token minted for a harmless route being replayed
    // against document ingestion.
    const guard = new InternalGuard(config(SECRET));
    const token = internalToken(SECRET, 'POST', '/internal/health');
    expect(guard.verify(token, 'POST', '/internal/search')).toBe(false);
  });

  it('rejects a token signed for a different method', () => {
    const guard = new InternalGuard(config(SECRET));
    const token = internalToken(SECRET, 'GET', '/internal/search');
    expect(guard.verify(token, 'POST', '/internal/search')).toBe(false);
  });

  it('rejects a token of the wrong length without throwing', () => {
    // timingSafeEqual throws on a length mismatch, so the guard must compare
    // lengths first or a malformed header becomes a 500 instead of a 401.
    const guard = new InternalGuard(config(SECRET));
    expect(() => guard.verify('short', 'POST', '/internal/search')).not.toThrow();
    expect(guard.verify('short', 'POST', '/internal/search')).toBe(false);
    expect(guard.verify('', 'POST', '/internal/search')).toBe(false);
    expect(guard.verify('x'.repeat(500), 'POST', '/internal/search')).toBe(false);
  });
});
