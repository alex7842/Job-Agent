import {
  useProfile,
  useRankRunSemantically,
  useRuns,
  useSemanticStatus,
  useTriggerRun,
} from '@/lib/queries';
import { formatDateTime, runStatusClass } from '@/lib/format';
import { Badge, EmptyState, ErrorNote, Spinner } from '@/components/ui';

export function RunsPage() {
  const { data: runs, isPending, isError, error } = useRuns();
  const { data: profile } = useProfile();
  const trigger = useTriggerRun();
  const rank = useRankRunSemantically();
  const { data: semantic } = useSemanticStatus();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-800 px-4 py-3">
        <div>
          <h1 className="text-sm font-medium text-neutral-100">Search runs</h1>
          <p className="text-xs text-neutral-500">
            A run starts the same Temporal workflow the daily cron schedule starts.
            {profile ? ` Runs for profile "${profile.name}".` : ''}
          </p>
        </div>
        <button
          disabled={trigger.isPending}
          onClick={() => trigger.mutate()}
          className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 transition hover:bg-white disabled:opacity-50"
        >
          {trigger.isPending ? 'Starting…' : 'Search now'}
        </button>
      </div>

      {trigger.isError ? <ErrorNote error={trigger.error} /> : null}
      {rank.isError ? <ErrorNote error={rank.error} /> : null}
      {trigger.isSuccess ? (
        <p className="text-xs text-emerald-400">
          Workflow started ({trigger.data.workflowId}). New jobs appear in the list as the pipeline
          runs.
        </p>
      ) : null}

      {isError ? <ErrorNote error={error} /> : null}
      {isPending ? <Spinner label="Loading runs" /> : null}

      {runs && runs.length === 0 ? (
        <EmptyState title="No runs yet." hint="Click “Search now” to start one." />
      ) : null}

      {runs && runs.length > 0 ? (
        <ul className="divide-y divide-neutral-900 overflow-hidden rounded-xl border border-neutral-800">
          {runs.map((run) => (
            <li key={run.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-neutral-400">{run.workflowId}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    started {formatDateTime(run.startedAt)}
                    {run.finishedAt ? ` · finished ${formatDateTime(run.finishedAt)}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge className={runStatusClass(run.status)}>{run.status}</Badge>
                  {/* Manual retry for the automatic ranking that runs at the end
                      of a run: needed when the postings finished indexing after
                      the workflow had already given up waiting for them. */}
                  <button
                    disabled={rank.isPending || semantic?.enabled === false}
                    onClick={() => rank.mutate(run.id)}
                    title="Compare this run's postings against your documents"
                    className="rounded-md border border-neutral-800 px-2 py-1 text-xs text-neutral-400 transition hover:border-neutral-700 hover:text-neutral-200 disabled:opacity-40"
                  >
                    {rank.isPending && rank.variables === run.id ? 'Ranking…' : 'Re-rank'}
                  </button>
                </div>
              </div>

              {Object.keys(run.stats).length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(run.stats).map(([source, stat]) => (
                    <li key={source}>
                      <Badge
                        title={stat.error}
                        className={
                          stat.error
                            ? 'bg-rose-500/10 text-rose-300 ring-rose-500/30'
                            : 'bg-neutral-800/70 text-neutral-300 ring-neutral-700'
                        }
                      >
                        {source}: {stat.error ? 'failed' : stat.fetched}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
