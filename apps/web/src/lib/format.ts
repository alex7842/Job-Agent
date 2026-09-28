import type { JobStatus, RunStatus } from '@job-agent/shared';

/** Formats an ISO timestamp as a short local date ("12 Sep"), or an em dash. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "3h ago" / "2d ago" — jobs are mostly recent, so relative time reads better. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : formatDate(iso);
}

/** "248 KB" / "1.4 MB" — document sizes only, so no unit above MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A similarity, not a score.
 *
 * Rendered as a percentage because that is how cosine similarity reads to
 * someone deciding whether to apply — and explicitly *not* through `scoreClass`,
 * which is a ramp for the LLM's 0-100 verdict. Reusing it would imply the two
 * numbers are on the same scale, which they are not.
 */
export function semanticPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

const JOB_STATUS_STYLES: Record<JobStatus, string> = {
  new: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  saved: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  applied: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  ignored: 'bg-neutral-500/15 text-neutral-400 ring-neutral-500/30',
};

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  new: 'New',
  saved: 'Saved',
  applied: 'Applied',
  ignored: 'Ignored',
};

export function jobStatusClass(status: JobStatus): string {
  return JOB_STATUS_STYLES[status] ?? JOB_STATUS_STYLES.new;
}

const RUN_STATUS_STYLES: Record<RunStatus, string> = {
  running: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  completed: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  partial: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  failed: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
};

export function runStatusClass(status: RunStatus): string {
  return RUN_STATUS_STYLES[status] ?? RUN_STATUS_STYLES.running;
}

/** Tailwind needs literal class names, so the score ramp is spelled out. */
export function scoreClass(score: number): string {
  if (score >= 85) return 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30';
  if (score >= 65) return 'bg-lime-500/15 text-lime-300 ring-lime-500/30';
  if (score >= 40) return 'bg-amber-500/15 text-amber-300 ring-amber-500/30';
  return 'bg-rose-500/15 text-rose-300 ring-rose-500/30';
}
