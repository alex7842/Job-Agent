import { Link, useParams } from 'react-router';
import { type JobStatus } from '@job-agent/shared';
import { useJob, useRescoreJob, useSetJobStatus } from '@/lib/queries';
import { formatDateTime, formatRelative, scoreLabel } from '@/lib/format';
import {
  CompanyMark,
  MetaPill,
  ScoreBadge,
  SemanticBadge,
  SourceBadge,
  StatusBadge,
} from '@/components/badges';
import { Button, Card, CardSection, ErrorNote, Notice, Spinner, cx } from '@/components/ui';

const REVIEW_ACTIONS: { status: JobStatus; label: string; active: string }[] = [
  { status: 'saved', label: 'Save', active: 'bg-saved-bg text-saved ring-saved/40' },
  {
    status: 'applied',
    label: 'Mark applied',
    active: 'bg-applied-bg text-applied ring-applied/40',
  },
  { status: 'ignored', label: 'Ignore', active: 'bg-ignored-bg text-ignored ring-line-strong' },
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
    <div className="space-y-6">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-subtle transition-colors hover:text-fg"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className="size-3.5"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M14 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back to jobs
      </Link>

      {/* ---------- header ---------- */}
      <Card className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-linear-to-br from-accent/8 via-transparent to-transparent"
        />
        <div className="relative flex flex-wrap items-start justify-between gap-5 p-6">
          <div className="flex min-w-0 gap-4">
            <CompanyMark company={job.company} className="size-14 text-lg" />
            <div className="min-w-0">
              <h1 className="text-xl leading-snug font-semibold tracking-tight text-balance text-fg">
                {job.title}
              </h1>
              <p className="mt-1 text-sm text-muted">{job.company}</p>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <SourceBadge source={job.source} />
                {job.remote ? <MetaPill>Remote</MetaPill> : null}
                {job.location ? <MetaPill>{job.location}</MetaPill> : null}
                {job.salaryText ? <MetaPill>{job.salaryText}</MetaPill> : null}
                <MetaPill>posted {formatRelative(job.postedAt)}</MetaPill>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ScoreBadge score={job.matchScore} pending />
            <a
              href={job.applyUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-fg shadow-soft transition-colors hover:bg-accent-hover"
            >
              Apply
              <svg
                viewBox="0 0 24 24"
                fill="none"
                className="size-3.5"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M8 16 16 8m0 0h-6m6 0v6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          </div>
        </div>
      </Card>

      {/* ---------- review actions ---------- */}
      <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
        <StatusBadge status={job.status} />
        <div className="flex flex-wrap gap-1.5">
          {REVIEW_ACTIONS.map((action) => (
            <button
              key={action.status}
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate({ id: job.id, status: action.status })}
              className={cx(
                'rounded-lg px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition disabled:opacity-50',
                job.status === action.status
                  ? action.active
                  : 'text-muted ring-line hover:bg-surface-3 hover:text-fg',
              )}
            >
              {action.label}
            </button>
          ))}
          {job.status !== 'new' ? (
            <button
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate({ id: job.id, status: 'new' })}
              className="rounded-lg px-2.5 py-1 text-xs text-subtle ring-1 ring-inset ring-line transition hover:text-muted"
            >
              Reset
            </button>
          ) : null}
        </div>

        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          loading={rescore.isPending}
          onClick={() => rescore.mutate(job.id)}
          title="Queue this posting for the model to score again"
        >
          Rescore
        </Button>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          {/* ---------- AI verdict ---------- */}
          <CardSection
            title="AI match"
            hint="The model's verdict after reading your resume and the posting."
            icon={
              <svg
                viewBox="0 0 24 24"
                fill="none"
                className="size-4"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M12 4v3m0 10v3M4 12h3m10 0h3" strokeLinecap="round" />
                <circle cx="12" cy="12" r="3.5" />
              </svg>
            }
            actions={<ScoreBadge score={job.matchScore} pending />}
          >
            {job.scoreError ? (
              <Notice tone="warn">
                Scoring failed: {job.scoreError}. Rescore it above to try again.
              </Notice>
            ) : job.matchReason ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <span className="text-2xl font-semibold text-fg tabular-nums">
                    {job.matchScore}
                  </span>
                  <span className="text-sm text-muted">{scoreLabel(job.matchScore)}</span>
                </div>
                <p className="text-sm leading-relaxed text-fg">{job.matchReason}</p>

                {job.highlights.length > 0 ? (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-success">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        className="size-3.5"
                        stroke="currentColor"
                        strokeWidth="2.4"
                      >
                        <path d="m5 13 4 4 10-10" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      Highlights
                    </p>
                    <ul className="space-y-1 text-sm text-muted">
                      {job.highlights.map((h) => (
                        <li key={h} className="flex gap-2">
                          <span className="mt-2 size-1 shrink-0 rounded-full bg-success" />
                          {h}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {job.redFlags.length > 0 ? (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-danger">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        className="size-3.5"
                        stroke="currentColor"
                        strokeWidth="2.4"
                      >
                        <path d="M12 8v5m0 3.5v.5" strokeLinecap="round" />
                        <circle cx="12" cy="12" r="8.5" />
                      </svg>
                      Red flags
                    </p>
                    <ul className="space-y-1 text-sm text-muted">
                      {job.redFlags.map((f) => (
                        <li key={f} className="flex gap-2">
                          <span className="mt-2 size-1 shrink-0 rounded-full bg-danger" />
                          {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <p className="text-xs text-subtle">scored {formatDateTime(job.scoredAt)}</p>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-subtle">
                <span className="size-3.5 animate-spin rounded-full border-2 border-line border-t-muted" />
                Waiting for the scoring pipeline…
              </div>
            )}
          </CardSection>

          {/* ---------- description ---------- */}
          <CardSection
            title="Description"
            actions={
              <a
                href={job.applyUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs font-medium text-accent hover:underline"
              >
                Open original ↗
              </a>
            }
          >
            {job.description ? (
              <p className="max-w-none text-sm leading-relaxed whitespace-pre-wrap text-muted">
                {job.description}
              </p>
            ) : (
              <p className="text-sm text-subtle">This source did not return a description.</p>
            )}
          </CardSection>
        </div>

        {/* ---------- sidebar ---------- */}
        <aside className="space-y-6">
          {/* ---------- semantic match ---------- */}
          <CardSection
            title="Semantic match"
            hint="Similarity to your resume, from the vector index. Independent of the score above."
            icon={
              <svg
                viewBox="0 0 24 24"
                fill="none"
                className="size-4"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <circle cx="12" cy="12" r="8.5" strokeDasharray="3 3" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            }
            actions={<SemanticBadge score={job.semanticScore} rank={job.semanticRank} />}
          >
            {job.semanticSnippet ? (
              <div className="space-y-2">
                {/* The passage that matched, so the percentage is evidence rather
                    than a verdict. The label says which corpus it came from,
                    because the snippet can be either the posting or the resume. */}
                <p className="text-xs text-subtle">
                  {/* The corpus is postings, so the passage is always the job's
                      own text: what this shows is which part of the posting
                      matched the resume or target roles it was compared against. */}
                  Passage from this posting that matched your resume
                  {job.semanticAt ? ` · ranked ${formatDateTime(job.semanticAt)}` : ''}
                </p>
                <p className="border-l-2 border-semantic/40 pl-3 text-sm leading-relaxed text-muted italic">
                  {job.semanticSnippet}
                </p>
              </div>
            ) : (
              <p className="text-sm text-subtle">
                No semantic score yet. It appears once a run has indexed this posting and compared
                it to your resume.
              </p>
            )}
          </CardSection>

          <Card className="p-5">
            <p className="text-xs leading-relaxed text-subtle">
              external id <span className="font-mono">{job.externalId}</span>
              <br />
              added {formatDateTime(job.createdAt)}
              <br />
              last updated {formatDateTime(job.updatedAt)}
            </p>
          </Card>
        </aside>
      </div>
    </div>
  );
}
