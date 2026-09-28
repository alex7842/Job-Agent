import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DOCUMENT_KINDS, JOB_AGENT_DOCUMENT_STATUSES } from '@job-agent/shared';
import type { DocumentKind, JobAgentDocumentStatus } from '@job-agent/shared';

/**
 * The job agent's catalog of what a user uploaded.
 *
 * The bytes live in the object store and the vectors in the RAG service, both
 * owned elsewhere; this table is the job agent's own record, so it is the thing
 * authorization is checked against and the thing the UI lists. It carries no
 * extracted text on purpose — a resume would then exist in two databases, and
 * the two copies would drift.
 */
@Entity('documents')
@Index('idx_documents_profile_created', ['profileId', 'createdAt'])
export class Document {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column({ type: 'uuid' }) profileId: string;

  @Column({ type: 'enum', enum: [...DOCUMENT_KINDS], enumName: 'document_kind' })
  kind: DocumentKind;

  @Column({ type: 'varchar' }) fileName: string;
  @Column({ type: 'varchar' }) mimeType: string;
  @Column({ type: 'bigint' }) sizeBytes: string;

  /** Set by the RAG service, which owns the object store. Never sent to the browser. */
  @Column({ type: 'varchar' }) objectKey: string;

  @Column({
    type: 'enum',
    enum: [...JOB_AGENT_DOCUMENT_STATUSES],
    enumName: 'document_status',
    default: 'awaiting_upload',
  })
  status: JobAgentDocumentStatus;

  /** The resume the search queries are built from. */
  @Column({ type: 'boolean', default: false }) isPrimary: boolean;

  @Column({ type: 'int', default: 0 }) chunkCount: number;
  @Column({ type: 'text', nullable: true }) errorMessage: string | null;

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
