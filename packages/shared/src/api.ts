import { z } from 'zod';
import type { ResumeData } from './resume.js';
import {
  JOB_STATUSES,
  type JobPreferences,
  type JobStatus,
  type RunStats,
  type RunStatus,
} from './domain.js';

/**
 * Wire contract for the HTTP API in `apps/job-agent`. The NestJS DTOs
 * (class-validator) validate the server side; these schemas drive the web app
 * and document the exact request/response shapes.
 *
 * All dates cross the wire as ISO-8601 strings (JSON has no Date).
 */

export const jobStatusSchema = z.enum(JOB_STATUSES);
export const runStatusSchema = z.enum(['running', 'completed', 'partial', 'failed']);

// ---------- auth ----------

/** The authenticated principal. `profileId` scopes every jobs/runs query. */
export type AuthUser = {
  id: string;
  email: string;
  profileId: string;
  createdAt: string;
  /**
   * True when the email is in ADMIN_EMAILS. Sent so the web app can hide the
   * admin link, but advisory only: the API checks the same list itself, so a
   * hand-rolled request gains nothing by pretending to be an admin.
   */
  isAdmin: boolean;
};

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds. */
  expiresIn: number;
  user: AuthUser;
};

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  // 8 is the practical floor; upper bound keeps scrypt's cost bounded.
  password: z.string().min(8).max(200),
});
export type Credentials = z.infer<typeof credentialsSchema>;

export const registerSchema = credentialsSchema.extend({
  /** Seeds the new profile's display name. */
  name: z.string().trim().min(1).max(100).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(1) });
export type RefreshInput = z.infer<typeof refreshSchema>;

// ---------- GET /jobs ----------

export const queryJobsSchema = z.object({
  status: jobStatusSchema.optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  source: z.string().min(1).optional(),
  q: z.string().min(1).optional(),
  sort: z.enum(['score', 'date', 'semantic']).default('score'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type QueryJobs = z.infer<typeof queryJobsSchema>;

/**
 * The two scores are independent on purpose: `matchScore` is the LLM's
 * considered verdict (0-100) and `semanticScore` is raw vector similarity (0-1).
 * Averaging them would be meaningless, so they are shown side by side and can be
 * sorted by either.
 */
export type JobListItem = {
  id: string;
  source: string;
  title: string;
  company: string;
  location: string | null;
  remote: boolean | null;
  salaryText: string | null;
  applyUrl: string;
  postedAt: string | null;
  matchScore: number | null;
  matchReason: string | null;
  highlights: string[];
  redFlags: string[];
  /** Vector similarity to the candidate's documents, 0-1. Null until indexed. */
  semanticScore: number | null;
  /** Best-matching chunk, so the UI can explain the score. */
  semanticSnippet: string | null;
  /** 1 = the closest match found for this run. Null until ranked. */
  semanticRank: number | null;
  semanticAt: string | null;
  status: JobStatus;
  scoredAt: string | null;
  /** Why the score is missing, when the pipeline failed. Null otherwise. */
  scoreError: string | null;
  createdAt: string;
};

export type Paginated<T> = { items: T[]; total: number; page: number; limit: number };

// ---------- GET /jobs/:id ----------

export type JobDetail = JobListItem & {
  profileId: string;
  runId: string | null;
  externalId: string;
  description: string | null;
  updatedAt: string;
};

// ---------- PATCH /jobs/:id/status ----------

export const updateStatusSchema = z.object({ status: jobStatusSchema });
export type UpdateStatusInput = z.infer<typeof updateStatusSchema>;

// ---------- runs ----------

export type SearchRun = {
  id: string;
  profileId: string;
  workflowId: string;
  status: RunStatus;
  stats: RunStats;
  startedAt: string;
  finishedAt: string | null;
};

/** POST /runs — `runId` is Temporal's first execution run id, not a SearchRun row yet. */
export type StartRunResult = { workflowId: string; runId: string };

// ---------- profile ----------

export type Profile = {
  id: string;
  name: string;
  /** Text extracted from the uploaded resume. What the LLM and the vector query read. */
  resumeText: string;
  resumeFileName: string | null;
  resumeMimeType: string | null;
  resumeSizeBytes: string | null;
  resumeObjectKey: string | null;
  /** What the parser read out of the file. Null until a resume is uploaded. */
  resumeData: ResumeData | null;
  resumeParsedAt: string | null;
  /** Why the last parse failed, so the UI can say so rather than showing nothing. */
  resumeError: string | null;
  preferences: JobPreferences;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  resumeText: z.string().max(50_000).optional(),
  isActive: z.boolean().optional(),
  preferences: z
    .object({
      roles: z.array(z.string()).optional(),
      skills: z.array(z.string()).optional(),
      locations: z.array(z.string()).optional(),
      remoteOnly: z.boolean().optional(),
      minSalary: z.number().int().min(0).optional(),
      excludedKeywords: z.array(z.string()).optional(),
      excludedCompanies: z.array(z.string()).optional(),
      greenhouseBoards: z.array(z.string()).optional(),
      sources: z.array(z.string()).optional(),
      postedWithinDays: z.number().int().min(1).max(30).optional(),
    })
    .optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** POST /runs/:id/semantic-rank and POST /jobs/semantic-rank */
export type SemanticRankResult = {
  /** Jobs that received a semantic score. */
  ranked: number;
  /** Jobs in the run that have no score yet (e.g. the RAG service is down). */
  skipped: number;
  /** True when the RAG service answered from its lexical fallback. */
  degraded: boolean;
  embeddingModel: string | null;
  vectorStore: string | null;
};

// ---------- admin ----------

/** One provider in the scoring chain and what it last did. */
export type AdminModelAttempt = {
  provider: string;
  model: string;
  ok: boolean;
  ms: number;
  served: boolean;
  error: string | null;
  status: number | null;
};

/**
 * Live state of the failover chain.
 *
 * `active` is the field that matters: it is the provider that will answer the
 * next request, which is the *fallback* while the primary is parked after a
 * rate limit. A dashboard showing only the configured model would report the
 * wrong one during exactly the incident it exists to explain.
 */
export type AdminChainStatus = {
  chain: AdminModelAttempt[];
  active: { provider: string; model: string };
  primaryParked: boolean;
  cooldownRemainingMs: number;
  failovers: Record<string, number>;
  servedByPrimary: number;
  servedByFallback: number;
  failed: number;
  startedAt: string;
};

/** GET /admin/overview — cross-profile system health. */
export type AdminOverview = {
  viewer: { email: string };
  system: {
    users: { total: number; profiles: number };
    jobs: { total: number; awaitingScore: number; scoreFailed: number };
    runs: {
      byStatus: Record<string, number>;
      running: string;
      lastStartedAt: string | null;
    };
    /** Unpublished outbox rows, and how many have been stuck over 5 minutes. */
    outbox: { pending: number; stuck: number };
    recentJobs: {
      id: string;
      title: string;
      company: string;
      source: string;
      matchScore: number | null;
      scoredAt: string | null;
      createdAt: string;
    }[];
    recentRuns: {
      id: string;
      workflowId: string;
      status: string;
      startedAt: string;
      finishedAt: string | null;
    }[];
  };
  models: {
    scoring: {
      /** Configured order, primary first. */
      configured: string[];
      model: string;
      active: { provider: string; model: string };
      /** Null when no fallback is configured, so there is no chain to report. */
      status: AdminChainStatus | null;
      resumeParsing: { configured: string[]; model: string };
    };
    embeddings: {
      available: boolean;
      reason: string | null;
      degraded?: boolean;
      model: string | null;
      vectorStore: string | null;
    };
  };
  sources: { name: string; enabled: boolean }[];
  /** Distinct scoring failures with counts, most frequent first. */
  scoreFailures: { error: string; count: string; latest: string }[];
};
