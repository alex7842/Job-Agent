/**
 * Domain primitives shared by the API, the Temporal worker and the web app.
 *
 * NOTE: `JobStatus` / `RunStatus` are const objects rather than TS enums so the
 * browser can import them without emitting runtime code. They are structurally
 * identical to a TS enum, which is what lets the TypeORM entities keep using
 * them in `@Column({ type: 'enum', enum: JobStatus })`.
 */

export const JOB_STATUSES = ['new', 'saved', 'applied', 'ignored'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JobStatus = {
  NEW: 'new',
  SAVED: 'saved',
  APPLIED: 'applied',
  IGNORED: 'ignored',
} as const satisfies Record<string, JobStatus>;

export const RUN_STATUSES = ['running', 'completed', 'partial', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RunStatus = {
  RUNNING: 'running',
  COMPLETED: 'completed', // every source fetched + published to Kafka
  PARTIAL: 'partial', // some sources failed
  FAILED: 'failed', // all sources failed
} as const satisfies Record<string, RunStatus>;

/** Per-source outcome of one search run, keyed by source name. */
export type RunStats = Record<string, { fetched: number; error?: string }>;

/** Job platforms wired into SourcesRegistry, in the order they are fetched. */
export const JOB_SOURCES = ['jsearch', 'adzuna', 'remotive', 'greenhouse'] as const;
export type JobSourceName = (typeof JOB_SOURCES)[number];

export interface JobPreferences {
  roles: string[]; // e.g. ["Full Stack Developer", "React Native Developer"]
  skills: string[]; // e.g. ["React", "Node.js", "PostgreSQL"]
  locations: string[]; // e.g. ["Bengaluru", "Hyderabad"]
  remoteOnly: boolean;
  minSalary?: number;
  excludedKeywords: string[]; // matched against job title
  excludedCompanies: string[];
  greenhouseBoards: string[]; // company board tokens, e.g. ["stripe", "airbnb"]
  sources?: string[]; // restrict to these sources; default = all enabled
  postedWithinDays: number;
}

export const DEFAULT_PREFERENCES: JobPreferences = {
  roles: [],
  skills: [],
  locations: [],
  remoteOnly: false,
  excludedKeywords: [],
  excludedCompanies: [],
  greenhouseBoards: [],
  postedWithinDays: 7,
};

/** Platform-agnostic job posting, the contract every source must normalise to. */
export interface RawJob {
  externalId: string;
  title: string;
  company: string;
  location?: string;
  remote?: boolean;
  salaryText?: string;
  description?: string;
  applyUrl: string;
  postedAt?: string; // ISO
}
