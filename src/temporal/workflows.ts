// Runs inside Temporal's deterministic sandbox: only import from @temporalio/workflow (+ type-only imports).
import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { JobActivities } from './activities.js';

const quick = proxyActivities<JobActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

// source fetches hit external APIs -> generous timeout + exponential backoff
const fetcher = proxyActivities<JobActivities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '10 seconds',
    backoffCoefficient: 2,
    maximumInterval: '2 minutes',
    maximumAttempts: 4,
  },
});

export interface DailyJobSearchInput {
  profileId?: string; // omitted (scheduled run) -> all active profiles
}

/**
 * Daily flow:
 *   for each profile -> fetch every enabled source in parallel -> each activity publishes raw jobs to Kafka.
 * Dedupe + AI scoring happen downstream in the Kafka consumers, so the workflow stays small and
 * never carries job payloads in its history.
 */
export async function dailyJobSearchWorkflow(
  input: DailyJobSearchInput = {},
): Promise<void> {
  const profileIds = input.profileId
    ? [input.profileId]
    : await quick.listActiveProfileIds();
  const { workflowId } = workflowInfo();

  for (const profileId of profileIds) {
    const runId = await quick.startRun(profileId, workflowId);
    const sources = await quick.listSourcesFor(profileId);

    // one failing platform must not fail the whole run
    const results = await Promise.allSettled(
      sources.map((source) =>
        fetcher.fetchAndPublish({ runId, profileId, source }),
      ),
    );

    const stats: Record<string, { fetched: number; error?: string }> = {};
    results.forEach((r, i) => {
      stats[sources[i]] =
        r.status === 'fulfilled'
          ? { fetched: r.value.fetched }
          : {
              fetched: 0,
              error:
                r.reason instanceof Error ? r.reason.message : String(r.reason),
            };
    });

    await quick.finishRun(runId, stats);
  }
}
