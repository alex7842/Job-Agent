import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { IngestionService } from '../ingestion/ingestion.service.js';

/**
 * Unauthenticated liveness/readiness endpoint for PM2, Docker and uptime checks.
 *
 * It probes the real dependencies rather than returning a static 200, because the
 * failure this service has is configuration (wrong Pinecone dimension, missing
 * bucket, bad API key) and a static 200 would report healthy while every request
 * fails.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly ingestion: IngestionService) {}

  @Get()
  async check() {
    try {
      return { status: 'ok', ...(await this.ingestion.health()) };
    } catch (error) {
      throw new ServiceUnavailableException({
        status: 'degraded',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
