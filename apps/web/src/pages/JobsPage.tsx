import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { JOB_SOURCES, JOB_STATUSES, type JobStatus } from '@job-agent/shared';
import { useJobs, useRuns, useTriggerRun } from '@/lib/queries';
import { JobCard, JobRow, JobsEmpty } from '@/components/JobCards';
import {
  Button,
  Card,
  ErrorNote,
  Input,
  Notice,
  Segmented,
  Select,
  SkeletonRows,
  cx,
} from '@/components/ui';
import { JOB_STATUS_LABEL } from '@/lib/format';
import { useLocalState } from '@/lib/useLocalState';

const SORTS = [
  { value: 'score', label: 'Best match' },
  { value: 'semantic', label: 'Closest to resume' },
  { value: 'date', label: 'Newest' },
] as const;

const LAYOUTS = [
  {
    value: 'card',
    label: 'Cards',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className="size-3.5"
        stroke="currentColor"
        strokeWidth="1.7"
      >
        <rect x="3" y="4" width="8" height="7" rx="1.5" />
        <rect x="13" y="4" width="8" height="7" rx="1.5" />
        <rect x="3" y="13" width="8" height="7" rx="1.5" />
        <rect x="13" y="13" width="8" height="7" rx="1.5" />
      </svg>
    ),
  },
  {
    value: 'list',
    label: 'List',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className="size-3.5"
        stroke="currentColor"
        strokeWidth="1.7"
      >
        <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
      </svg>
    ),
  },
] as const;

const SCORE_STEPS = [90, 75, 60, 40] as const;

export function JobsPage() {
  // The URL is the source of truth for the list state so a filtered view can be
  // shared or reloaded, and TanStack Query keys off the same object.
  const [search, setSearch] = useSearchParams();

  // Layout is a viewing preference, not a filter: it must not change which jobs
  // are returned, so it lives in localStorage instead of the query string.
  const [layout, setLayout] = useLocalState<'card' | 'list'>('job-layout', 'card');

  const [query, setQuery] = useState(search.get('q') ?? '');
  useEffect(() => setQuery(search.get('q') ?? ''), [search]);

  // Typing re-queries on every keystroke otherwise, so the list flickers
  // through a partial term and fires a request per character.
  useEffect(() => {
    const current = search.get('q') ?? '';
    if (query === current) return;
    const timer = setTimeout(() => {
      const merged = new URLSearchParams(search);
      if (query.trim()) merged.set('q', query);
      else merged.delete('q');
      merged.delete('page');
      setSearch(merged, { replace: true });
    }, 280);
    return () => clearTimeout(timer);
  }, [query, search, setSearch]);

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
  const trigger = useTriggerRun();

  // A run is still working, so the header can say so instead of the user
  // triggering a second one on top of it.
  const { data: runs } = useRuns();
  const activeRun = runs?.find((run) => run.status === 'running');

  const patch = useCallback(
    (next: Record<string, string | number | undefined>) => {
      const merged = new URLSearchParams(search);
      for (const [key, value] of Object.entries(next)) {
        if (value === undefined || value === '') merged.delete(key);
        else merged.set(key, String(value));
      }
      // Any filter change invalidates the page number.
      if (!('page' in next)) merged.delete('page');
      setSearch(merged, { replace: true });
    },
    [search, setSearch],
  );

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / params.limit));
  const filtered = Boolean(
    params.q || params.status || params.source || params.minScore !== undefined,
  );

  const clearFilters = () => {
    setQuery('');
    setSearch(new URLSearchParams(), { replace: true });
  };

  return (
    <div className="space-y-6">
      {/* ---------- hero ---------- */}
      <Card className="relative overflow-hidden border-line bg-surface">
        {/* Decorative wash. Behind the content, and inert to pointer events. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-linear-to-br from-accent/8 via-transparent to-transparent"
        />
        <div className="relative flex flex-wrap items-end justify-between gap-4 p-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-fg">Jobs worth your time</h1>
            <p className="mt-1.5 max-w-xl text-sm text-muted">
              Every posting from your sources, scored against your resume and ranked by how close it
              is to what you have actually done.
            </p>
          </div>

          {/* The search trigger lives here rather than on Runs: starting a run is
              the reason you came to this page. */}
          <div className="flex items-center gap-3">
            {activeRun ? (
              <span className="flex items-center gap-2 text-xs text-muted">
                <span className="size-1.5 animate-pulse rounded-full bg-new" />
                Search running
              </span>
            ) : null}
            <Button
              variant="primary"
              size="lg"
              loading={trigger.isPending}
              disabled={Boolean(activeRun) && !trigger.isPending}
              onClick={() => trigger.mutate()}
              title="Runs the same pipeline as the daily schedule"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                className="size-4"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" strokeLinecap="round" />
              </svg>
              Search now
            </Button>
          </div>
        </div>
      </Card>

      {trigger.isError ? <ErrorNote error={trigger.error} /> : null}
      {trigger.isSuccess ? (
        <Notice>
          Search started. New jobs appear below as the pipeline runs — the list refreshes on its
          own.
        </Notice>
      ) : null}

      {/* ---------- toolbar ---------- */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" strokeLinecap="round" />
            </svg>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title or company…"
              className="pl-9"
              aria-label="Search jobs"
            />
          </div>

          <Select
            value={params.status ?? ''}
            onChange={(e) => patch({ status: e.target.value })}
            aria-label="Filter by status"
            className="w-auto min-w-36"
          >
            <option value="">All statuses</option>
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {JOB_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>

          <Select
            value={params.source ?? ''}
            onChange={(e) => patch({ source: e.target.value })}
            aria-label="Filter by source"
            className="w-auto min-w-36"
          >
            <option value="">All sources</option>
            {JOB_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>

          <Select
            value={params.minScore ?? ''}
            onChange={(e) => patch({ minScore: e.target.value })}
            aria-label="Minimum match score"
            className="w-auto min-w-32"
          >
            <option value="">Any score</option>
            {SCORE_STEPS.map((n) => (
              <option key={n} value={n}>
                ≥ {n}
              </option>
            ))}
          </Select>

          {filtered ? (
            <Button variant="ghost" size="md" onClick={clearFilters}>
              Clear
            </Button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-subtle">Sort</span>
            <Segmented
              label="Sort jobs"
              value={params.sort}
              options={SORTS.map((s) => ({ value: s.value, label: s.label }))}
              onChange={(sort) => patch({ sort })}
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-subtle">Layout</span>
            <Segmented label="Layout" value={layout} options={LAYOUTS} onChange={setLayout} />
          </div>
        </div>
      </div>

      {/* ---------- results ---------- */}
      {isError ? <ErrorNote error={error} /> : null}
      {isPending ? <SkeletonRows /> : null}

      {data && data.items.length === 0 ? (
        <JobsEmpty filtered={filtered} onClear={clearFilters} onSearch={() => trigger.mutate()} />
      ) : null}

      {data && data.items.length > 0 ? (
        <div
          className={cx(
            'transition-opacity',
            isPlaceholderData && 'opacity-50',
            layout === 'card' ? 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3' : 'space-y-3',
          )}
        >
          {data.items.map((job) =>
            layout === 'card' ? (
              <JobCard key={job.id} job={job} semanticPending={params.sort === 'semantic'} />
            ) : (
              <Card key={job.id} as="article" className="overflow-hidden py-0">
                <JobRow job={job} semanticPending={params.sort === 'semantic'} />
              </Card>
            ),
          )}
        </div>
      ) : null}

      {data && total > params.limit ? (
        <nav className="flex items-center justify-between gap-4 pt-1">
          <span className="text-xs text-subtle">
            Page {params.page} of {pages} · {total} jobs
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={params.page <= 1}
              onClick={() => patch({ page: params.page - 1 })}
            >
              Previous
            </Button>
            <Button
              size="sm"
              disabled={params.page >= pages}
              onClick={() => patch({ page: params.page + 1 })}
            >
              Next
            </Button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}
