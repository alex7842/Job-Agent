import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthPrincipal } from './current-user.decorator.js';
import type { AccessPayload } from './auth.types.js';

/**
 * Applied per-controller with @UseGuards rather than registered globally on
 * purpose: the Kafka pipeline controller is also a provider in the microservice
 * context, and a global guard would run there with no HTTP request and no
 * Authorization header, failing every job-scoring event.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers?: Record<string, string>; user?: AuthPrincipal }>();
    const header = req.headers?.authorization;

    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');

    let payload: AccessPayload;
    try {
      // Verifies signature + `exp` against the secret registered in AuthModule.
      payload = await this.jwt.verifyAsync<AccessPayload>(header.slice(7));
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // A refresh token must never be usable as an access token.
    if (payload.typ !== 'access') throw new UnauthorizedException('Wrong token type');

    req.user = { id: payload.sub, email: payload.email, profileId: payload.pid };
    return true;
  }
}
