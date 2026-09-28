import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import {
  DOCUMENT_STATUS,
  TOPICS,
  type DocumentChangedEvent,
  type DocumentDeletedEvent,
  type DocumentIndexedEvent,
  type IngestDocumentsResult,
  type JobIndexEvent,
} from '@job-agent/shared';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { DocumentRepository } from '../database/document.repository.js';
import { KafkaPublisherService } from './publisher.service.js';

/**
 * Kafka entry points for the indexing pipeline.
 *
 * This is the only path that writes vectors outside the internal API, so
 * ingestion never blocks an HTTP request: a 40-page PDF would otherwise hold a
 * connection open for 30 seconds while Gemini and Pinecone are called.
 *
 * Handlers do not throw for a per-document failure. A failed index marks that
 * document 'failed' and acknowledges, rather than requeueing forever; the status
 * is shown in the UI and the user can reindex manually.
 */
@Controller()
export class IndexingConsumer {
  private readonly log = new Logger(IndexingConsumer.name);

  constructor(
    private readonly ingestion: IngestionService,
    private readonly documents: DocumentRepository,
    private readonly publisher: KafkaPublisherService,
  ) {}

  /** A new or re-uploaded document: persist the record, then index it. */
  @EventPattern(TOPICS.DOC_CHANGED)
  async onDocumentChanged(@Payload() event: DocumentChangedEvent) {
    this.log.log(`documents.changed ${event.documentId} (${event.kind})`);

    // Upsert first, so a failure below still leaves a row the UI can show as
    // failed rather than an upload that silently vanished.
    await this.documents.upsert({
      documentId: event.documentId,
      profileId: event.profileId,
      userId: event.userId,
      kind: event.kind,
      fileName: event.fileName,
      mimeType: event.mimeType,
      sizeBytes: event.sizeBytes,
      objectKey: event.objectKey,
      isPrimary: event.isPrimary,
    });

    const result = await this.ingestion.ingestDocument(event.documentId);
    if (result.status === DOCUMENT_STATUS.FAILED) {
      this.log.warn(`Document ${event.documentId} did not index: ${result.errorMessage}`);
    }
    await this.publishStatus(event.profileId, result);
    return result;
  }

  @EventPattern(TOPICS.DOC_DELETED)
  async onDocumentDeleted(@Payload() event: DocumentDeletedEvent) {
    this.log.log(`documents.deleted ${event.documentId}`);
    const deleted = await this.ingestion.deleteDocument(event.documentId, event.profileId);
    if (deleted) {
      await this.publisher.emit(TOPICS.DOC_INDEXED, event.profileId, {
        documentId: event.documentId,
        profileId: event.profileId,
        status: DOCUMENT_STATUS.DELETED,
        chunkCount: 0,
        errorMessage: null,
      } satisfies DocumentIndexedEvent);
    }
  }

  /**
   * Report the outcome to the job agent, which owns the catalog the UI reads.
   * Only terminal states are reported: `indexing` is implied by the upload the
   * user just made, and the document is not searchable until this lands anyway.
   */
  private async publishStatus(profileId: string, result: IngestDocumentsResult): Promise<void> {
    if (result.status !== DOCUMENT_STATUS.READY && result.status !== DOCUMENT_STATUS.FAILED) return;
    await this.publisher.emit(TOPICS.DOC_INDEXED, profileId, {
      documentId: result.documentId,
      profileId,
      status: result.status,
      chunkCount: result.indexed,
      errorMessage: result.errorMessage ?? null,
    } satisfies DocumentIndexedEvent);
  }

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
