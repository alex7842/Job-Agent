import type { CSSProperties, ReactNode } from 'react';
import { Badge, cx } from './ui';
import { JOB_STATUS_LABEL, jobStatusClass, scoreClass, semanticPercent } from '@/lib/format';
import type { JobStatus } from '@job-agent/shared';

export function ScoreBadge({ score, pending }: { score: number | null; pending?: boolean }) {
  if (score === null || score === undefined) {
    return (
      <Badge className="bg-ignored-bg text-ignored ring-line">
        {pending ? 'scoring…' : 'unscored'}
      </Badge>
    );
  }
  return <Badge className={cx('font-mono tabular-nums', scoreClass(score))}>{score}</Badge>;
}

/**
 * Vector similarity, shown as a percentage and a rank.
 *
 * Visually distinct from `ScoreBadge` on purpose: the LLM's verdict and the
 * vector score are independent numbers, and styling them the same would invite
 * reading them as one combined judgement. A null score means the posting has not
 * been ranked yet, which is normal right after a run.
 */
export function SemanticBadge({
  score,
  rank,
  pending,
}: {
  score: number | null;
  rank?: number | null;
  pending?: boolean;
}) {
  if (score === null || score === undefined) {
    return pending ? (
      <Badge className="bg-ignored-bg text-ignored ring-line">ranking…</Badge>
    ) : null;
  }
  return (
    <Badge
      className="bg-semantic-bg font-mono tabular-nums text-semantic ring-semantic/30"
      title={
        rank
          ? `Semantic similarity to your resume — rank #${rank} of the postings found`
          : 'Semantic similarity to your resume'
      }
    >
      {semanticPercent(score)}
      {rank ? <span className="ml-0.5 opacity-60">#{rank}</span> : null}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: JobStatus }) {
  return <Badge className={jobStatusClass(status)}>{JOB_STATUS_LABEL[status]}</Badge>;
}

/** Small pill used for the "remote / location / salary" metadata line. */
export function MetaPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-xs font-medium text-muted">
      {children}
    </span>
  );
}

/** The source a posting came from, in a quieter pill than the metadata. */
export function SourceBadge({ source }: { source: string }) {
  return (
    <span className="font-mono text-[0.6875rem] tracking-tight text-subtle uppercase">
      {source}
    </span>
  );
}

/**
 * Two-letter monogram from the company name.
 *
 * Stands in for a logo: the API stores no logo URL, and fetching one from a
 * third party would leak the user's browsing to that host.
 */
export function CompanyMark({ company, className }: { company: string; className?: string }) {
  const initials = company
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');

  // Deterministic hue from the name, so the same company keeps the same tile.
  const hue = [...company].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 360, 7);

  return (
    <span
      aria-hidden="true"
      // oklch has no theme-conditional form, so the dark pair is carried as
      // custom properties and swapped by the `dark:` utilities below.
      style={
        {
          background: `oklch(95% 0.03 ${hue})`,
          color: `oklch(45% 0.14 ${hue})`,
          '--mark-dark-bg': `oklch(28% 0.05 ${hue})`,
          '--mark-dark-fg': `oklch(82% 0.11 ${hue})`,
        } as CSSProperties
      }
      className={cx(
        'grid shrink-0 place-items-center rounded-xl text-sm font-bold dark:bg-(--mark-dark-bg) dark:text-(--mark-dark-fg)',
        className ?? 'size-11',
      )}
    >
      {initials || '?'}
    </span>
  );
}
