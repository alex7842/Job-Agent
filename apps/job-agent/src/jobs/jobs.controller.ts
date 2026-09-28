import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TOPICS, type NewJobEvent } from '@job-agent/shared';
import { CurrentUser, type AuthPrincipal } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { KafkaProducerService } from '../kafka/kafka-producer.service.js';
import { QueryJobsDto } from './dto/query-jobs.dto.js';
import { UpdateStatusDto } from './dto/update-status.dto.js';
import { JobsService } from './jobs.service.js';

@Controller('jobs')
@UseGuards(JwtAuthGuard)
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly producer: KafkaProducerService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthPrincipal, @Query() q: QueryJobsDto) {
    return this.jobs.list(user.profileId, q);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.getOwnedById(id, user.profileId);
  }

  /** Mark as saved / applied / ignored (the dashboard's review actions). */
  @Patch(':id/status')
  updateStatus(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStatusDto,
  ) {
    return this.jobs.updateStatus(id, user.profileId, dto.status);
  }

  /** Re-run AI scoring, e.g. after editing the resume / preferences. */
  @Post(':id/rescore')
  async rescore(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    // getOwnedById first, so another user's job 404s instead of emitting an event.
    const job = await this.jobs.getOwnedById(id, user.profileId);
    await this.jobs.resetScore(id);
    const evt: NewJobEvent = { jobId: id, profileId: job.profileId };
    await this.producer.emit(TOPICS.NEW, job.profileId, evt);
    return { queued: true };
  }
}
