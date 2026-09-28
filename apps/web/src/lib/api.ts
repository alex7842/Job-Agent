import type {
  JobDetail,
  JobListItem,
  JobStatus,
  Paginated,
  Profile,
  QueryJobs,
  SearchRun,
  StartRunResult,
  UpdateProfileInput,
} from '@job-agent/shared';

/**
 * Thin fetch wrapper around the NestJS API in `apps/job-agent`.
 *
 * Everything goes through the `/api` prefix, which Vite rewrites to the API root
 * in dev (see vite.config.ts) and which a reverse proxy rewrites in prod.
 * Response types come from @job-agent/shared, so a contract change in the API
 * is a compile error here rather than an `any` at runtime.
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
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

export const api = {
  listJobs: (params: QueryJobs) =>
    request<Paginated<JobListItem>>(`/jobs${toQuery({ ...params })}`),

  getJob: (id: string) => request<JobDetail>(`/jobs/${id}`),

  setJobStatus: (id: string, status: JobStatus) =>
    request<JobDetail>(`/jobs/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  rescoreJob: (id: string) => request<{ queued: true }>(`/jobs/${id}/rescore`, { method: 'POST' }),

  listRuns: () => request<SearchRun[]>('/runs'),

  triggerRun: () => request<StartRunResult>('/runs', { method: 'POST' }),

  getProfile: () => request<Profile>('/profile'),

  updateProfile: (input: UpdateProfileInput) =>
    request<Profile>('/profile', { method: 'PUT', body: JSON.stringify(input) }),
};
