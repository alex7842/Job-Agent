import type { ReactNode } from 'react';
import { Badge, cx } from './ui';
import { JOB_STATUS_LABEL, jobStatusClass, scoreClass } from '@/lib/format';
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
