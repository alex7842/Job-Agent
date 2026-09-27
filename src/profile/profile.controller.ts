import { Body, Controller, Get, Put } from '@nestjs/common';
import { UpdateProfileDto } from './profile.dto.js';
import { ProfileService } from './profile.service.js';

@Controller('profile')
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Get() get() {
    return this.profiles.getOrCreate();
  }

  @Put() update(@Body() dto: UpdateProfileDto) {
    return this.profiles.update(dto);
  }
}
