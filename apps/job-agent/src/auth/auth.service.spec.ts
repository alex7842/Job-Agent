import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Profile } from '../profile/profile.entity.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import type { User } from './user.entity.js';
import type { RefreshToken } from './refresh-token.entity.js';

/**
 * Fakes just enough of TypeORM's Repository to exercise the auth rules. The
 * interesting behaviour (token rotation, reuse detection) lives in AuthService
 * and is all about how it calls these methods, so mocking them is the honest
 * seam — a real Postgres would test TypeORM more than it tests this logic.
 */
class UsersRepo {
  rows: User[] = [];
  async findOneBy(where: Partial<User>) {
    return this.rows.find((r) => r.id === where.id || r.email === where.email) ?? null;
  }
  create(v: Partial<User>) {
    return { id: `u-${this.rows.length + 1}`, createdAt: new Date(), ...v } as User;
  }
  async save(u: User) {
    this.rows.push(u);
    return u;
  }
}

class TokensRepo {
  rows: Array<RefreshToken & { revokedAt: Date | null }> = [];
  async findOneBy(where: { tokenHash: string }) {
    return this.rows.find((r) => r.tokenHash === where.tokenHash) ?? null;
  }
  create(v: Partial<RefreshToken>) {
    return { revokedAt: null, createdAt: new Date(), ...v } as RefreshToken & {
      revokedAt: Date | null;
    };
  }
  async save(t: RefreshToken) {
    this.rows.push(t as RefreshToken & { revokedAt: Date | null });
    return t;
  }
  async update(
    where: string | { id?: string; userId?: string; tokenHash?: string },
    patch: { revokedAt: Date | null },
  ) {
    const matches = (r: RefreshToken & { userId: string }) =>
      typeof where === 'string'
        ? r.id === where
        : (where.id !== undefined && r.id === where.id) ||
          (where.userId !== undefined && r.userId === where.userId) ||
          (where.tokenHash !== undefined && r.tokenHash === where.tokenHash);
    for (const r of this.rows) if (matches(r as never)) r.revokedAt = patch.revokedAt;
  }
}

const profileFor = (userId: string) => ({ id: `p-${userId}`, userId, name: 'Me' }) as Profile;

describe('AuthService', () => {
  let users: UsersRepo;
  let tokens: TokensRepo;
  let profiles: { forUser: (id: string) => Promise<Profile>; update: () => Promise<Profile> };
  let auth: AuthService;

  beforeEach(() => {
    users = new UsersRepo();
    tokens = new TokensRepo();
    profiles = {
      forUser: async (id: string) => profileFor(id),
      update: async () => profileFor('x'),
    };
    auth = new AuthService(
      users as never,
      tokens as never,
      profiles as never,
      new PasswordService(),
      new JwtService({ secret: 'test-secret' }),
    );
  });

  it('registers, and lower-cases the email handle', async () => {
    const pair = await auth.register({
      email: '  Alice@Example.COM ',
      password: 'a-good-password',
    });
    expect(users.rows[0].email).toBe('alice@example.com');
    expect(pair.user.email).toBe('alice@example.com');
    expect(pair.accessToken).toBeTruthy();
    expect(pair.expiresIn).toBeGreaterThan(0);
  });

  it('refuses a duplicate email', async () => {
    await auth.register({ email: 'alice@example.com', password: 'a-good-password' });
    await expect(
      auth.register({ email: 'ALICE@example.com', password: 'a-good-password' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a wrong password and an unknown account identically', async () => {
    await auth.register({ email: 'alice@example.com', password: 'a-good-password' });
    const wrong = await auth
      .login({ email: 'alice@example.com', password: 'nope-nope-nope' })
      .catch((e) => e);
    const unknown = await auth
      .login({ email: 'nobody@example.com', password: 'nope-nope-nope' })
      .catch((e) => e);
    expect(wrong).toBeInstanceOf(UnauthorizedException);
    expect(unknown).toBeInstanceOf(UnauthorizedException);
    // Same message, so the response cannot be used to enumerate accounts.
    expect(wrong.message).toBe(unknown.message);
  });

  it('rotates on refresh, revoking the presented token', async () => {
    const first = await auth.register({ email: 'alice@example.com', password: 'a-good-password' });
    const second = await auth.refresh(first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(tokens.rows[0].revokedAt).not.toBeNull();
    expect(tokens.rows[1].revokedAt).toBeNull();
  });

  it('treats a replayed token as theft and drops the whole family', async () => {
    const first = await auth.register({ email: 'alice@example.com', password: 'a-good-password' });
    const second = await auth.refresh(first.refreshToken);

    await expect(auth.refresh(first.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    // The attacker's replay also killed the victim's live token.
    await expect(auth.refresh(second.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('still allows a fresh login after reuse detection', async () => {
    const first = await auth.register({ email: 'alice@example.com', password: 'a-good-password' });
    await auth.refresh(first.refreshToken);
    await auth.refresh(first.refreshToken).catch(() => undefined);

    const again = await auth.login({ email: 'alice@example.com', password: 'a-good-password' });
    expect(again.accessToken).toBeTruthy();
  });

  it('rejects a token it never issued, and one with a bad signature', async () => {
    await expect(auth.refresh('never-issued')).rejects.toBeInstanceOf(UnauthorizedException);

    const pair = await auth.register({ email: 'alice@example.com', password: 'a-good-password' });
    const tampered = `${pair.refreshToken.slice(0, -3)}xyz`;
    await expect(auth.refresh(tampered)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('logout is idempotent', async () => {
    const pair = await auth.register({ email: 'alice@example.com', password: 'a-good-password' });
    await expect(auth.logout(pair.refreshToken)).resolves.toBeUndefined();
    await expect(auth.logout(pair.refreshToken)).resolves.toBeUndefined();
    await expect(auth.refresh(pair.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('ignores logout for an unknown token', async () => {
    await expect(auth.logout('nonsense')).resolves.toBeUndefined();
  });
});
