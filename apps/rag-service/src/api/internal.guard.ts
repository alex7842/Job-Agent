import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import {
  INTERNAL_TOKEN_HEADER,
  MIN_INTERNAL_SECRET_LENGTH,
  verifyInternalToken,
} from '@job-agent/shared/internal-auth';

/**
 * Shared-secret guard for the /internal routes.
 *
 * These endpoints are not meant for browsers — the web app never calls them — but
 * leaving them open would let anything that can reach the port enumerate a user's
 * documents or read back their extracted resume text. The caller proves it is the
 * job agent with an HMAC of the method and path, which is per-request rather than
 * a static bearer token.
 */
@Injectable()
export class InternalGuard implements CanActivate {
  private readonly secret: string;

  constructor(config: ConfigService) {
    const secret = config.get<string>('RAG_INTERNAL_SECRET');
    // Fail closed at boot: a service with an empty secret must not serve.
    if (!secret || secret.length < MIN_INTERNAL_SECRET_LENGTH) {
      throw new Error(
        `RAG_INTERNAL_SECRET is required and must be at least ${MIN_INTERNAL_SECRET_LENGTH} characters`,
      );
    }
    this.secret = secret;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = request.header(INTERNAL_TOKEN_HEADER);
    // originalUrl rather than baseUrl + route.path, because the latter depends
    // on how Express happened to join the two.
    const path = request.originalUrl;

    if (!token || !this.verify(token, request.method, path)) {
      throw new UnauthorizedException('Invalid internal credentials');
    }
    return true;
  }

  verify(token: string, method: string, path: string): boolean {
    return verifyInternalToken(this.secret, token, method, path);
  }
}
