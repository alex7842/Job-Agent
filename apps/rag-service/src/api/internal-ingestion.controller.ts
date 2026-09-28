import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { IngestDocumentsResult, IngestJobsResult } from '@job-agent/shared';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { InternalGuard } from './internal.guard.js';
import { ingestDocumentSchema, ingestJobsSchema } from './internal.schemas.js';

/**
 * Write path: triggers indexing and removes vectors. Split from the search
 * controller because indexing and retrieval have different callers, different
 * timeouts and different failure modes.
 */
@Controller('internal')
@UseGuards(InternalGuard)
export class InternalIngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  @Post('documents/ingest')
  async ingestDocument(@Body() body: unknown): Promise<IngestDocumentsResult> {
    const parsed = ingestDocumentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    return this.ingestion.ingestDocument(parsed.data.documentId);
  }

  @Post('documents/delete')
  async deleteDocument(@Body() body: unknown): Promise<{ deleted: boolean }> {
    const parsed = ingestDocumentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const { documentId, profileId } = parsed.data;
    return { deleted: await this.ingestion.deleteDocument(documentId, profileId) };
  }

  @Post('jobs/ingest')
  async ingestJobs(@Body() body: unknown): Promise<IngestJobsResult> {
    const parsed = ingestJobsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const { profileId, userId, jobs } = parsed.data;
    return this.ingestion.ingestJobs(profileId, userId, jobs);
  }
}
