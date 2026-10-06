import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job } from '../jobs/entities/job.entity.js';
import { SearchRun } from '../jobs/entities/search-run.entity.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { OutboxEvent } from '../outbox/entities/outbox-event.entity.js';
import { Profile } from '../profile/profile.entity.js';
import { ProfileModule } from '../profile/profile.module.js';
import { User } from '../auth/user.entity.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

/**
 * Cross-profile reads. Repositories are requested here rather than through
 * JobsService because every query in this module is deliberately unscoped: the
 * dashboard answers "how is the whole system doing", which JobsService — whose
 * methods all take a profileId — cannot answer by construction.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Job, SearchRun, OutboxEvent, User, Profile]),
    JobsModule,
    ProfileModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
