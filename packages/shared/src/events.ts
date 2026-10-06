import type { RawJob } from './domain.js';
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
