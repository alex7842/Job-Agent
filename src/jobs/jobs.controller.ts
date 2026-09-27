import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { TOPICS } from '../common/constants.js';
import { NewJobEvent } from '../common/types.js';
import { KafkaProducerService } from '../kafka/kafka-producer.service.js';
import { ProfileService } from '../profile/profile.service.js';
import { QueryJobsDto } from './dto/query-jobs.dto.js';
import { UpdateStatusDto } from './dto/update-status.dto.js';
import { JobsService } from './jobs.service.js';

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly profiles: ProfileService,
    private readonly producer: KafkaProducerService,
  ) {}

  @Get()
  async list(@Query() q: QueryJobsDto) {
    const profile = await this.profiles.getOrCreate();
    return this.jobs.list(profile.id, q);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.getById(id);
  }

  /** Mark as saved / applied / ignored (the dashboard's review actions). */
  @Patch(':id/status')
  updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStatusDto) {
    return this.jobs.updateStatus(id, dto.status);
  }

  /** Re-run AI scoring, e.g. after editing the resume / preferences. */
  @Post(':id/rescore')
  async rescore(@Param('id', ParseUUIDPipe) id: string) {
    const job = await this.jobs.getById(id);
    await this.jobs.resetScore(id);
    const evt: NewJobEvent = { jobId: id, profileId: job.profileId };
    await this.producer.emit(TOPICS.NEW, job.profileId, evt);
    return { queued: true };
  }
}
