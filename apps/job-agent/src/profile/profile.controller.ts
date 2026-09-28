import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { CurrentUser, type AuthPrincipal } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { UpdateProfileDto } from './profile.dto.js';
import { ProfileService } from './profile.service.js';

@Controller('profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Get()
  get(@CurrentUser() user: AuthPrincipal) {
    return this.profiles.getById(user.profileId);
  }

  @Put()
  update(@CurrentUser() user: AuthPrincipal, @Body() dto: UpdateProfileDto) {
    return this.profiles.update(user.profileId, dto);
  }
}
