import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentsModule } from '../documents/documents.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { Job } from '../jobs/entities/job.entity.js';
import { ProfileModule } from '../profile/profile.module.js';
import { SemanticMatchController } from './semantic-match.controller.js';
import { SemanticMatchService } from './semantic-match.service.js';

@Module({
  // JobsModule for JobsService, which the ranking writes its scores through.
  imports: [TypeOrmModule.forFeature([Job]), DocumentsModule, ProfileModule, JobsModule],
  controllers: [SemanticMatchController],
  providers: [SemanticMatchService],
  exports: [SemanticMatchService],
})
export class SemanticModule {}
