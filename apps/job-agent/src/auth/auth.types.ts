import type { JwtSignOptions } from '@nestjs/jwt';

/**
 * Access tokens are short-lived and stateless; refresh tokens are long-lived and
 * revocable (a row in `refresh_tokens`). Both are signed with the same secret and
 * discriminated by `typ`, so a stolen refresh token cannot be used as a bearer
 * token. Expiries are overridable via JWT_ACCESS_TTL / JWT_REFRESH_TTL.
 */
export const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
export const REFRESH_TTL = process.env.JWT_REFRESH_TTL || '30d';

export type AccessPayload = {
  sub: string;
  email: string;
  /** profileId, so the common path needs no profile lookup. */
  pid: string;
  typ: 'access';
};

export type RefreshPayload = {
  sub: string;
  /** Also the `refresh_tokens.id`; lets rotation revoke exactly this row. */
  jti: string;
  typ: 'refresh';
};

export type SignOptions = JwtSignOptions;

/** `15m` -> 900 seconds, for the client's proactive-refresh window. */
export function ttlSeconds(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) return 900;
  const value = Number(match[1]);
  const unit = { s: 1, m: 60, h: 3600, d: 86_400 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return value * unit;
}
