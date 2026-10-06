import { Link } from 'react-router';
import type { JobListItem } from '@job-agent/shared';
import {
  CompanyMark,
  MetaPill,
  ScoreBadge,
  SemanticBadge,
  SourceBadge,
  StatusBadge,
} from './badges';
import { Button, Card, EmptyState, cx } from './ui';
import { formatDate, formatRelative, scoreLabel } from '@/lib/format';

/** Shared meta row so the card and the list agree on what a posting shows. */
function Meta({ job }: { job: JobListItem }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <SourceBadge source={job.source} />
      {job.remote ? <MetaPill>Remote</MetaPill> : null}
      {job.location ? <MetaPill>{job.location}</MetaPill> : null}
      {job.salaryText ? <MetaPill>{job.salaryText}</MetaPill> : null}
    </div>
  );
}

/** The badges block — right-aligned on a row, top-right on a card. */
function Scores({
  job,
  semanticPending,
  className,
}: {
  job: JobListItem;
  semanticPending: boolean;
  className?: string;
}) {
  return (
    <div className={cx('flex shrink-0 items-center gap-1.5', className)}>
      <StatusBadge status={job.status} />
      <ScoreBadge score={job.matchScore} pending />
      <SemanticBadge score={job.semanticScore} rank={job.semanticRank} pending={semanticPending} />
    </div>
  );
}

/**
 * Compact row for list view.
 *
 * The score group is pinned to the right edge so the eye can scan a column of
 * numbers down the page instead of reading each row end-to-end.
 */
export function JobRow({ job, semanticPending }: { job: JobListItem; semanticPending: boolean }) {
  return (
    <Link
      to={`/jobs/${job.id}`}
      className="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-surface-2"
    >
      <CompanyMark company={job.company} className="size-9 rounded-lg text-xs" />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="truncate text-sm font-semibold text-fg group-hover:text-accent">
            {job.title}
          </p>
          <span className="hidden shrink-0 text-xs text-subtle sm:inline">
            {formatRelative(job.postedAt)}
          </span>
        </div>
        <p className="truncate text-xs text-muted">{job.company}</p>
      </div>

      <div className="hidden min-w-0 shrink-0 lg:block lg:w-52">
        <Meta job={job} />
      </div>

      <Scores job={job} semanticPending={semanticPending} className="w-44 justify-end" />
    </Link>
  );
}

/** Roomier card for grid view: score, reason and the matching passage. */
export function JobCard({ job, semanticPending }: { job: JobListItem; semanticPending: boolean }) {
  return (
    <Card
      as="article"
      className="group relative flex flex-col overflow-hidden transition-shadow hover:shadow-lift"
    >
      {/* Focus ring drawn on the card itself, not the link, so the whole tile lights up. */}
      <span className="pointer-events-none absolute inset-0 rounded-card ring-2 ring-accent ring-inset opacity-0 transition-opacity group-focus-within:opacity-100" />

      <Link to={`/jobs/${job.id}`} className="flex flex-1 flex-col p-5">
        <div className="flex items-start gap-3">
          <CompanyMark company={job.company} />
          <div className="min-w-0 flex-1">
            <h3 className="line-clamp-2 text-sm leading-snug font-semibold text-fg transition-colors group-hover:text-accent">
              {job.title}
            </h3>
            <p className="mt-0.5 truncate text-sm text-muted">{job.company}</p>
          </div>
          <ScoreBadge score={job.matchScore} pending />
        </div>

        <div className="mt-3">
          <Meta job={job} />
        </div>

        {job.matchReason ? (
          <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-muted">{job.matchReason}</p>
        ) : null}

        {/* The passage that matched, so the number above is not a black box. */}
        {job.semanticSnippet ? (
          <p className="mt-3 line-clamp-2 border-l-2 border-semantic/40 pl-2.5 text-xs leading-relaxed text-subtle italic">
            {job.semanticSnippet}
          </p>
        ) : null}

        {/* A failed score is otherwise invisible: the badge says "unscored" and
            nothing says why. Open the job to retry it. */}
        {job.scoreError ? (
          <p className="mt-2.5 line-clamp-2 text-xs text-warn">scoring failed: {job.scoreError}</p>
        ) : null}

        <div className="mt-auto flex items-center justify-between gap-2 pt-4">
          <SemanticBadge
            score={job.semanticScore}
            rank={job.semanticRank}
            pending={semanticPending}
          />
          <span className="text-xs text-subtle">
            {job.matchScore != null ? scoreLabel(job.matchScore) : 'awaiting score'} ·{' '}
            {formatRelative(job.postedAt)}
          </span>
        </div>
      </Link>

      <div className="flex items-center justify-between gap-2 border-t border-line bg-surface-2/60 px-5 py-2.5">
        <StatusBadge status={job.status} />
        <span className="text-[0.6875rem] text-subtle">added {formatDate(job.createdAt)}</span>
      </div>
    </Card>
  );
}

export function JobsEmpty({
  filtered,
  onClear,
  onSearch,
}: {
  filtered: boolean;
  onClear?: () => void;
  onSearch?: () => void;
}) {
  return (
    <EmptyState
      title={filtered ? 'No jobs match these filters.' : 'No jobs here yet.'}
      hint={
        filtered
          ? 'Try clearing a filter, or lower the minimum score.'
          : 'Start a search and new postings will land here as the pipeline runs.'
      }
      icon={
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className="size-6"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="M3 7h18M3 12h18M3 17h12" strokeLinecap="round" />
        </svg>
      }
      action={
        filtered ? (
          <Button variant="secondary" onClick={onClear}>
            Clear filters
          </Button>
        ) : onSearch ? (
          <Button variant="primary" onClick={onSearch}>
            Search now
          </Button>
        ) : undefined
      }
    />
  );
}
