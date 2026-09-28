import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, type AuthPrincipal } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { TemporalClientService } from '../temporal/temporal-client.service.js';
import { JobsService } from './jobs.service.js';

@Controller('runs')
@UseGuards(JwtAuthGuard)
export class RunsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly temporal: TemporalClientService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthPrincipal) {
    return this.jobs.listRuns(user.profileId);
  }

  /** "Search now" button -> starts the same workflow the 10 AM schedule runs. */
  @Post()
  trigger(@CurrentUser() user: AuthPrincipal) {
    return this.temporal.startRun(user.profileId);
  }
}
