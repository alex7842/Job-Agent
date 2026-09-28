import { Controller, Get, Post } from '@nestjs/common';
import { ProfileService } from '../profile/profile.service.js';
import { TemporalClientService } from '../temporal/temporal-client.service.js';
import { JobsService } from './jobs.service.js';

@Controller('runs')
export class RunsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly profiles: ProfileService,
    private readonly temporal: TemporalClientService,
  ) {}

  @Get() list() {
    return this.jobs.listRuns();
  }

  /** "Search now" button -> starts the same workflow the 10 AM schedule runs. */
  @Post()
  async trigger() {
    const profile = await this.profiles.getOrCreate();
    return this.temporal.startRun(profile.id);
  }
}
