import { useState } from 'react';
import { Link } from 'react-router';
import { useRankRunSemantically, useRuns, useSemanticStatus } from '@/lib/queries';
import { formatDateTime, runStatusClass } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Notice,
  SkeletonRows,
  cx,
} from '@/components/ui';

/** Wall-clock duration, or null while a run is still going. */
function duration(startedAt: string, finishedAt: string | null): string | null {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const secs = Math.round((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Per-source outcome pills. An errored source is called out, not just counted. */
function RunStats({ stats }: { stats: Record<string, { fetched: number; error?: string }> }) {
  const entries = Object.entries(stats);
  if (entries.length === 0) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-1.5 border-t border-line pt-3.5">
      {entries.map(([source, stat]) => (
        <Badge
          key={source}
          title={stat.error ?? undefined}
          className={
            stat.error
              ? 'bg-danger-bg text-danger ring-danger/30'
              : 'bg-surface-3 text-muted ring-line'
          }
        >
          {source}
          <span className="font-mono tabular-nums opacity-70">
            {stat.error ? 'failed' : ` ${stat.fetched}`}
          </span>
        </Badge>
      ))}
    </div>
  );
}

export function RunsPage() {
  const { data: runs, isPending, isError, error } = useRuns();
  const rank = useRankRunSemantically();
  const { data: semantic } = useSemanticStatus();
  const [notice, setNotice] = useState<string | null>(null);

  const rankingDisabled = rank.isPending || semantic?.enabled === false;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Search history</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted">
          Every run of the pipeline, newest first. A run crawls your sources, scores the postings
          against your resume, and indexes them for semantic ranking.
        </p>
      </header>

      <Notice tone="accent">
        Runs are started from the{' '}
        <Link to="/" className="font-medium underline underline-offset-2">
          Jobs tab
        </Link>{' '}
        — <span className="font-medium">Search now</span> sits next to the filters, so the search
        and its results are on one screen.
      </Notice>

      {rank.isError ? <ErrorNote error={rank.error} /> : null}
      {rank.isSuccess ? (
        <Notice tone="success">
          Ranked {rank.data.ranked} postings
          {rank.data.skipped > 0 ? `, skipped ${rank.data.skipped}` : ''}
          {rank.data.degraded ? ' — the vector store answered from its lexical fallback.' : '.'}
        </Notice>
      ) : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      {isError ? <ErrorNote error={error} /> : null}
      {isPending ? <SkeletonRows rows={3} /> : null}

      {runs && runs.length === 0 ? (
        <EmptyState
          title="No runs yet."
          hint="Start one from the Jobs tab and it will show up here."
          icon={
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="size-6"
              stroke="currentColor"
              strokeWidth="1.6"
            >
              <path d="M4 12a8 8 0 0 1 13.7-5.7L20 8" strokeLinecap="round" />
              <path d="M20 4v4h-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          }
          action={
            <Link to="/">
              <Button variant="primary">Go to Jobs</Button>
            </Link>
          }
        />
      ) : null}

      {runs && runs.length > 0 ? (
        <ul className="space-y-3">
          {runs.map((run) => {
            const elapsed = duration(run.startedAt, run.finishedAt);

            return (
              <Card key={run.id} as="article" className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className={runStatusClass(run.status)}>{run.status}</Badge>
                      {elapsed ? <span className="text-xs text-subtle">took {elapsed}</span> : null}
                    </div>
                    <p className="mt-1.5 truncate font-mono text-xs text-subtle">
                      {run.workflowId}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      started {formatDateTime(run.startedAt)}
                      {run.finishedAt ? ` · finished ${formatDateTime(run.finishedAt)}` : ''}
                    </p>
                  </div>

                  {/* Manual retry for the automatic ranking that runs at the end
                      of a run: needed when the postings finished indexing after
                      the workflow had already given up waiting for them. */}
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={rank.isPending && rank.variables === run.id}
                    disabled={rankingDisabled}
                    onClick={() => {
                      setNotice(null);
                      rank.mutate(run.id);
                    }}
                    title={
                      semantic?.enabled === false
                        ? 'Semantic search is disabled on the server'
                        : "Compare this run's postings against your resume"
                    }
                  >
                    Re-rank
                  </Button>
                </div>

                <RunStats stats={run.stats} />
              </Card>
            );
          })}
        </ul>
      ) : null}

      {semantic && !semantic.enabled ? (
        <p className={cx('text-xs text-subtle')}>
          Semantic ranking is off on the server, so re-rank is unavailable. The LLM match score
          still works.
        </p>
      ) : null}
    </div>
  );
}
