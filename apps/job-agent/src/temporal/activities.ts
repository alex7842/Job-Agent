import {
  TOPICS,
  type RawJobEvent,
  type RunStats,
  type SemanticRankResult,
} from '@job-agent/shared';
import { JobsService } from '../jobs/jobs.service.js';
import { SourcesRegistry } from '../jobs/sources/sources.registry.js';
import { KafkaProducerService } from '../kafka/kafka-producer.service.js';
import { ProfileService } from '../profile/profile.service.js';
import { SemanticMatchService } from '../semantic/semantic-match.service.js';

export interface ActivityDeps {
  profiles: ProfileService;
  jobs: JobsService;
  sources: SourcesRegistry;
  producer: KafkaProducerService;
  semantic: SemanticMatchService;
}

/** Factory (not a class) so Temporal gets plain functions; Nest services are injected by worker.ts. */
export function createActivities({ profiles, jobs, sources, producer, semantic }: ActivityDeps) {
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

    /**
     * Rank this run's postings against the candidate's documents.
     *
     * Runs after finishRun rather than being folded into it: the postings reach
     * the vector store through Kafka, which is still in flight when the sources
     * have finished, and a search issued too early would report no matches for a
     * run that has plenty. The activity waits for the pipeline to settle and is
     * best effort — a failure here must not fail the run, which already did its
     * job of finding and scoring jobs.
     */
    async rankRunSemantically(input: {
      runId: string;
      profileId: string;
    }): Promise<SemanticRankResult> {
      return semantic.rankRun(input.runId, input.profileId);
    },
  };
}

export type JobActivities = ReturnType<typeof createActivities>;
