import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { TOPICS } from '../../common/constants.js';
import type { DlqEvent, NewJobEvent, RawJobEvent, ScoredJobEvent } from '../../common/types.js';
import { KafkaProducerService } from '../../kafka/kafka-producer.service.js';
import { ProfileService } from '../../profile/profile.service.js';
import { JobsService } from '../jobs.service.js';
import { hardFilter, isFresh } from './filters.js';
import { ScorerService } from './scorer.service.js';

/**
 * Kafka consumers (run inside the API process as a hybrid microservice):
 *   jobs.raw -> filter + dedupe + store -> jobs.new
 *   jobs.new -> LLM score -> store -> jobs.scored
 * Any failure goes to jobs.dlq instead of blocking the partition.
 */
@Controller()
export class JobPipelineController {
  private readonly log = new Logger(JobPipelineController.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly profiles: ProfileService,
    private readonly scorer: ScorerService,
    private readonly producer: KafkaProducerService,
  ) {}

  @EventPattern(TOPICS.RAW)
  async onRaw(@Payload() evt: RawJobEvent) {
    try {
      const profile = await this.profiles.getById(evt.profileId);
      const prefs = profile.preferences;
      if (!isFresh(evt.job.postedAt, prefs.postedWithinDays)) return;
      if (hardFilter(evt.job, prefs)) return;

      const id = await this.jobs.insertIfNew(evt.profileId, evt.source, evt.runId, evt.job);
      if (id) {
        const out: NewJobEvent = { jobId: id, profileId: evt.profileId };
        await this.producer.emit(TOPICS.NEW, evt.profileId, out);
      }
    } catch (e) {
      await this.toDlq('ingest', e, evt);
    }
  }

  @EventPattern(TOPICS.NEW)
  async onNew(@Payload() evt: NewJobEvent) {
    try {
      const job = await this.jobs.getById(evt.jobId);
      if (job.scoredAt) return; // idempotent on redelivery
      const profile = await this.profiles.getById(evt.profileId);

      const result = await this.scorer.score(job, profile);
      await this.jobs.saveScore(job.id, result);

      const out: ScoredJobEvent = { jobId: job.id, profileId: profile.id, score: result.score };
      await this.producer.emit(TOPICS.SCORED, profile.id, out);
    } catch (e) {
      await this.jobs.saveScoreError(evt.jobId, e instanceof Error ? e.message : String(e)).catch(() => undefined);
      await this.toDlq('score', e, evt);
    }
  }

  private async toDlq(stage: string, e: unknown, payload: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    this.log.error(`[${stage}] ${error}`);
    const out: DlqEvent = { stage, error, payload };
    await this.producer.emit(TOPICS.DLQ, stage, out).catch(() => undefined);
  }
}
