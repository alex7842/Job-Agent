import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { TOPICS, type DocumentIndexedEvent } from '@job-agent/shared';
import { DocumentsService } from '../documents/documents.service.js';

/**
 * Consumes the RAG service's indexing reports.
 *
 * Runs in the API process alongside the pipeline consumers. The RAG service is
 * the only thing that knows whether a PDF had a text layer or whether embedding
 * worked, so it reports the outcome and this side records it — the catalog the
 * UI reads lives here, and guessing at the status from the upload alone would
 * show "indexed" for a file that never produced a single vector.
 */
@Controller()
export class DocumentStatusConsumer {
  private readonly log = new Logger(DocumentStatusConsumer.name);

  constructor(private readonly documents: DocumentsService) {}

  @EventPattern(TOPICS.DOC_INDEXED)
  async onDocumentIndexed(@Payload() event: DocumentIndexedEvent) {
    await this.documents.applyIndexStatus(event);
    this.log.log(`documents.indexed ${event.documentId} -> ${event.status}`);
  }
}
