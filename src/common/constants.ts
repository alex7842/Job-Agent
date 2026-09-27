export const TOPICS = {
  RAW: 'jobs.raw', // fetched from a source, not yet deduped
  NEW: 'jobs.new', // stored in DB, waiting to be scored
  SCORED: 'jobs.scored', // scored (hook for notifications / websocket later)
  DLQ: 'jobs.dlq', // failed messages
} as const;

export const TASK_QUEUE = 'job-search';
export const SCHEDULE_ID = 'daily-job-search';
export const WORKFLOW_NAME = 'dailyJobSearchWorkflow';
export const KAFKA_CLIENT = 'KAFKA_PRODUCER';
