import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { DOCUMENT_KINDS, DOCUMENT_STATUSES } from '@job-agent/shared';
import type { DocumentKind, DocumentStatus } from '@job-agent/shared';

/**
 * The RAG service's own record of what the user uploaded.
 *
 * This is deliberately not a foreign key into the job agent's `documents` table
 * even if one exists: two services must not share table ownership. The job agent
 * owns user/profile identity; this table caches what it needs to serve a search
 * and to report indexing status, and the copy is refreshed by events.
 */
@Entity({ name: 'rag_documents' })
// Listing is always "this user's documents, newest first".
@Index('idx_rag_documents_profile_created', ['profileId', 'createdAt'])
export class DocumentEntity {
  /** UUID minted by the job agent when the upload was created. */
  @PrimaryColumn('uuid')
  documentId: string;

  @Column('uuid')
  profileId: string;

  @Column('uuid')
  userId: string;

  @Column({ type: 'enum', enum: [...DOCUMENT_KINDS], enumName: 'rag_document_kind' })
  kind: DocumentKind;

  @Column()
  fileName: string;

  @Column()
  mimeType: string;

  @Column('bigint')
  sizeBytes: string;

  /** Where the bytes live: an S3 key, or a path under the local storage root. */
  @Column()
  objectKey: string;

  @Column({
    type: 'enum',
    enum: [...DOCUMENT_STATUSES],
    enumName: 'rag_document_status',
    default: 'uploaded',
  })
  status: DocumentStatus;

  /** The resume used as the search query source. */
  @Column({ type: 'boolean', default: false })
  isPrimary: boolean;

  @Column({ type: 'int', default: 0 })
  chunkCount: number;

  /**
   * The text pulled out of the file, kept so this service can build a search
   * query from it. The job agent deliberately does not keep a second copy: it
   * would have to read the object back out of the bucket to send the same text
   * over the wire on every search, and two copies of a resume drift apart.
   *
   * `select: false` because a full-text column is large and no ordinary listing
   * needs it; the repository opts in explicitly for the query path.
   */
  @Column({ type: 'text', nullable: true, select: false })
  extractedText: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
