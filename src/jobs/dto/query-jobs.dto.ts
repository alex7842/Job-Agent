import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { JobStatus } from '../entities/job.entity.js';

export class QueryJobsDto {
  @IsOptional() @IsEnum(JobStatus) status?: JobStatus;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100) minScore?: number;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsIn(['score', 'date']) sort: 'score' | 'date' = 'score';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
}
