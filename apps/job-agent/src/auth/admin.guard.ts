import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AuthPrincipal } from './current-user.decorator.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

/**
 * Admin access is an email allowlist, not a role column.
 *
 * A `users.is_admin` flag would need a migration, a promotion path and an audit
 * trail for something that is decided by configuration here. The allowlist keeps
 * the answer in `.env`, where "who runs this deployment" already lives, and
 * makes the set of admins reviewable in a diff.
 *
 * ADMIN_EMAILS is a comma-separated list. Blank denies everyone rather than
 * allowing everyone: a deployment that forgets to set it must fail closed,
 * since the failure mode of the opposite choice is an open admin API.
 */
export function adminEmails(config: ConfigService): Set<string> {
  return new Set(
    (config.get<string>('ADMIN_EMAILS') ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdmin(config: ConfigService, email: string): boolean {
  return adminEmails(config).has(email.trim().toLowerCase());
}

/**
 * Runs JwtAuthGuard first, then checks the allowlist, so an admin route cannot
 * be reached with a missing or forged token.
 *
 * Extends rather than composes two guards so the order is not left to the
 * caller's `@UseGuards(AdminGuard, JwtAuthGuard)` — which would work, and would
 * be a silent hole the day someone writes it in the other order.
 */
@Injectable()
export class AdminGuard extends JwtAuthGuard {
  private readonly log = new Logger(AdminGuard.name);

  // Typed as JwtService rather than as the super constructor's first parameter:
  // Nest reads the provider token off the *decorated* type, and
  // `ConstructorParameters<typeof JwtAuthGuard>[0]` is a type-only lookup, so
  // emitDecoratorMetadata emits `Object` and the guard fails to instantiate
  // with "can't resolve dependencies of the AdminGuard (?, ConfigService)".
  constructor(
    jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    super(jwt);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!(await super.canActivate(ctx))) return false;

    const req = ctx.switchToHttp().getRequest<{ user?: AuthPrincipal }>();
    const email = req.user?.email ?? '';
    if (!isAdmin(this.config, email)) {
      this.log.warn(`Rejected an admin request from ${email || '(no email)'}`);
      // 403 rather than 404: the caller is authenticated, so pretending the
      // route does not exist would only confuse them about the response.
      throw new ForbiddenException('This area is for administrators.');
    }
    return true;
  }
}
