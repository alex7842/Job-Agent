import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { Repository, IsNull } from 'typeorm';
import type { AuthUser, RegisterInput, TokenPair } from '@job-agent/shared';
import { ProfileService } from '../profile/profile.service.js';
import { PasswordService } from './password.service.js';
import { RefreshToken } from './refresh-token.entity.js';
import { User } from './user.entity.js';
import {
  ACCESS_TTL,
  REFRESH_TTL,
  ttlSeconds,
  type AccessPayload,
  type RefreshPayload,
} from './auth.types.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(RefreshToken) private readonly tokens: Repository<RefreshToken>,
    private readonly profiles: ProfileService,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
  ) {}

  async register({ email, password, name }: RegisterInput): Promise<TokenPair> {
    const normalized = email.trim().toLowerCase();
    if (await this.users.findOneBy({ email: normalized })) {
      throw new ConflictException('That email is already registered');
    }

    const user = await this.users.save(
      this.users.create({ email: normalized, passwordHash: await this.passwords.hash(password) }),
    );
    // A profile is the unit of data isolation, so it is created up front rather
    // than lazily on the first /profile call.
    const profile = await this.profiles.forUser(user.id);
    if (name) await this.profiles.update(profile.id, { name });

    this.logger.log(`Registered ${user.email}`);
    return this.issue(user, profile.id);
  }

  async login({ email, password }: { email: string; password: string }): Promise<TokenPair> {
    const user = await this.users.findOneBy({ email: email.trim().toLowerCase() });

    // Same error and roughly the same work either way, so the response does not
    // reveal whether an email is registered.
    const ok = user ? await this.passwords.verify(password, user.passwordHash) : false;
    if (!user || !ok) throw new UnauthorizedException('Incorrect email or password');

    const profile = await this.profiles.forUser(user.id);
    return this.issue(user, profile.id);
  }

  /** Rotation: the presented token is revoked and replaced by a fresh pair. */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const row = await this.tokens.findOneBy({ tokenHash: sha256(refreshToken) });

    let payload: RefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // No row means we never issued it, so there is no user to hold responsible.
    if (!row) throw new UnauthorizedException('Refresh token is no longer valid');

    // Everything below means the token verified but is not in a usable state.
    // A live row that was already consumed is the signature of a stolen token
    // being replayed, so per the OAuth security BCP the whole family is dropped
    // rather than just refusing this one call. The cost is that a genuine double
    // refresh (two tabs racing) signs the user out; tokens are per-tab here, so
    // that is not a flow we have, and a forced re-login beats a stolen session.
    if (row.revokedAt || row.expiresAt.getTime() < Date.now()) {
      await this.revokeAll(row.userId);
      throw new UnauthorizedException('Refresh token is no longer valid');
    }
    if (payload.jti !== row.id || payload.sub !== row.userId) {
      await this.revokeAll(row.userId);
      throw new UnauthorizedException('Refresh token mismatch');
    }

    const user = await this.users.findOneBy({ id: payload.sub });
    if (!user) throw new UnauthorizedException('Account no longer exists');

    await this.tokens.update(row.id, { revokedAt: new Date() });
    return this.issue(user, (await this.profiles.forUser(user.id)).id);
  }

  async logout(refreshToken: string): Promise<void> {
    // Idempotent: logging out twice, or with a junk token, is not an error.
    await this.tokens.update({ tokenHash: sha256(refreshToken) }, { revokedAt: new Date() });
  }

  async me(userId: string): Promise<AuthUser> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new UnauthorizedException('Account no longer exists');
    const profile = await this.profiles.forUser(user.id);
    return {
      id: user.id,
      email: user.email,
      profileId: profile.id,
      createdAt: user.createdAt.toISOString(),
    };
  }

  private async issue(user: User, profileId: string): Promise<TokenPair> {
    // Lifetimes are passed in seconds, which jsonwebtoken reads unambiguously and
    // which keeps the JWT `exp` and the refresh_tokens.expiresAt in agreement.
    const accessExpiresIn = ttlSeconds(ACCESS_TTL);
    const refreshExpiresIn = ttlSeconds(REFRESH_TTL);

    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, pid: profileId, typ: 'access' } satisfies AccessPayload,
      { expiresIn: accessExpiresIn },
    );

    const jti = randomUUID();
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, jti, typ: 'refresh' } satisfies RefreshPayload,
      { expiresIn: refreshExpiresIn },
    );

    await this.tokens.save(
      this.tokens.create({
        id: jti,
        userId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + refreshExpiresIn * 1000),
      }),
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: accessExpiresIn,
      user: {
        id: user.id,
        email: user.email,
        profileId,
        createdAt: user.createdAt.toISOString(),
      },
    };
  }

  private async revokeAll(userId: string): Promise<void> {
    await this.tokens.update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }
}
