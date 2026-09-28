import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DOCUMENT_STATUS, type DocumentSummary } from '@job-agent/shared';
import { DocumentEntity } from './document.entity.js';
import type { DocumentKind, DocumentStatus } from '@job-agent/shared';

@Injectable()
export class DocumentRepository {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly repo: Repository<DocumentEntity>,
  ) {}

  /**
   * Idempotent upsert. The job agent emits documents.changed for both create and
   * re-upload, and Kafka guarantees at-least-once delivery, so this must be safe
   * to replay. The vector store is re-indexed by the consumer separately.
   */
  async upsert(input: {
    documentId: string;
    profileId: string;
    userId: string;
    kind: DocumentKind;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    objectKey: string;
    isPrimary?: boolean;
  }): Promise<DocumentEntity> {
    const sizeBytes = String(input.sizeBytes);
    const entity = this.repo.create({
      documentId: input.documentId,
      profileId: input.profileId,
      userId: input.userId,
      kind: input.kind,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes,
      objectKey: input.objectKey,
      isPrimary: input.isPrimary ?? false,
    });

    // Only overwrite indexing fields on insert; a replayed event must not reset
    // a document that already finished indexing back to 'uploaded'.
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(DocumentEntity)
      .values(entity)
      .orUpdate(
        ['userId', 'kind', 'fileName', 'mimeType', 'sizeBytes', 'objectKey', 'updatedAt'],
        ['documentId'],
      )
      .execute();

    return await this.repo.findOneByOrFail({ documentId: input.documentId });
  }

  async findById(documentId: string): Promise<DocumentEntity | null> {
    return this.repo.findOneBy({ documentId });
  }

  /** Scoped lookup: a document is only visible within its own profile. */
  async findOwned(documentId: string, profileId: string): Promise<DocumentEntity | null> {
    return this.repo.findOneBy({ documentId, profileId });
  }

  /**
   * The text of a profile's own indexed documents, for use as a search query.
   *
   * Scoped to `profileId` on purpose: the ids arrive from a caller, and a
   * document belonging to someone else must be invisible here rather than
   * quietly contributing another user's resume to the query. Deleted documents
   * are excluded, and unready ones have no text to contribute anyway.
   */
  async extractedTextFor(
    profileId: string,
    documentIds: string[],
  ): Promise<Array<{ documentId: string; fileName: string; text: string }>> {
    if (documentIds.length === 0) return [];

    const rows = await this.repo
      .createQueryBuilder('d')
      .addSelect('d.extractedText')
      .where('d.profileId = :profileId', { profileId })
      .andWhere('d.documentId IN (:...documentIds)', { documentIds })
      .andWhere('d.status = :ready', { ready: DOCUMENT_STATUS.READY })
      .andWhere('d.extractedText IS NOT NULL')
      .getMany();

    return rows.map((r) => ({
      documentId: r.documentId,
      fileName: r.fileName,
      text: r.extractedText ?? '',
    }));
  }

  async setExtractedText(documentId: string, text: string | null): Promise<void> {
    await this.repo.update({ documentId }, { extractedText: text });
  }

  async listByProfile(
    profileId: string,
    options: { statuses?: DocumentStatus[]; includeDeleted?: boolean } = {},
  ): Promise<DocumentEntity[]> {
    const qb = this.repo.createQueryBuilder('d').where('d.profileId = :profileId', { profileId });

    if (options.statuses?.length) {
      qb.andWhere('d.status IN (:...statuses)', { statuses: options.statuses });
    }
    if (!options.includeDeleted) {
      qb.andWhere('d.status != :deleted', { deleted: DOCUMENT_STATUS.DELETED });
    }

    return qb.orderBy('d.createdAt', 'DESC').getMany();
  }

  async updateStatus(
    documentId: string,
    status: DocumentStatus,
    errorMessage: string | null = null,
    chunkCount?: number,
  ): Promise<void> {
    const patch: Partial<DocumentEntity> = { status, errorMessage };
    if (chunkCount !== undefined) patch.chunkCount = chunkCount;
    await this.repo.update({ documentId }, patch);
  }

  async markDeleted(documentId: string): Promise<void> {
    await this.repo.update(
      { documentId },
      { status: DOCUMENT_STATUS.DELETED, chunkCount: 0, errorMessage: null },
    );
  }

  /** The document that supplies the search query, if the user marked one. */
  async findPrimary(profileId: string): Promise<DocumentEntity | null> {
    return this.repo.findOneBy({ profileId, isPrimary: true, status: DOCUMENT_STATUS.READY });
  }

  async listSummaries(profileId: string): Promise<DocumentSummary[]> {
    const rows = await this.listByProfile(profileId);
    return rows.map((r) => this.toSummary(r));
  }

  private toSummary(r: DocumentEntity): DocumentSummary {
    return {
      id: r.documentId,
      profileId: r.profileId,
      kind: r.kind,
      fileName: r.fileName,
      mimeType: r.mimeType,
      // bigint columns come back as strings to avoid precision loss.
      sizeBytes: Number(r.sizeBytes),
      status: r.status,
      isPrimary: r.isPrimary,
      chunkCount: r.chunkCount,
      errorMessage: r.errorMessage,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
