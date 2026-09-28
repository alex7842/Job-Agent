import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The shared secret between the job agent and the RAG service's /internal
 * routes.
 *
 * Both sides import from here so the wire format cannot drift: a client that
 * signs a different string than the guard verifies fails at runtime only, and
 * only in a deployment.
 *
 * The path is signed along with the method so a token minted for one route
 * cannot be replayed against another, and the path is taken without its query
 * string so a parameterised request does not need a second token.
 */
export const internalToken = (secret: string, method: string, path: string): string =>
  createHmac('sha256', secret)
    .update(`${method.toUpperCase()}:${stripQuery(path)}`)
    .digest('hex');

/** Constant-time comparison; false for any length mismatch. */
export const verifyInternalToken = (
  secret: string,
  token: string,
  method: string,
  path: string,
): boolean => {
  const expected = internalToken(secret, method, path);
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  return a.length === b.length && timingSafeEqual(a, b);
};

const stripQuery = (path: string): string => path.split('?')[0];

/** The header the token travels in. */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/** Below this the secret is not a secret. */
export const MIN_INTERNAL_SECRET_LENGTH = 32;
