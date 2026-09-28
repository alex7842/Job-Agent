import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KafkaModule } from '../kafka/kafka.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { TemporalModule } from '../temporal/temporal.module.js';
import { Job } from './entities/job.entity.js';
import { SearchRun } from './entities/search-run.entity.js';
import { JobPipelineController } from './pipeline/job-pipeline.controller.js';
import { ScorerService } from './pipeline/scorer.service.js';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';
import { RunsController } from './runs.controller.js';
import { AdzunaSource } from './sources/adzuna.source.js';
import { GreenhouseSource } from './sources/greenhouse.source.js';
import { JSearchSource } from './sources/jsearch.source.js';
import { RemotiveSource } from './sources/remotive.source.js';
import { SourcesRegistry } from './sources/sources.registry.js';

@Module({
  imports: [TypeOrmModule.forFeature([Job, SearchRun]), KafkaModule, ProfileModule, TemporalModule],
  controllers: [JobsController, RunsController, JobPipelineController],
  providers: [
    JobsService,
    ScorerService,
    SourcesRegistry,
    JSearchSource,
    AdzunaSource,
    RemotiveSource,
    GreenhouseSource,
  ],
  exports: [JobsService, SourcesRegistry],
})
export class JobsModule {}
