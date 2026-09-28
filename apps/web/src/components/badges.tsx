import type { ReactNode } from 'react';
import { Badge, cx } from './ui';
import { JOB_STATUS_LABEL, jobStatusClass, scoreClass, semanticPercent } from '@/lib/format';
import type { JobStatus } from '@job-agent/shared';

export function ScoreBadge({ score, pending }: { score: number | null; pending?: boolean }) {
  if (score === null || score === undefined) {
    return (
      <Badge className="bg-neutral-500/10 text-neutral-400 ring-neutral-600/40">
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
      <Badge className="bg-neutral-500/10 text-neutral-500 ring-neutral-600/30">ranking…</Badge>
    ) : null;
  }
  return (
    <Badge
      className="font-mono tabular-nums bg-indigo-500/10 text-indigo-300 ring-indigo-500/30"
      title={
        rank
          ? `Semantic similarity to your documents — rank #${rank} of the postings found`
          : 'Semantic similarity to your documents'
      }
    >
      {semanticPercent(score)}
      {rank ? <span className="ml-1 text-indigo-400/70">#{rank}</span> : null}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: JobStatus }) {
  return <Badge className={jobStatusClass(status)}>{JOB_STATUS_LABEL[status]}</Badge>;
}

/** Small pill used for the "remote / location / salary" metadata line. */
export function MetaPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-neutral-800/70 px-1.5 py-0.5 text-xs text-neutral-300">
      {children}
    </span>
  );
}
