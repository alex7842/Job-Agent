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
