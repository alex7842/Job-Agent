import type { RawJob } from './domain.js';
import type { DocumentKind } from './rag.js';
/** jobs.raw — one message per posting, keyed by profileId (ordering per profile). */
export interface RawJobEvent {
  runId: string;
  profileId: string;
  source: string;
  job: RawJob;
}

/** jobs.new — a posting made it through the filters and is in the DB, unscored. */
export interface NewJobEvent {
  jobId: string;
  profileId: string;
}

/** jobs.scored — the LLM verdict is persisted. Hook for notifications / websocket. */
export interface ScoredJobEvent {
  jobId: string;
  profileId: string;
  score: number;
}

/** jobs.dlq — a stage failed; the partition is kept moving. */
export interface DlqEvent {
  stage: string;
  error: string;
  payload: unknown;
}

// ---------- RAG pipeline ----------

/**
 * jobs.index — a stored job is ready to be embedded. One message per posting,
 * keyed by profileId so a run's postings stay ordered.
 *
 * The RAG service composes the text to embed from these fields, so it never
 * needs access to the `jobs` table. Safe to redeliver: the vector id is
 * deterministic, so a repeat is an overwrite rather than a duplicate.
 */
export interface JobIndexEvent {
  jobId: string;
  profileId: string;
  userId: string;
  runId: string | null;
  source: string;
  title: string;
  company: string;
  location?: string;
  salaryText?: string;
  description?: string;
}

/**
 * documents.changed — a document object landed in the bucket (or was replaced).
 * The RAG service downloads it, extracts text, and (re)indexes it. Consumers
 * must be idempotent: the object is addressed by key, so a redelivery simply
 * re-derives the same chunks.
 */
export interface DocumentChangedEvent {
  documentId: string;
  profileId: string;
  userId: string;
  objectKey: string;
  fileName: string;
  mimeType: string;
  kind: DocumentKind;
  sizeBytes: number;
  /** The resume the user picked as their search query source. */
  isPrimary: boolean;
  /** null on first upload; the object's ETag afterwards. */
  etag: string | null;
}

/** documents.deleted — drop the vectors. The object itself is removed separately. */
export interface DocumentDeletedEvent {
  documentId: string;
  profileId: string;
  userId: string;
}

/**
 * documents.indexed — the RAG service finished (or failed) an indexing attempt.
 *
 * The job agent owns the document catalog the UI reads, but it cannot know
 * whether a PDF had a text layer or whether embedding worked, so the RAG service
 * reports the outcome back rather than the job agent guessing.
 */
export interface DocumentIndexedEvent {
  documentId: string;
  profileId: string;
  status: 'ready' | 'failed' | 'deleted';
  chunkCount: number;
  errorMessage: string | null;
}
