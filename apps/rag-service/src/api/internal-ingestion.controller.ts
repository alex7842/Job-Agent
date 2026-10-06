import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { IngestJobsResult } from '@job-agent/shared';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { InternalGuard } from './internal.guard.js';
import { ingestJobsSchema } from './internal.schemas.js';

/**
 * Write path for postings. Split from the search controller because indexing and
 * retrieval have different callers, timeouts and failure modes.
 */
@Controller('internal')
@UseGuards(InternalGuard)
export class InternalIngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  @Post('jobs/ingest')
  async ingestJobs(@Body() body: unknown): Promise<IngestJobsResult> {
    const parsed = ingestJobsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const { profileId, userId, jobs } = parsed.data;
    return this.ingestion.ingestJobs(profileId, userId, jobs);
  }
}
