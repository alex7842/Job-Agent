import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { JOB_STATUSES, JOB_SOURCES, type JobStatus } from '@job-agent/shared';
import { useJobs } from '@/lib/queries';
import { formatDate, formatRelative } from '@/lib/format';
import { MetaPill, ScoreBadge, SemanticBadge, StatusBadge } from '@/components/badges';
import { EmptyState, ErrorNote, Spinner, cx } from '@/components/ui';

const SORTS = [
  { value: 'score', label: 'Best match' },
  { value: 'semantic', label: 'Closest to resume' },
  { value: 'date', label: 'Newest' },
] as const;

export function JobsPage() {
  // The URL is the source of truth for the list state so a filtered view can be
  // shared or reloaded, and TanStack Query keys off the same object.
  const [search, setSearch] = useSearchParams();

  const params = useMemo(
    () => ({
      q: search.get('q') || undefined,
      status: (search.get('status') as JobStatus | null) ?? undefined,
      source: search.get('source') || undefined,
      minScore: search.get('minScore') ? Number(search.get('minScore')) : undefined,
      sort: (search.get('sort') as 'score' | 'semantic' | 'date' | null) ?? ('score' as const),
      page: Number(search.get('page') ?? 1),
      limit: 20,
    }),
    [search],
  );

  const { data, isPending, isError, error, isPlaceholderData } = useJobs(params);

  const patch = (next: Record<string, string | number | undefined>) => {
    const merged = new URLSearchParams(search);
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value === '') merged.delete(key);
      else merged.set(key, String(value));
    }
    // Any filter change invalidates the page number.
    if (!('page' in next)) merged.delete('page');
    setSearch(merged, { replace: true });
  };

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / params.limit));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={params.q ?? ''}
          onChange={(e) => patch({ q: e.target.value })}
          placeholder="Search title or company…"
          className="h-9 w-full max-w-xs rounded-lg border border-neutral-800 bg-neutral-900 px-3 text-sm outline-none placeholder:text-neutral-600 focus:border-neutral-600"
        />

        <select
          value={params.status ?? ''}
          onChange={(e) => patch({ status: e.target.value })}
          className="h-9 rounded-lg border border-neutral-800 bg-neutral-900 px-2 text-sm outline-none focus:border-neutral-600"
        >
          <option value="">All statuses</option>
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          value={params.source ?? ''}
          onChange={(e) => patch({ source: e.target.value })}
          className="h-9 rounded-lg border border-neutral-800 bg-neutral-900 px-2 text-sm outline-none focus:border-neutral-600"
        >
          <option value="">All sources</option>
          {JOB_SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          value={params.minScore ?? ''}
          onChange={(e) => patch({ minScore: e.target.value })}
          className="h-9 rounded-lg border border-neutral-800 bg-neutral-900 px-2 text-sm outline-none focus:border-neutral-600"
        >
          <option value="">Any score</option>
          {[90, 75, 60, 40].map((n) => (
            <option key={n} value={n}>
              ≥ {n}
            </option>
          ))}
        </select>

        <div className="ml-auto flex items-center gap-1 rounded-lg border border-neutral-800 p-0.5">
          {SORTS.map((s) => (
            <button
              key={s.value}
              onClick={() => patch({ sort: s.value })}
              className={cx(
                'rounded-md px-2.5 py-1 text-xs font-medium transition',
                params.sort === s.value
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:text-neutral-200',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {isError ? <ErrorNote error={error} /> : null}
      {isPending ? <Spinner label="Loading jobs" /> : null}

      {data && data.items.length === 0 ? (
        <EmptyState
          title="No jobs match these filters."
          hint="Run a search from the Runs tab, or relax the filters above."
        />
      ) : null}

      {data && data.items.length > 0 ? (
        <ul
          className={cx(
            'divide-y divide-neutral-900 overflow-hidden rounded-xl border border-neutral-800',
            isPlaceholderData && 'opacity-60 transition-opacity',
          )}
        >
          {data.items.map((job) => (
            <li key={job.id}>
              <Link
                to={`/jobs/${job.id}`}
                className="block px-4 py-3 transition hover:bg-neutral-900/60"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-neutral-100">{job.title}</p>
                    <p className="truncate text-sm text-neutral-400">{job.company}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={job.status} />
                    <ScoreBadge score={job.matchScore} pending />
                    <SemanticBadge
                      score={job.semanticScore}
                      rank={job.semanticRank}
                      pending={params.sort === 'semantic'}
                    />
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <MetaPill>{job.source}</MetaPill>
                  {job.remote ? <MetaPill>remote</MetaPill> : null}
                  {job.location ? <MetaPill>{job.location}</MetaPill> : null}
                  {job.salaryText ? <MetaPill>{job.salaryText}</MetaPill> : null}
                  <span className="ml-auto text-xs text-neutral-500">
                    posted {formatRelative(job.postedAt)} · added {formatDate(job.createdAt)}
                  </span>
                </div>

                {job.matchReason ? (
                  <p className="mt-2 line-clamp-2 text-xs text-neutral-400">{job.matchReason}</p>
                ) : null}

                {/* A failed score is otherwise invisible: the badge says
                    "unscored" and nothing says why. Open the job to retry it. */}
                {job.scoreError ? (
                  <p className="mt-1.5 line-clamp-2 text-xs text-amber-600/90">
                    scoring failed: {job.scoreError}
                  </p>
                ) : null}

                {/* The passage that matched, so the number above is not a black box. */}
                {job.semanticSnippet ? (
                  <p className="mt-1.5 line-clamp-2 border-l-2 border-neutral-800 pl-2 text-xs text-neutral-500">
                    {job.semanticSnippet}
                  </p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {data && total > params.limit ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-neutral-500">
            Page {params.page} of {pages} · {total} jobs
          </span>
          <div className="flex gap-2">
            <button
              disabled={params.page <= 1}
              onClick={() => patch({ page: params.page - 1 })}
              className="rounded-lg border border-neutral-800 px-3 py-1 text-neutral-300 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              disabled={params.page >= pages}
              onClick={() => patch({ page: params.page + 1 })}
              className="rounded-lg border border-neutral-800 px-3 py-1 text-neutral-300 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
