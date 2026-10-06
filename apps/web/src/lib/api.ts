import type {
  AdminOverview,
  AuthUser,
  JobDetail,
  JobListItem,
  JobStatus,
  Paginated,
  Profile,
  QueryJobs,
  ResumeLink,
  ResumeParseResult,
  SearchRun,
  SemanticRankResult,
  StartRunResult,
  TokenPair,
  UpdateProfileInput,
} from '@job-agent/shared';
import { tokens } from './token';

/** GET /semantic/status */
export type SemanticStatus = {
  enabled: boolean;
  degraded: boolean;
  embeddingModel: string | null;
  vectorStore: string | null;
};

/**
 * Thin fetch wrapper around the NestJS API in `apps/job-agent`.
 *
 * Everything goes through the `/api` prefix, which Vite rewrites to the API root
 * in dev (see vite.config.ts) and which a reverse proxy rewrites in prod.
 * Response types come from @job-agent/shared, so a contract change in the API
 * is a compile error here rather than an `any` at runtime.
 *
 * Auth: the access token rides along as a bearer header. When it expires the API
 * answers 401, and we silently exchange the refresh token for a new pair and
 * replay the request once.
 */
const BASE = '/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Notified when a refresh fails, so the shell can bounce to /login. */
let authFailure: (() => void) | null = null;
export function onAuthFailure(cb: () => void): () => void {
  authFailure = cb;
  return () => {
    if (authFailure === cb) authFailure = null;
  };
}

function persist(pair: TokenPair): TokenPair {
  tokens.save({
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    userId: pair.user.id,
    email: pair.user.email,
  });
  return pair;
}

/**
 * One refresh at a time, shared by every caller. The dashboard fires several
 * queries at once, so a burst of 401s must not race into N refresh calls — with
 * rotation, N-1 of them would present an already-consumed token and log the
 * user out.
 */
let inFlight: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  if (inFlight) return inFlight;

  const refreshToken = tokens.refresh();
  if (!refreshToken) return Promise.resolve(false);

  const run = (async () => {
    try {
      const pair = await send<TokenPair>('/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
      });
      persist(pair);
      return true;
    } catch {
      return false;
    }
  })();

  inFlight = run.finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * JSON is the default framing, but only for a body we serialized ourselves —
 * those are strings. FormData and Blob have to go out with no content-type at
 * all: the browser sets `multipart/form-data` together with the boundary it
 * generated, and naming the type here replaces that with a value that has no
 * boundary. The API's JSON parser then tries to parse the boundary itself and
 * answers `Unexpected token '-', "------WebKitBoundary..." is not valid JSON`.
 */
function withDefaultHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && typeof init.body === 'string') {
    headers.set('content-type', 'application/json');
  }
  return headers;
}

/** Raw fetch with no auth handling; used by refresh and the auth endpoints. */
async function send<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: withDefaultHeaders(init),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the API. Is `pnpm dev:api` running?');
  }

  if (!res.ok) {
    // Nest returns { statusCode, message, error }; message can be string[].
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    const raw = body?.message;
    const message = Array.isArray(raw)
      ? raw.join(', ')
      : typeof raw === 'string'
        ? raw
        : res.statusText;
    throw new ApiError(res.status, message || `Request failed (${res.status})`);
  }

  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

async function request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
  const access = tokens.access();
  const headers = new Headers(init.headers);
  if (access) headers.set('authorization', `Bearer ${access}`);

  try {
    return await send<T>(path, { ...init, headers });
  } catch (err) {
    const expired = err instanceof ApiError && err.status === 401;
    // Only an authenticated request can be expired; a failed /auth/login must
    // surface its own 401, and the retry is capped at one.
    if (!expired || !access || attempt >= 1) throw err;

    if (await refreshSession()) return request<T>(path, init, attempt + 1);

    tokens.clear();
    authFailure?.();
    throw err;
  }
}

/** Drops undefined/empty values so we never send `?status=&page=1` noise. */
function toQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

/**
 * A raw body, with the file's own content type and no JSON framing.
 *
 * `request` is reused rather than a new fetch so the access token and the
 * single-flight refresh still apply: an upload that outlives a 15-minute access
 * token would otherwise fail on a 401 and strand the file. contentType is left
 * undefined for FormData so the browser keeps its own multipart boundary; pass
 * one only for a raw body whose type is known (application/pdf, text/plain).
 */
async function sendBinary<T>(
  path: string,
  body: BodyInit,
  contentType?: string,
  attempt = 0,
): Promise<T> {
  const access = tokens.access();
  const headers: Record<string, string> = {};
  if (contentType !== undefined) headers['content-type'] = contentType;
  if (access) headers.authorization = `Bearer ${access}`;

  try {
    return await send<T>(path, { method: 'POST', body, headers });
  } catch (err) {
    const expired = err instanceof ApiError && err.status === 401;
    if (!expired || !access || attempt >= 1) throw err;
    if (await refreshSession()) return sendBinary<T>(path, body, contentType, attempt + 1);
    tokens.clear();
    authFailure?.();
    throw err;
  }
}

export const api = {
  // ---------- auth ----------
  // These call send directly rather than request: there is no access token yet
  // to attach, and a 401 from /auth/login is a real answer (wrong password),
  // not an expired session to refresh.

  register: async (input: { email: string; password: string; name?: string }) =>
    persist(
      await send<TokenPair>('/auth/register', { method: 'POST', body: JSON.stringify(input) }),
    ),

  login: async (input: { email: string; password: string }) =>
    persist(await send<TokenPair>('/auth/login', { method: 'POST', body: JSON.stringify(input) })),

  me: () => request<AuthUser>('/auth/me'),

  logout: async () => {
    const refreshToken = tokens.refresh();
    tokens.clear();
    // Best effort: the local session is gone either way, and a dead refresh
    // token must not keep the user stuck on a spinner.
    if (refreshToken) {
      await send<void>('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
      }).catch(() => undefined);
    }
  },

  // ---------- jobs ----------
  listJobs: (params: QueryJobs) =>
    request<Paginated<JobListItem>>(`/jobs${toQuery({ ...params })}`),

  getJob: (id: string) => request<JobDetail>(`/jobs/${id}`),

  setJobStatus: (id: string, status: JobStatus) =>
    request<JobDetail>(`/jobs/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  rescoreJob: (id: string) => request<{ queued: true }>(`/jobs/${id}/rescore`, { method: 'POST' }),

  // ---------- runs ----------
  listRuns: () => request<SearchRun[]>('/runs'),

  triggerRun: () => request<StartRunResult>('/runs', { method: 'POST' }),

  // ---------- profile ----------
  getProfile: () => request<Profile>('/profile'),

  updateProfile: (input: UpdateProfileInput) =>
    request<Profile>('/profile', { method: 'PUT', body: JSON.stringify(input) }),

  // ---------- resume ----------
  /**
   * One call, because it is one step: the API relays the bytes to the document
   * service, which stores the file and extracts its text, and the parser fills
   * the profile in before the response goes out. Nothing to poll afterwards.
   */
  uploadResume: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return sendBinary<ResumeParseResult>('/profile/resume', form);
  },

  removeResume: () => request<Profile>('/profile/resume', { method: 'DELETE' }),

  /** Signed URL for the stored file. Fetched on click: it expires. */
  resumeLink: () => request<ResumeLink>('/profile/resume/link'),

  // ---------- semantic ----------
  semanticStatus: () =>
    request<SemanticStatus>(`/semantic/status`).catch(() => ({
      enabled: false,
      degraded: false,
      embeddingModel: null,
      vectorStore: null,
    })),

  rankAllSemantically: () => request<SemanticRankResult>('/jobs/semantic-rank', { method: 'POST' }),

  rankRunSemantically: (runId: string) =>
    request<SemanticRankResult>(`/runs/${runId}/semantic-rank`, { method: 'POST' }),

  // ---------- admin ----------
  adminOverview: () => request<AdminOverview>('/admin/overview'),
};
