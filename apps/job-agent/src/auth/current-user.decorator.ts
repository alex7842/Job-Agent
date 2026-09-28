import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** The principal attached by JwtAuthGuard; matches AuthUser on the wire. */
export type AuthPrincipal = {
  id: string;
  email: string;
  profileId: string;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal => {
    const req = ctx.switchToHttp().getRequest<{ user: AuthPrincipal }>();
    return req.user;
  },
);
