import { TOPICS, type RawJobEvent, type RunStats } from '@job-agent/shared';
import { JobsService } from '../jobs/jobs.service.js';
import { SourcesRegistry } from '../jobs/sources/sources.registry.js';
import { KafkaProducerService } from '../kafka/kafka-producer.service.js';
import { ProfileService } from '../profile/profile.service.js';

export interface ActivityDeps {
  profiles: ProfileService;
  jobs: JobsService;
  sources: SourcesRegistry;
  producer: KafkaProducerService;
}

/** Factory (not a class) so Temporal gets plain functions; Nest services are injected by worker.ts. */
export function createActivities({ profiles, jobs, sources, producer }: ActivityDeps) {
  return {
    async listActiveProfileIds(): Promise<string[]> {
      return (await profiles.listActive()).map((p) => p.id);
    },

    async startRun(profileId: string, workflowId: string): Promise<string> {
      return jobs.createRun(profileId, workflowId);
    },

    async listSourcesFor(profileId: string): Promise<string[]> {
      return sources.enabledFor(await profiles.getById(profileId));
    },

    /** Fetch one platform and push every job to Kafka (jobs.raw). Returns only a count -> tiny workflow history. */
    async fetchAndPublish(input: {
      runId: string;
      profileId: string;
      source: string;
    }): Promise<{ fetched: number }> {
      const profile = await profiles.getById(input.profileId);
      const found = await sources.get(input.source).fetch(profile);

      await producer.emitMany(
        TOPICS.RAW,
        found.map((job) => {
          const value: RawJobEvent = {
            runId: input.runId,
            profileId: input.profileId,
            source: input.source,
            job,
          };
          return { key: input.profileId, value };
        }),
      );
      return { fetched: found.length };
    },

    async finishRun(runId: string, stats: RunStats): Promise<void> {
      await jobs.finishRun(runId, stats);
    },
  };
}

export type JobActivities = ReturnType<typeof createActivities>;
