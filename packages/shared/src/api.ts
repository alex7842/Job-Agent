import { z } from 'zod';
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

// ---------- GET /jobs ----------

export const queryJobsSchema = z.object({
  status: jobStatusSchema.optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  source: z.string().min(1).optional(),
  q: z.string().min(1).optional(),
  sort: z.enum(['score', 'date']).default('score'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type QueryJobs = z.infer<typeof queryJobsSchema>;

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
  status: JobStatus;
  scoredAt: string | null;
  createdAt: string;
};

export type Paginated<T> = { items: T[]; total: number; page: number; limit: number };

// ---------- GET /jobs/:id ----------

export type JobDetail = JobListItem & {
  profileId: string;
  runId: string | null;
  externalId: string;
  description: string | null;
  scoreError: string | null;
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
  resumeText: string;
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
