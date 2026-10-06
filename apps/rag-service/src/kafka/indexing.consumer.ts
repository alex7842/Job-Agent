import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { TOPICS, type JobIndexEvent } from '@job-agent/shared';
import { IngestionService } from '../ingestion/ingestion.service.js';

/**
 * Kafka entry point for job indexing.
 *
 * Postings are indexed out of band so a fetch never waits on Fireworks and
 * Pinecone. Documents are not here: a resume is uploaded once, synchronously, by
 * the profile form, so it has no message to travel on.
 */
@Controller()
export class IndexingConsumer {
  private readonly log = new Logger(IndexingConsumer.name);

  constructor(private readonly ingestion: IngestionService) {}

  /** One posting per message; the topic is partitioned by profileId. */
  @EventPattern(TOPICS.JOB_INDEX)
  async onJobIndex(@Payload() event: JobIndexEvent) {
    const text = jobIndexText(event);
    if (text.length < 20) {
      this.log.debug(`Skipping ${event.jobId}: not enough text to embed`);
      return { indexed: 0, skipped: 1 };
    }

    return this.ingestion.ingestJobs(event.profileId, event.userId, [
      {
        jobId: event.jobId,
        runId: event.runId ?? undefined,
        title: event.title,
        company: event.company,
        source: event.source,
        text,
      },
    ]);
  }
}

/**
 * Build the text that represents a posting. Field labels are included because
 * the embedding of "Senior Engineer" should sit nearer "Role: Senior Engineer"
 * than a bare employer name does.
 */
export function jobIndexText(event: JobIndexEvent): string {
  return [
    `Role: ${event.title}`,
    event.company ? `Company: ${event.company}` : null,
    event.location ? `Location: ${event.location}` : null,
    event.salaryText ? `Compensation: ${event.salaryText}` : null,
    event.description ? `\n${event.description.trim()}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join('\n');
}
