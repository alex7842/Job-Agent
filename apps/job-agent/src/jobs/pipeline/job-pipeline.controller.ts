import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import {
  TOPICS,
  type DlqEvent,
  type JobIndexEvent,
  type NewJobEvent,
  type RawJobEvent,
  type ScoredJobEvent,
} from '@job-agent/shared';
import { KafkaProducerService } from '../../kafka/kafka-producer.service.js';
import type { PendingEvent } from '../../outbox/outbox.service.js';
import { ProfileService } from '../../profile/profile.service.js';
import type { Profile } from '../../profile/profile.entity.js';
import { JobsService } from '../jobs.service.js';
import { hardFilter, isFresh } from './filters.js';
import { ScorerService } from './scorer.service.js';

/**
 * A profile that predates auth has no owner. The RAG service records userId
 * with every vector, so a stable placeholder is needed; it is a real UUID so the
 * column stays valid, and vectors are still isolated by the profile namespace.
 */
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

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

      // The row and the two events it implies are written together, so nothing
      // here has to reach Kafka for the job to be considered handled. Publishing
      // inline is what used to strand a job between the insert and the second
      // event; the relay now retries instead of losing them.
      const id = await this.jobs.insertIfNew(
        evt.profileId,
        evt.source,
        evt.runId,
        evt.job,
        (jobId) => this.eventsForJob(jobId, evt, profile),
      );
      if (!id) return; // already stored by an earlier run
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
      await this.jobs
        .saveScoreError(evt.jobId, e instanceof Error ? e.message : String(e))
        .catch(() => undefined);
      await this.toDlq('score', e, evt);
    }
  }

  /**
   * The events a newly stored posting implies.
   *
   * Both are handed to the outbox rather than published here, and both are
   * idempotent downstream, so a duplicate delivery is harmless: the RAG service
   * upserts by jobId, and the scoring handler returns early on a job that already
   * has a score.
   *
   * Indexing and scoring are separate events on purpose. Embedding is a
   * different provider with its own latency, and making one wait for the other
   * would make a run take the sum of both.
   */
  private eventsForJob(jobId: string, evt: RawJobEvent, profile: Profile): PendingEvent[] {
    const index: JobIndexEvent = {
      jobId,
      profileId: evt.profileId,
      userId: profile.userId ?? ANONYMOUS_USER_ID,
      runId: evt.runId,
      source: evt.source,
      title: evt.job.title,
      company: evt.job.company,
      location: evt.job.location ?? undefined,
      salaryText: evt.job.salaryText ?? undefined,
      // A posting with no description still indexes off its title and company.
      description: evt.job.description ?? undefined,
    };
    const scoring: NewJobEvent = { jobId, profileId: evt.profileId };
    return [
      { topic: TOPICS.JOB_INDEX, key: evt.profileId, value: index },
      { topic: TOPICS.NEW, key: evt.profileId, value: scoring },
    ];
  }

  private async toDlq(stage: string, e: unknown, payload: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    this.log.error(`[${stage}] ${error}`);
    const out: DlqEvent = { stage, error, payload };
    await this.producer.emit(TOPICS.DLQ, stage, out).catch(() => undefined);
  }
}
