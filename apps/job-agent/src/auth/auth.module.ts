import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProfileModule } from '../profile/profile.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AdminGuard } from './admin.guard.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { PasswordService } from './password.service.js';
import { RefreshToken } from './refresh-token.entity.js';
import { User } from './user.entity.js';

/**
 * Fail loudly at boot rather than shipping a default secret: a shared fallback
 * would let anyone mint tokens for any account, and it is exactly the kind of
 * thing that only shows up in production.
 */
const secret = process.env.JWT_SECRET;
if (!secret) {
  throw new Error('JWT_SECRET is not set. Add it to the root .env (see .env.example).');
}

/**
 * Global so JobsModule and ProfileModule can put JwtAuthGuard on their
 * controllers without importing AuthModule, which imports ProfileModule.
 * A plain import would be a cycle; this keeps it one-directional.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([User, RefreshToken]),
    ProfileModule,
    JwtModule.register({ secret }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, JwtAuthGuard, AdminGuard],
  // The guards and JwtService are consumed by Jobs/Profile/Admin modules via
  // @UseGuards; the email allowlist is read by the auth controller so /auth/me
  // can tell the web app whether to show the admin link.
  exports: [AuthService, JwtAuthGuard, AdminGuard, JwtModule],
})
export class AuthModule {}
