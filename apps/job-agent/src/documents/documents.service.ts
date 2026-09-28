import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  MAX_DOCUMENT_BYTES,
  TOPICS,
  documentExtension,
  isAllowedDocumentMime,
  type CreateDocumentInput,
  type CreateDocumentResult,
  type DocumentChangedEvent,
  type DocumentDeletedEvent,
  type DocumentIndexedEvent,
  type DocumentRecord,
  type IngestDocumentsResult,
} from '@job-agent/shared';
import { KafkaProducerService } from '../kafka/kafka-producer.service.js';
import { RagClientService } from '../rag/rag-client.service.js';
import { Document } from './entities/document.entity.js';
import type { DocumentKind, JobAgentDocumentStatus } from '@job-agent/shared';

type Principal = { id: string; profileId: string };

/**
 * Uploads and the document catalog.
 *
 * The bytes and the vectors belong to the RAG service; this class owns who
 * uploaded what, which document is the primary resume, and the events that tell
 * the RAG service to index. Splitting it that way means a reindex or a delete is
 * a message, not a synchronous call into another service's internals.
 */
@Injectable()
export class DocumentsService {
  private readonly log = new Logger(DocumentsService.name);

  constructor(
    @InjectRepository(Document) private readonly documents: Repository<Document>,
    private readonly rag: RagClientService,
    private readonly producer: KafkaProducerService,
  ) {}

  // ---------- reads ----------

  async list(principal: Principal): Promise<DocumentRecord[]> {
    const rows = await this.documents.find({
      where: { profileId: principal.profileId, status: Not('deleted') },
      order: { createdAt: 'DESC' },
    });
    return rows.map((row) => this.toRecord(row));
  }

  /**
   * The document whose text should drive search queries, plus any others the
   * user has ready. A primary is preferred, but a user who never set one still
   * gets a query from whatever they did upload.
   */
  async readyForSearch(
    profileId: string,
  ): Promise<{ primaryId: string | null; documentIds: string[] }> {
    const rows = await this.documents.find({
      where: { profileId, status: 'ready' },
      order: { isPrimary: 'DESC', createdAt: 'DESC' },
    });
    return {
      primaryId: rows.find((r) => r.isPrimary)?.id ?? null,
      documentIds: rows.map((r) => r.id),
    };
  }

  // ---------- upload ----------

  /**
   * Validate the file and get an upload target.
   *
   * The size and type are checked before a presign is issued so an oversized or
   * executable file is refused before any URL exists, and again in the RAG
   * service when the bytes actually arrive — a client is not obliged to send
   * what it declared.
   */
  async create(principal: Principal, input: CreateDocumentInput): Promise<CreateDocumentResult> {
    this.validate(input);
    this.requireRag();

    const documentId = randomUUID();
    const presigned = await this.rag.presignUpload({
      documentId,
      profileId: principal.profileId,
      userId: principal.id,
      kind: input.kind,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      isPrimary: input.isPrimary ?? false,
    });
    if (!presigned) {
      throw new ServiceUnavailableException(
        'The search service is unavailable, so documents cannot be uploaded right now.',
      );
    }

    // Demote any existing primary *before* inserting the new one. The partial
    // unique index allows only one primary per profile, so saving the new row
    // as primary while another still held the flag would be rejected outright.
    if (input.isPrimary) {
      await this.clearOtherPrimaries(principal.profileId, documentId);
    }

    const doc = await this.documents.save(
      this.documents.create({
        id: documentId,
        profileId: principal.profileId,
        kind: input.kind,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: String(input.sizeBytes),
        objectKey: presigned.objectKey,
        status: 'awaiting_upload',
        isPrimary: input.isPrimary ?? false,
      }),
    );

    return {
      document: this.toRecord(doc),
      mode: presigned.mode,
      // In local mode there is no bucket to PUT to; the browser sends the bytes
      // to this API, which relays them.
      uploadUrl: presigned.mode === 's3' ? presigned.uploadUrl : null,
      uploadPath: presigned.mode === 'local' ? `/documents/${doc.id}/content` : null,
      maxBytes: presigned.maxBytes,
    };
  }

  /**
   * Local mode: the browser has no bucket to upload to, so the bytes come here
   * and are forwarded. The RAG service indexes them inline and reports the
   * outcome over documents.indexed, exactly as it does for a direct upload, so
   * the catalog's status does not depend on the mode.
   */
  async uploadContent(
    principal: Principal,
    documentId: string,
    content: Buffer,
  ): Promise<DocumentRecord> {
    const doc = await this.getOwned(principal, documentId);
    if (content.length === 0) throw new BadRequestException('Empty upload');
    if (content.length > MAX_DOCUMENT_BYTES) {
      throw new BadRequestException(`Documents are capped at ${MAX_DOCUMENT_BYTES} bytes`);
    }
    if (doc.status === 'deleted') {
      throw new BadRequestException('This document was deleted; upload it again');
    }

    const result = await this.rag.putContent(doc.id, principal.profileId, content, doc.mimeType);
    if (!result) {
      // Do not leave the row claiming an upload that did not land.
      await this.documents.update(doc.id, { status: 'failed', errorMessage: 'Upload failed' });
      throw new ServiceUnavailableException('The upload could not be stored. Try again.');
    }

    // The bytes are there; indexing has already happened inline, so this row is
    // no longer waiting on an upload.
    await this.documents.update(doc.id, { status: 'indexing', errorMessage: null });
    return this.toRecord(await this.getOwned(principal, documentId));
  }

  /**
   * S3 mode: the browser PUT the bytes itself, so this is the signal that they
   * are in the bucket. The RAG service extracts and indexes asynchronously.
   */
  async complete(principal: Principal, documentId: string): Promise<DocumentRecord> {
    const doc = await this.getOwned(principal, documentId);
    if (doc.status === 'deleted') throw new BadRequestException('This document was deleted');

    const event: DocumentChangedEvent = {
      documentId: doc.id,
      profileId: principal.profileId,
      userId: principal.id,
      objectKey: doc.objectKey,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      kind: doc.kind,
      sizeBytes: Number(doc.sizeBytes),
      isPrimary: doc.isPrimary,
      etag: null,
    };
    await this.producer.emit(TOPICS.DOC_CHANGED, principal.profileId, event);
    await this.documents.update(doc.id, { status: 'indexing', errorMessage: null });
    return this.toRecord(await this.getOwned(principal, documentId));
  }

  /**
   * Re-run extraction and embedding. Synchronous because the user is watching
   * one document, and the answer — including a failure — is what they need.
   */
  async reindex(principal: Principal, documentId: string): Promise<IngestDocumentsResult> {
    const doc = await this.getOwned(principal, documentId);
    this.requireRag();
    if (doc.status === 'awaiting_upload') {
      throw new BadRequestException('This document has no uploaded file yet');
    }

    const result = await this.rag.ingestDocument(doc.id, principal.profileId);
    if (!result) throw new ServiceUnavailableException('The search service is unavailable.');

    await this.applyIndexStatus({
      documentId: doc.id,
      profileId: principal.profileId,
      status: result.status === 'ready' ? 'ready' : 'failed',
      chunkCount: result.indexed,
      errorMessage: result.errorMessage ?? null,
    });
    return result;
  }

  async remove(principal: Principal, documentId: string): Promise<void> {
    const doc = await this.getOwned(principal, documentId);

    const event: DocumentDeletedEvent = {
      documentId: doc.id,
      profileId: principal.profileId,
      userId: principal.id,
    };
    await this.producer.emit(TOPICS.DOC_DELETED, principal.profileId, event);

    // Soft delete: the vectors are dropped by the RAG service when it consumes
    // the event, and a hard delete here would leave those vectors behind with
    // nothing pointing at them.
    await this.documents.update(doc.id, {
      status: 'deleted',
      isPrimary: false,
      errorMessage: null,
    });
    if (doc.isPrimary) await this.promoteAnotherPrimary(principal.profileId);
  }

  // ---------- inbound status ----------

  /**
   * The RAG service's report of an indexing attempt. Scoped to the profile the
   * event names, and the document must belong to it, so a malformed or forged
   * event cannot mark somebody else's document as ready.
   */
  async applyIndexStatus(event: DocumentIndexedEvent): Promise<void> {
    const doc = await this.documents.findOneBy({
      id: event.documentId,
      profileId: event.profileId,
    });
    if (!doc) {
      this.log.warn(`documents.indexed for unknown document ${event.documentId}`);
      return;
    }
    if (doc.status === 'deleted') return;

    await this.documents.update(doc.id, {
      status: event.status,
      chunkCount: event.chunkCount,
      errorMessage: event.errorMessage,
    });
    if (event.status === 'failed') {
      this.log.warn(`Document ${doc.id} failed to index: ${event.errorMessage}`);
    }
  }

  // ---------- helpers ----------

  /** Ownership check on a single query: a foreign id is a 404, not a 403. */
  private async getOwned(principal: Principal, documentId: string): Promise<Document> {
    const doc = await this.documents.findOneBy({ id: documentId, profileId: principal.profileId });
    if (!doc) throw new NotFoundException(`Document ${documentId} not found`);
    return doc;
  }

  private validate(input: CreateDocumentInput): void {
    if (!isAllowedDocumentMime(input.mimeType)) {
      throw new BadRequestException(
        `Unsupported file type. Allowed: PDF, DOCX, TXT, MD (got ${input.mimeType}).`,
      );
    }
    if (!documentExtension(input.fileName)) {
      throw new BadRequestException('The file name must end in .pdf, .docx, .txt or .md');
    }
    if (input.sizeBytes > MAX_DOCUMENT_BYTES) {
      throw new BadRequestException(
        `That file is ${(input.sizeBytes / 1024 / 1024).toFixed(1)} MB; the limit is ${
          MAX_DOCUMENT_BYTES / 1024 / 1024
        } MB.`,
      );
    }
  }

  private requireRag(): void {
    if (!this.rag.enabled) {
      throw new ServiceUnavailableException(
        'Document upload is not configured: RAG_INTERNAL_SECRET is missing on the API.',
      );
    }
  }

  /**
   * One primary resume per profile, so a search has a single query source.
   *
   * Called before the new primary is written, not after: `uq_documents_primary`
   * is a partial unique index, and a second row flagged primary in the same
   * transaction as the old one would violate it.
   */
  private async clearOtherPrimaries(profileId: string, exceptId?: string): Promise<void> {
    await this.documents.update(
      { profileId, isPrimary: true, ...(exceptId ? { id: Not(exceptId) } : {}) },
      { isPrimary: false },
    );
  }

  /** After the primary is deleted, fall back to the most recent other ready document. */
  private async promoteAnotherPrimary(profileId: string): Promise<void> {
    const next = await this.documents.findOne({
      where: { profileId, status: 'ready' as JobAgentDocumentStatus },
      order: { createdAt: 'DESC' },
    });
    if (!next) return;
    await this.documents.update(next.id, { isPrimary: true });
    this.log.log(`Promoted document ${next.id} to primary for ${profileId}`);
  }

  private toRecord(row: Document): DocumentRecord {
    return {
      id: row.id,
      kind: row.kind as DocumentKind,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: Number(row.sizeBytes),
      status: row.status,
      isPrimary: row.isPrimary,
      chunkCount: row.chunkCount,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
