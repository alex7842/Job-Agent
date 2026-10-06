import type { ReactNode } from 'react';
import type { AdminChainStatus, AdminOverview } from '@job-agent/shared';
import { useAdminOverview } from '@/lib/queries';
import { formatDateTime, formatRelative, runStatusClass } from '@/lib/format';
import { ScoreBadge } from '@/components/badges';
import { Badge, Card, CardSection, ErrorNote, Spinner, cx } from '@/components/ui';

/**
 * Cross-profile system health.
 *
 * Read-only by design: the API exposes aggregates, not a handle on any single
 * profile, so there is nothing here to act on beyond "is something stuck". The
 * page polls every 10s (see `useAdminOverview`) because the numbers worth
 * watching — a score backlog draining, a fallback taking over — are only visible
 * as they move.
 *
 * A 403 here means the viewer's email left ADMIN_EMAILS. That is terminal for the
 * session, and the query stops retrying, so the page explains it rather than
 * sitting in a failure loop.
 */

/** One number, with the unit spelled out so a column of tiles reads on its own. */
function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'neutral' | 'warn' | 'danger' | 'success';
}) {
  const valueTone = {
    neutral: 'text-fg',
    success: 'text-success',
    warn: 'text-warn',
    danger: 'text-danger',
  }[tone];
  const zero = value === 0;

  return (
    <Card className="p-4">
      <p className="text-xs font-medium tracking-wide text-subtle uppercase">{label}</p>
      <p className={cx('mt-1.5 font-mono text-2xl font-semibold tabular-nums', valueTone)}>
        {/* A zero of "failed" or "stuck" is good news, so it must not wear the
            same red as a zero of "failed" on a source. */}
        {zero && tone !== 'neutral' ? '0' : value}
      </p>
      {hint ? <p className="mt-1 text-xs text-subtle">{hint}</p> : null}
    </Card>
  );
}

/** A labelled figure inside a card body, for values too small for a tile. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 text-right font-medium text-fg">{children}</span>
    </div>
  );
}

/** Milliseconds as "45s" / "2m 10s", for the failover cooldown. */
function duration(ms: number): string {
  if (ms <= 0) return 'ready';
  const secs = Math.round(ms / 1000);
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/**
 * The live failover chain.
 *
 * `active` is called out separately from `configured` because after a rate limit
 * the primary is parked and the fallback answers — showing only the configured
 * model would report the wrong one during exactly the incident this page exists
 * to explain.
 */
function ChainStatus({ status }: { status: AdminChainStatus | null }) {
  if (!status) {
    return (
      <p className="text-xs text-subtle">
        No fallback configured, so the primary answers every request on its own.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {status.primaryParked ? (
        <div className="rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-xs text-warn">
          The primary is parked after a rate limit and comes back in{' '}
          {duration(status.cooldownRemainingMs)}.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge className="bg-accent-soft text-accent ring-accent/30">
          {status.servedByPrimary} from {status.chain[0]?.provider ?? 'primary'}
        </Badge>
        {status.servedByFallback > 0 ? (
          <Badge className="bg-warn-bg text-warn ring-warn/30">
            {status.servedByFallback} from fallback
          </Badge>
        ) : null}
        {status.failed > 0 ? (
          <Badge className="bg-danger-bg text-danger ring-danger/30">{status.failed} failed</Badge>
        ) : null}
      </div>

      <ul className="divide-y divide-line text-sm">
        {status.chain.map((attempt) => (
          <li key={`${attempt.provider}-${attempt.model}`} className="flex items-center gap-3 py-2">
            <Badge
              className={
                attempt.served
                  ? 'bg-success-bg text-success ring-success/30'
                  : attempt.ok
                    ? 'bg-surface-3 text-muted ring-line'
                    : 'bg-danger-bg text-danger ring-danger/30'
              }
              title={attempt.error ?? undefined}
            >
              {attempt.served ? 'serving' : attempt.ok ? 'idle' : 'failing'}
            </Badge>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-fg">{attempt.provider}</span>
              <span className="block truncate font-mono text-xs text-subtle">{attempt.model}</span>
            </span>
            <span className="shrink-0 font-mono text-xs text-subtle tabular-nums">
              {attempt.ms}ms
            </span>
          </li>
        ))}
      </ul>

      {Object.entries(status.failovers).some(([, n]) => n > 0) ? (
        <p className="text-xs text-subtle">
          Failovers so far:{' '}
          {Object.entries(status.failovers)
            .filter(([, n]) => n > 0)
            .map(([provider, n]) => `${n} × ${provider}`)
            .join(', ')}
          .
        </p>
      ) : null}
    </div>
  );
}

function ModelsPanel({ models }: { models: AdminOverview['models'] }) {
  const { scoring, embeddings } = models;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <CardSection
        title="Scoring"
        hint="Which provider answers the next score, and what each one in the chain last did."
        icon={
          <svg
            viewBox="0 0 24 24"
            fill="none"
            className="size-4"
            stroke="currentColor"
            strokeWidth="1.7"
          >
            <circle cx="12" cy="12" r="8" />
            <path d="M12 8v4l3 2" strokeLinecap="round" />
          </svg>
        }
      >
        <div className="space-y-3">
          <Row label="Chain">
            <span className="font-mono text-xs">{scoring.configured.join(' → ')}</span>
          </Row>
          <Row label="Configured model">
            <span className="font-mono text-xs">{scoring.model || '—'}</span>
          </Row>
          <Row label="Answering now">
            <Badge className="bg-accent-soft text-accent ring-accent/30">
              {scoring.active.provider} · {scoring.active.model}
            </Badge>
          </Row>
          <div className="border-t border-line pt-3">
            <ChainStatus status={scoring.status} />
          </div>
        </div>
      </CardSection>

      <div className="space-y-4">
        <CardSection
          title="Resume parsing"
          hint="A separate chain from scoring, since parsing a CV is a different job."
          icon={
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="size-4"
              stroke="currentColor"
              strokeWidth="1.7"
            >
              <path d="M6 3h8l4 4v14H6z" strokeLinejoin="round" />
              <path d="M14 3v4h4M9 12h6M9 16h6" strokeLinecap="round" />
            </svg>
          }
        >
          <div className="space-y-1.5">
            <Row label="Chain">
              <span className="font-mono text-xs">
                {scoring.resumeParsing.configured.join(' → ') || '—'}
              </span>
            </Row>
            <Row label="Model">
              <span className="font-mono text-xs">{scoring.resumeParsing.model || '—'}</span>
            </Row>
          </div>
        </CardSection>

        <CardSection
          title="Embeddings"
          hint={
            embeddings.available
              ? 'Reported by the RAG service, which is the process that holds the model.'
              : (embeddings.reason ?? 'The RAG service is not answering.')
          }
          icon={
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="size-4"
              stroke="currentColor"
              strokeWidth="1.7"
            >
              <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z" strokeLinejoin="round" />
              <path d="M12 12v9M4 7.5 12 12l8-4.5" strokeLinejoin="round" />
            </svg>
          }
        >
          <div className="space-y-1.5">
            <Row label="Status">
              <Badge
                className={
                  embeddings.available
                    ? embeddings.degraded
                      ? 'bg-warn-bg text-warn ring-warn/30'
                      : 'bg-success-bg text-success ring-success/30'
                    : 'bg-danger-bg text-danger ring-danger/30'
                }
              >
                {!embeddings.available ? 'unavailable' : embeddings.degraded ? 'degraded' : 'ok'}
              </Badge>
            </Row>
            <Row label="Model">
              <span className="font-mono text-xs">{embeddings.model ?? '—'}</span>
            </Row>
            <Row label="Vector store">
              <span className="font-mono text-xs">{embeddings.vectorStore ?? '—'}</span>
            </Row>
          </div>
        </CardSection>
      </div>
    </div>
  );
}

/**
 * Sources, most useful as a list of what is *not* running.
 *
 * A disabled source is almost always a missing key or an unsubscribed RapidAPI
 * plan, and it is silent everywhere else in the product: the run simply comes
 * back with fewer postings.
 */
function SourcesPanel({ sources }: { sources: AdminOverview['sources'] }) {
  const disabled = sources.filter((s) => !s.enabled);

  return (
    <CardSection
      title="Job sources"
      hint={
        disabled.length === 0
          ? 'Every configured source answered the last run.'
          : `${disabled.length} of ${sources.length} switched off — no key, or a key not subscribed to that API.`
      }
      icon={
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className="size-4"
          stroke="currentColor"
          strokeWidth="1.7"
        >
          <circle cx="12" cy="12" r="8" />
          <path d="M4 12h16M12 4c2.5 2.6 2.5 13.4 0 16M12 4c-2.5 2.6-2.5 13.4 0 16" />
        </svg>
      }
    >
      <div className="flex flex-wrap gap-2">
        {sources.map((source) => (
          <Badge
            key={source.name}
            className={
              source.enabled
                ? 'bg-success-bg text-success ring-success/30'
                : 'bg-ignored-bg text-ignored ring-line'
            }
            title={source.enabled ? undefined : 'Disabled — check its API key'}
          >
            {source.name}
            <span className="font-mono opacity-70">{source.enabled ? 'on' : 'off'}</span>
          </Badge>
        ))}
        {sources.length === 0 ? <p className="text-xs text-subtle">No source registered.</p> : null}
      </div>
    </CardSection>
  );
}

/**
 * Scoring failures, deduplicated server-side.
 *
 * Shown as "what is breaking, and how often" rather than a list of rows: the
 * same provider error repeats on every job in a run, and one line with a count is
 * the actionable form of it.
 */
function FailuresPanel({ failures }: { failures: AdminOverview['scoreFailures'] }) {
  return (
    <CardSection
      title="Scoring failures"
      hint="Distinct messages across every profile, most frequent first. Each row is a job that has no score and will not get one until the cause is fixed."
      icon={
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className="size-4"
          stroke="currentColor"
          strokeWidth="1.7"
        >
          <path d="M12 4 2.5 20h19z" strokeLinejoin="round" />
          <path d="M12 10v4.5" strokeLinecap="round" />
          <circle cx="12" cy="17" r="0.6" fill="currentColor" />
        </svg>
      }
    >
      {failures.length === 0 ? (
        <p className="text-sm text-subtle">Nothing has failed to score.</p>
      ) : (
        <ul className="divide-y divide-line">
          {failures.map((failure) => (
            <li key={failure.error} className="flex items-start gap-3 py-2.5">
              <Badge className="shrink-0 bg-danger-bg font-mono text-danger ring-danger/30">
                {failure.count}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="font-mono text-xs leading-relaxed break-words text-fg">
                  {failure.error}
                </p>
                <p className="mt-0.5 text-xs text-subtle">
                  last seen {formatRelative(failure.latest)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </CardSection>
  );
}

/**
 * Run status styling, with a plain fallback.
 *
 * `recentRuns[].status` is typed as a bare string because it crosses the wire
 * unvalidated, so an unknown value from an older schema must render as neutral
 * rather than crash the page on a lookup into the run-status map.
 */
const RUN_STATUSES = new Set(['running', 'completed', 'partial', 'failed']);

function runBadge(status: string): string {
  return RUN_STATUSES.has(status)
    ? runStatusClass(status as Parameters<typeof runStatusClass>[0])
    : 'bg-surface-3 text-muted ring-line';
}

function ActivityPanel({ system }: { system: AdminOverview['system'] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <CardSection title="Recent runs" hint="Newest first.">
        {system.recentRuns.length === 0 ? (
          <p className="text-sm text-subtle">No run yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {system.recentRuns.map((run) => (
              <li key={run.id} className="py-2.5">
                <div className="flex items-center gap-2">
                  <Badge className={runBadge(run.status)}>{run.status}</Badge>
                  <span className="text-xs text-subtle">
                    {formatRelative(run.startedAt)}
                    {run.finishedAt ? ` · ${formatDateTime(run.finishedAt)}` : ''}
                  </span>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-subtle">{run.workflowId}</p>
              </li>
            ))}
          </ul>
        )}
      </CardSection>

      <CardSection title="Recent postings" hint="Newest first, across all profiles.">
        {system.recentJobs.length === 0 ? (
          <p className="text-sm text-subtle">No posting yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {system.recentJobs.map((job) => (
              <li key={job.id} className="flex items-center gap-3 py-2.5">
                <ScoreBadge score={job.matchScore} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{job.title}</p>
                  <p className="truncate text-xs text-subtle">
                    {job.company} · <span className="font-mono">{job.source}</span>
                  </p>
                </div>
                <span className="shrink-0 text-xs text-subtle">
                  {formatRelative(job.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardSection>
    </div>
  );
}

export function AdminPage() {
  const { data, isPending, isError, error, dataUpdatedAt } = useAdminOverview();
  const forbidden = (error as { status?: number } | null)?.status === 403;

  if (forbidden) {
    return (
      <div className="py-20 text-center">
        <p className="text-sm font-medium text-fg">This page is for administrators.</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-subtle">
          Your account is signed in, but its email is not in the API&apos;s ADMIN_EMAILS list. Add
          it there and restart the API to get access.
        </p>
      </div>
    );
  }

  if (isPending) return <Spinner label="Loading system health" />;
  if (isError) return <ErrorNote error={error} />;
  if (!data) return null;

  const { system, models, sources, scoreFailures } = data;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">System</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            Cross-profile health for the whole deployment — every user&apos;s jobs and runs, not
            just yours. Read-only, and refreshed every 10 seconds.
          </p>
        </div>
        <p className="text-xs text-subtle">
          signed in as {data.viewer.email} · updated{' '}
          {formatRelative(new Date(dataUpdatedAt).toISOString())}
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Postings"
          value={system.jobs.total}
          hint={`${system.users.total} users · ${system.users.profiles} profiles`}
        />
        {/* "Awaiting" is work in flight; "failed" is work that will never finish
            on its own. Collapsing them into one pending count is what made a
            broken pipeline look like a busy one. */}
        <Stat
          label="Awaiting score"
          value={system.jobs.awaitingScore}
          tone={system.jobs.awaitingScore > 50 ? 'warn' : 'neutral'}
          hint="in flight through the scoring chain"
        />
        <Stat
          label="Score failed"
          value={system.jobs.scoreFailed}
          tone={system.jobs.scoreFailed > 0 ? 'danger' : 'success'}
          hint={system.jobs.scoreFailed > 0 ? 'see failures below' : 'nothing is stuck'}
        />
        <Stat
          label="Outbox pending"
          value={system.outbox.pending}
          tone={system.outbox.stuck > 0 ? 'danger' : 'neutral'}
          hint={
            system.outbox.stuck > 0 ? `${system.outbox.stuck} stuck over 5 min` : 'Kafka events'
          }
        />
      </div>

      <ModelsPanel models={models} />

      <SourcesPanel sources={sources} />

      <FailuresPanel failures={scoreFailures} />

      <ActivityPanel system={system} />
    </div>
  );
}
