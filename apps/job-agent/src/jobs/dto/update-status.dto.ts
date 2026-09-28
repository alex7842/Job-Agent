import { IsEnum } from 'class-validator';
import { JobStatus } from '@job-agent/shared';

export class UpdateStatusDto {
  @IsEnum(JobStatus) status: JobStatus;
}
