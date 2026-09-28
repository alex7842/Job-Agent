import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { searchRequestSchema, type SearchResponse } from '@job-agent/shared';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { InternalGuard } from './internal.guard.js';

/**
 * Read path. Not browser-facing: the job agent is the only caller and it has
 * already authenticated the user, so the contract carries an explicit
 * profileId/userId instead of re-verifying a JWT here.
 */
@Controller('internal')
@UseGuards(InternalGuard)
export class InternalSearchController {
  constructor(private readonly ingestion: IngestionService) {}

  @Post('search')
  async search(@Body() body: unknown): Promise<SearchResponse> {
    const parsed = searchRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    return this.ingestion.search(parsed.data);
  }
}
