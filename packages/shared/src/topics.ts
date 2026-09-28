/**
 * Kafka topics + Temporal identifiers. Imported by the API (producer/consumer),
 * the worker, and the web app, so a topic rename breaks the build instead of prod.
 */

export const TOPICS = {
  RAW: 'jobs.raw', // fetched from a source, not yet deduped
  NEW: 'jobs.new', // stored in DB, waiting to be scored
  SCORED: 'jobs.scored', // scored (hook for notifications / websocket later)
  DLQ: 'jobs.dlq', // failed messages
  // RAG pipeline. Emitted by the API, consumed by apps/rag-service. Carries the
  // text to embed so the RAG service never needs the jobs schema.
  JOB_INDEX: 'jobs.index',
  DOC_CHANGED: 'documents.changed',
  DOC_DELETED: 'documents.deleted',
  // Emitted by apps/rag-service back to the API, which owns the document
  // catalog. The RAG service is the only thing that knows whether extraction
  // and embedding actually succeeded, and the UI has to show that.
  DOC_INDEXED: 'documents.indexed',
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

export const TASK_QUEUE = 'job-search';
export const SCHEDULE_ID = 'daily-job-search';
export const WORKFLOW_NAME = 'dailyJobSearchWorkflow';
export const KAFKA_CLIENT = 'KAFKA_PRODUCER';
