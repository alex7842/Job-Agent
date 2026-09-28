import { Link, useParams } from 'react-router';
import { type JobStatus } from '@job-agent/shared';
import { useJob, useRescoreJob, useSetJobStatus } from '@/lib/queries';
import { formatDateTime } from '@/lib/format';
import { MetaPill, ScoreBadge, StatusBadge } from '@/components/badges';
import { ErrorNote, Spinner, cx } from '@/components/ui';

const REVIEW_ACTIONS: { status: JobStatus; label: string; active: string }[] = [
  { status: 'saved', label: 'Save', active: 'bg-amber-500/20 text-amber-200 ring-amber-500/40' },
  {
    status: 'applied',
    label: 'Mark applied',
    active: 'bg-emerald-500/20 text-emerald-200 ring-emerald-500/40',
  },
  {
    status: 'ignored',
    label: 'Ignore',
    active: 'bg-neutral-500/20 text-neutral-300 ring-neutral-500/40',
  },
];

export function JobDetailPage() {
  const { id = '' } = useParams();
  const { data: job, isPending, isError, error } = useJob(id);
  const setStatus = useSetJobStatus();
  const rescore = useRescoreJob();

  if (isPending) return <Spinner label="Loading job" />;
  if (isError) return <ErrorNote error={error} />;
  if (!job) return null;

  return (
    <div className="space-y-5">
      <Link to="/" className="text-xs text-neutral-500 hover:text-neutral-300">
        ← Back to jobs
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-neutral-50">{job.title}</h1>
          <p className="text-neutral-400">{job.company}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <MetaPill>{job.source}</MetaPill>
            {job.remote ? <MetaPill>remote</MetaPill> : null}
            {job.location ? <MetaPill>{job.location}</MetaPill> : null}
            {job.salaryText ? <MetaPill>{job.salaryText}</MetaPill> : null}
            <MetaPill>posted {formatDateTime(job.postedAt)}</MetaPill>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ScoreBadge score={job.matchScore} pending />
          <a
            href={job.applyUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 transition hover:bg-white"
          >
            Apply ↗
          </a>
        </div>
      </header>

      {/* ---------- review actions ---------- */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-neutral-800 px-3 py-2.5">
        <StatusBadge status={job.status} />
        <div className="flex gap-1.5">
          {REVIEW_ACTIONS.map((action) => (
            <button
              key={action.status}
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate({ id: job.id, status: action.status })}
              className={cx(
                'rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition disabled:opacity-50',
                job.status === action.status
                  ? action.active
                  : 'text-neutral-400 ring-neutral-800 hover:text-neutral-200 hover:ring-neutral-600',
              )}
            >
              {action.label}
            </button>
          ))}
          {job.status !== 'new' ? (
            <button
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate({ id: job.id, status: 'new' })}
              className="rounded-md px-2.5 py-1 text-xs text-neutral-500 ring-1 ring-inset ring-neutral-800 hover:text-neutral-300"
            >
              Reset
            </button>
          ) : null}
        </div>

        <button
          disabled={rescore.isPending}
          onClick={() => rescore.mutate(job.id)}
          className="ml-auto rounded-md px-2.5 py-1 text-xs text-neutral-400 ring-1 ring-inset ring-neutral-800 hover:text-neutral-200 hover:ring-neutral-600 disabled:opacity-50"
        >
          {rescore.isPending ? 'Queued…' : 'Rescore'}
        </button>
      </div>

      {/* ---------- AI verdict ---------- */}
      <section className="rounded-xl border border-neutral-800 p-4">
        <h2 className="mb-3 text-sm font-semibold tracking-wide text-neutral-400 uppercase">
          AI match
        </h2>

        {job.scoreError ? (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            Scoring failed: {job.scoreError}
          </div>
        ) : job.matchReason ? (
          <div className="space-y-3">
            <p className="text-sm text-neutral-200">{job.matchReason}</p>

            {job.highlights.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium text-emerald-400">Highlights</p>
                <ul className="list-inside list-disc space-y-0.5 text-sm text-neutral-300">
                  {job.highlights.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {job.redFlags.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium text-rose-400">Red flags</p>
                <ul className="list-inside list-disc space-y-0.5 text-sm text-neutral-300">
                  {job.redFlags.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <p className="text-xs text-neutral-600">scored {formatDateTime(job.scoredAt)}</p>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-neutral-400">
            <span className="size-3.5 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-300" />
            Waiting for the scoring pipeline…
          </div>
        )}
      </section>

      {/* ---------- description ---------- */}
      <section className="rounded-xl border border-neutral-800 p-4">
        <h2 className="mb-3 text-sm font-semibold tracking-wide text-neutral-400 uppercase">
          Description
        </h2>
        {job.description ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-neutral-300">
            {job.description}
          </p>
        ) : (
          <p className="text-sm text-neutral-600">This source did not return a description.</p>
        )}
      </section>

      <p className="text-xs text-neutral-600">
        external id {job.externalId} · added {formatDateTime(job.createdAt)} · last updated{' '}
        {formatDateTime(job.updatedAt)}
      </p>
    </div>
  );
}
