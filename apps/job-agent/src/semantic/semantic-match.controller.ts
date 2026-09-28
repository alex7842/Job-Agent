import { Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type { SemanticRankResult } from '@job-agent/shared';
import { CurrentUser, type AuthPrincipal } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { JobsService } from '../jobs/jobs.service.js';
import { RagClientService } from '../rag/rag-client.service.js';
import { SemanticMatchService } from './semantic-match.service.js';

/**
 * Manual entry points into semantic ranking, for when the automatic one at the
 * end of a run is not what the user wants: they just uploaded a new resume, or
 * they edited their preferences.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class SemanticMatchController {
  constructor(
    private readonly semantic: SemanticMatchService,
    private readonly jobs: JobsService,
    private readonly rag: RagClientService,
  ) {}

  /** Re-rank one run, e.g. right after its postings finished indexing. */
  @Post('runs/:id/semantic-rank')
  rankRun(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) runId: string,
  ): Promise<SemanticRankResult> {
    // Confirms the run belongs to this profile before ranking anything from it.
    return this.jobs
      .getOwnedRun(runId, user.profileId)
      .then(() => this.semantic.rankRun(runId, user.profileId));
  }

  /** Re-rank everything, for after the resume or the wanted roles changed. */
  @Post('jobs/semantic-rank')
  rankAll(@CurrentUser() user: AuthPrincipal): Promise<SemanticRankResult> {
    return this.semantic.rankAll(user.profileId);
  }

  /** Whether retrieval is configured at all, so the UI can hide the controls. */
  @Get('semantic/status')
  async status() {
    if (!this.rag.enabled) {
      return { enabled: false, degraded: false, embeddingModel: null, vectorStore: null };
    }
    const health = await this.rag.health();
    return {
      enabled: true,
      degraded: health?.degraded === true,
      embeddingModel: (health?.embedding as { provider?: string } | undefined)?.provider ?? null,
      vectorStore: (health?.vectorStore as { name?: string } | undefined)?.name ?? null,
    };
  }
}
