import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';
import { AdminGuard, isAdmin } from './admin.guard.js';

/**
 * The allowlist is the only thing standing between a normal account and every
 * job, run and profile in the deployment, so the tests are about the negative
 * case: a signed-in non-admin must be refused, and a blank list must refuse
 * everyone.
 */
const SECRET = 'test-secret';

/**
 * A real signed token rather than a faked `req.user`: AdminGuard verifies the
 * JWT itself before it checks the allowlist, so a stubbed principal would test
 * only the second half of the check — and would pass even if the guard skipped
 * verification entirely.
 */
function contextFor(email: string): ExecutionContext {
  const jwt = new JwtService({ secret: SECRET });
  const accessToken = jwt.sign({ sub: 'u1', email, pid: 'p1', typ: 'access' }, { expiresIn: 900 });
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: `Bearer ${accessToken}` } }),
    }),
  } as unknown as ExecutionContext;
}

const guardFor = (admins: string) =>
  new AdminGuard(
    new JwtService({ secret: SECRET }) as never,
    new ConfigService({ ADMIN_EMAILS: admins }),
  );

describe('isAdmin', () => {
  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const config = new ConfigService({
      ADMIN_EMAILS: ' alex@softkeatech.io , ops@softkeatech.io ',
    });
    expect(isAdmin(config, 'alex@softkeatech.io')).toBe(true);
    expect(isAdmin(config, 'Alex@Softkeatech.io')).toBe(true);
    expect(isAdmin(config, 'ops@softkeatech.io')).toBe(true);
    expect(isAdmin(config, 'someone@else.com')).toBe(false);
  });

  it('denies everyone when the list is unset or blank', () => {
    expect(isAdmin(new ConfigService({}), 'alex@softkeatech.io')).toBe(false);
    expect(isAdmin(new ConfigService({ ADMIN_EMAILS: '' }), 'alex@softkeatech.io')).toBe(false);
    expect(isAdmin(new ConfigService({ ADMIN_EMAILS: ' , ' }), 'alex@softkeatech.io')).toBe(false);
  });

  it('does not treat a substring as a match', () => {
    const config = new ConfigService({ ADMIN_EMAILS: 'alex@softkeatech.io' });
    // Otherwise "notalex@softkeatech.io" would inherit admin.
    expect(isAdmin(config, 'notalex@softkeatech.io')).toBe(false);
    expect(isAdmin(config, 'alex@softkeatech.io.evil.com')).toBe(false);
  });
});

describe('AdminGuard', () => {
  it('refuses a non-admin even with a valid identity', async () => {
    const guard = guardFor('alex@softkeatech.io');
    await expect(guard.canActivate(contextFor('someone@else.com'))).rejects.toThrow(
      /administrators/i,
    );
  });

  it('refuses everyone when no admin is configured', async () => {
    const guard = guardFor('');
    await expect(guard.canActivate(contextFor('alex@softkeatech.io'))).rejects.toThrow();
  });

  it('refuses a request with no token before it ever looks at the allowlist', async () => {
    const guard = guardFor('alex@softkeatech.io');
    const anonymous = {
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
    } as unknown as ExecutionContext;
    // Inherits JwtAuthGuard's rejection, so the allowlist is not a way in.
    await expect(guard.canActivate(anonymous)).rejects.toThrow(/bearer token/i);
  });
});
