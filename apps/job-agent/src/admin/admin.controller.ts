import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminGuard } from '../auth/admin.guard.js';
import { CurrentUser, type AuthPrincipal } from '../auth/current-user.decorator.js';
import { JobsService } from '../jobs/jobs.service.js';
import { RagClientService } from '../rag/rag-client.service.js';
import { ResumeParserService } from '../profile/resume-parser.service.js';
import { ScorerService } from '../jobs/pipeline/scorer.service.js';
import { SourcesRegistry } from '../jobs/sources/sources.registry.js';
import { AdminService } from './admin.service.js';

/**
 * Cross-profile system health, readable only by an address in ADMIN_EMAILS.
 *
 * Every route here is admin-wide on purpose: job and run data belongs to the
 * profile that owns it, and none of it is scoped to the caller here. That is the
 * reason this controller cannot be reused for a user-facing "my activity" view
 * by accident.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly scorer: ScorerService,
    private readonly parser: ResumeParserService,
    private readonly sources: SourcesRegistry,
    private readonly jobs: JobsService,
    private readonly rag: RagClientService,
    private readonly config: ConfigService,
  ) {}

  @Get('overview')
  async overview(@CurrentUser() user: AuthPrincipal) {
    const [system, failures, models, sources] = await Promise.all([
      this.admin.overview(),
      this.admin.scoreFailures(),
      this.models(),
      this.sources.status(),
    ]);

    return {
      viewer: { email: user.email },
      system,
      models,
      sources,
      scoreFailures: failures,
    };
  }

  /**
   * Which model is answering right now, per consumer.
   *
   * The interesting field is `active` on the chain: after a rate limit the
   * primary is parked and the fallback answers, and a dashboard that only showed
   * the configured model would report the wrong thing during exactly the
   * incident it exists to explain.
   */
  private async models() {
    const chain = this.scorer.chainStatus();
    return {
      scoring: {
        configured: this.scorer.chain,
        model: this.scorer.model,
        active: chain?.active ?? {
          provider: this.scorer.chain[0],
          model: this.scorer.model,
        },
        status: chain,
        resumeParsing: { configured: this.parser.chain, model: this.parser.model },
      },
      // Fetched from the RAG service rather than the API's own env, since it is
      // the process that actually holds the embedding model.
      embeddings: await this.embeddingStatus(),
    };
  }

  private async embeddingStatus() {
    if (!this.rag.enabled) {
      return {
        available: false,
        reason: 'RAG service is not configured',
        model: null,
        vectorStore: null,
      };
    }
    try {
      // Best effort: the RAG service being unreachable must not fail the whole
      // overview, because the model and queue numbers are the parts that
      // explain a bad run.
      const health = await this.rag.health();
      return {
        available: true,
        reason: null,
        degraded: health?.degraded === true,
        model: (health?.embedding as { model?: string } | undefined)?.model ?? null,
        vectorStore: (health?.vectorStore as { name?: string } | undefined)?.name ?? null,
      };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        model: null,
        vectorStore: null,
      };
    }
  }
}
