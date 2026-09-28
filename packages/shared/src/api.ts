import { z } from 'zod';
import {
  JOB_STATUSES,
  type JobPreferences,
  type JobStatus,
  type RunStats,
  type RunStatus,
} from './domain.js';
import { documentKindSchema, type DocumentKind, type UploadMode } from './rag.js';

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

// ---------- documents ----------
//
// The job agent owns the catalog (what the user uploaded, and which file is
// their primary resume); the RAG service owns the bytes and the vectors. These
// are the shapes the browser sees.

/**
 * `awaiting_upload` means a presigned URL was issued and the bytes have not
 * arrived. The other states are reported by the RAG service over
 * documents.indexed, since only it knows whether extraction succeeded.
 */
export const JOB_AGENT_DOCUMENT_STATUSES = [
  'awaiting_upload',
  'indexing',
  'ready',
  'failed',
  'deleted',
] as const;
export type JobAgentDocumentStatus = (typeof JOB_AGENT_DOCUMENT_STATUSES)[number];

export type DocumentRecord = {
  id: string;
  kind: DocumentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: JobAgentDocumentStatus;
  isPrimary: boolean;
  chunkCount: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export const createDocumentSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  sizeBytes: z.coerce.number().int().positive(),
  kind: documentKindSchema,
  /** Marks this as the resume used to build search queries. */
  isPrimary: z.boolean().optional(),
});
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

/**
 * Where to send the bytes. `mode: 's3'` means PUT them at `uploadUrl` yourself
 * and then call POST /documents/:id/complete; `mode: 'local'` means PUT them at
 * `uploadPath` (this API) instead, which relays them to the RAG service.
 */
export type CreateDocumentResult = {
  document: DocumentRecord;
  mode: UploadMode;
  uploadUrl: string | null;
  uploadPath: string | null;
  maxBytes: number;
};

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
