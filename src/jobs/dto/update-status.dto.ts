import { IsEnum } from 'class-validator';
import { JobStatus } from '../entities/job.entity.js';

export class UpdateStatusDto {
  @IsEnum(JobStatus) status: JobStatus;
}
