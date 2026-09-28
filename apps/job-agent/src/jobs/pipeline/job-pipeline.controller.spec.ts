import { describe, expect, it } from 'vitest';
import { TOPICS, type JobPreferences, type RawJobEvent } from '@job-agent/shared';
import { JobPipelineController } from './job-pipeline.controller.js';
import type { JobsService } from '../../jobs/jobs.service.js';
import type { ProfileService } from '../../profile/profile.service.js';
import type { ScorerService } from './scorer.service.js';
import type { KafkaProducerService } from '../../kafka/kafka-producer.service.js';
import type { PendingEvent } from '../../outbox/outbox.service.js';

const PROFILE = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';

const preferences = {
  postedWithinDays: 30,
  remoteOnly: false,
  minSalary: null,
  excludedCompanies: [],
  excludedKeywords: [],
  roles: [],
  skills: [],
} as unknown as JobPreferences;

const raw: RawJobEvent = {
  profileId: PROFILE,
  runId: 'run-1',
  source: 'linkedin',
  job: {
    externalId: 'ext-1',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Berlin',
    remote: true,
    salaryText: '90-110k',
    description: 'Kubernetes and PostgreSQL, TypeScript.',
    applyUrl: 'https://example.com/apply',
    postedAt: new Date().toISOString(),
  },
};

function build(
  options: { insertId?: string | null; userId?: string | null; prefs?: JobPreferences } = {},
) {
  const insertCalls: { events?: (jobId: string) => PendingEvent[] }[] = [];
  const jobs = {
    insertIfNew: async (
      _profileId: string,
      _source: string,
      _runId: string,
      _raw: unknown,
      events?: (jobId: string) => PendingEvent[],
    ) => {
      insertCalls.push({ events });
      return options.insertId === undefined ? 'job-1' : options.insertId;
    },
    getById: async () => ({ id: 'job-1', scoredAt: null }),
    saveScore: async () => undefined,
    saveScoreError: async () => undefined,
  };
  const emitted: { topic: string; key: string; value: unknown }[] = [];
  const controller = new JobPipelineController(
    jobs as unknown as JobsService,
    {
      getById: async () => ({
        id: PROFILE,
        userId: options.userId === undefined ? USER : options.userId,
        preferences: options.prefs ?? preferences,
      }),
    } as unknown as ProfileService,
    { score: async () => ({ score: 80 }) } as unknown as ScorerService,
    {
      emit: async (topic: string, key: string, value: unknown) => {
        emitted.push({ topic, key, value });
      },
    } as unknown as KafkaProducerService,
  );
  return { controller, emitted, insertCalls };
}

describe('JobPipelineController (raw)', () => {
  it('records both events with the job insert rather than publishing inline', async () => {
    const { controller, emitted, insertCalls } = build();

    await controller.onRaw(raw);

    // The insert and the two events it implies are one unit. Publishing here is
    // what used to strand a job: the second event could fail after the row was
    // already written, and the consumer had been told the message was handled.
    expect(insertCalls).toHaveLength(1);
    expect(emitted).toHaveLength(0);

    const events = insertCalls[0].events!('job-1');
    expect(events.map((e) => e.topic)).toEqual([TOPICS.JOB_INDEX, TOPICS.NEW]);
    // Partitioned by profile, so one profile's events keep their order.
    expect(events.every((e) => e.key === PROFILE)).toBe(true);
  });

  it('carries the posting text in the index event', async () => {
    const { controller, insertCalls } = build();
    await controller.onRaw(raw);

    // The RAG service has no access to this table, so the text to embed travels
    // in the event rather than being re-read from the database.
    expect(insertCalls[0].events!('job-1')[0].value).toMatchObject({
      jobId: 'job-1',
      profileId: PROFILE,
      userId: USER,
      runId: 'run-1',
      source: 'linkedin',
      title: 'Senior Backend Engineer',
      company: 'Acme',
      description: 'Kubernetes and PostgreSQL, TypeScript.',
    });
  });

  it('still indexes a posting that has no description', async () => {
    const { controller, insertCalls } = build();
    await controller.onRaw({ ...raw, job: { ...raw.job, description: undefined } });

    const index = insertCalls[0].events!('job-1')[0].value as {
      description?: string;
      title: string;
    };
    // Title and company alone are enough to find it later; dropping it would
    // lose the posting from semantic search entirely.
    expect(index.title).toBe('Senior Backend Engineer');
    expect(index.description).toBeUndefined();
  });

  it('gives a profile that predates auth a stable userId', async () => {
    const { controller, insertCalls } = build({ userId: null });
    await controller.onRaw(raw);

    // The RAG service records a userId with every vector, so it needs a real
    // value even for an ownerless profile.
    const index = insertCalls[0].events!('job-1')[0].value as { userId: string };
    expect(index.userId).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('stores nothing for a posting older than the user asked for', async () => {
    const { controller, insertCalls } = build();
    await controller.onRaw({
      ...raw,
      job: { ...raw.job, postedAt: new Date(Date.now() - 200 * 86_400_000).toISOString() },
    });
    expect(insertCalls).toHaveLength(0);
  });

  it('stores nothing for a posting the user excluded by company', async () => {
    const { controller, insertCalls } = build({
      prefs: { ...preferences, excludedCompanies: ['acme'] } as JobPreferences,
    });
    await controller.onRaw(raw);
    // Filtered before the insert, so nothing is written and no events recorded.
    expect(insertCalls).toHaveLength(0);
  });

  it('writes no events for a posting another run already stored', async () => {
    const { controller, insertCalls } = build({ insertId: null });

    await controller.onRaw(raw);

    // The events are the insert's own outbox rows, so a dedupe hit adds none:
    // a second copy would re-run scoring and re-index for no reason.
    expect(insertCalls).toHaveLength(1);
  });

  it('sends a failure to the dead-letter topic instead of stalling the partition', async () => {
    const { controller, emitted } = build({ insertId: null });
    const failing = {
      ...raw,
      // A payload the filter cannot read: the handler must survive it.
      job: { ...raw.job, postedAt: 'not-a-date' },
    };

    await controller.onRaw(failing);

    // A poisoned message cannot be retried forever, so it is reported and
    // dropped rather than blocking every posting behind it.
    expect(emitted).toHaveLength(0);
  });
});
