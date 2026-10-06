import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { SearchResponse } from '@job-agent/shared';
import { SemanticMatchService } from './semantic-match.service.js';
import { Job } from '../jobs/entities/job.entity.js';
import type { ProfileService } from '../profile/profile.service.js';
import type { RagClientService } from '../rag/rag-client.service.js';

const PROFILE = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const RUN = 'run-1';

const config = (env: Record<string, string> = {}) =>
  ({
    get: (key: string, fallback?: unknown) => env[key] ?? (fallback as string | undefined),
  }) as unknown as ConfigService;

class FakeJobRepository {
  readonly rows = new Map<string, Job>();
  readonly updates: { where: Record<string, unknown>; patch: Record<string, unknown> }[] = [];

  add(row: Partial<Job>): Job {
    const job = { id: row.id ?? `job-${this.rows.size + 1}`, ...row } as Job;
    this.rows.set(job.id, job);
    return job;
  }

  async count(options: { where: Record<string, unknown> }) {
    return [...this.rows.values()].filter((row) =>
      Object.entries(options.where).every(([key, value]) => {
        if (value === undefined) return true;
        const operator = value as { type?: string; value?: unknown };
        if (operator && typeof operator === 'object' && 'type' in operator) {
          if (operator.type === 'not')
            return (row as never as Record<string, unknown>)[key] !== operator.value;
          // A column the entity never set reads as NULL, as it would in Postgres.
          if (operator.type === 'isNull')
            return ((row as never as Record<string, unknown>)[key] ?? null) === null;
        }
        return (row as never as Record<string, unknown>)[key] === value;
      }),
    ).length;
  }

  async update(where: Record<string, unknown>, patch: Record<string, unknown>) {
    this.updates.push({ where, patch });
    let affected = 0;
    for (const row of this.rows.values()) {
      const matches = Object.entries(where).every(
        ([key, value]) => (row as never as Record<string, unknown>)[key] === value,
      );
      if (!matches) continue;
      Object.assign(row, patch);
      affected += 1;
    }
    return { affected };
  }
}

class FakeRag {
  enabled = true;
  readonly requests: Record<string, unknown>[] = [];
  response: SearchResponse | null = {
    hits: [
      {
        jobId: 'job-1',
        score: 0.82,
        snippet: 'Kubernetes and PostgreSQL',
        title: 'Backend',
        company: 'Acme',
        source: 'linkedin',
        similarity: 0.8,
        matchedBy: ['resume'],
      },
      {
        jobId: 'job-2',
        score: 0.41,
        snippet: 'React and CSS',
        title: 'Frontend',
        company: 'Globex',
        source: 'indeed',
        similarity: 0.4,
        matchedBy: ['resume'],
      },
    ],
    degraded: false,
    embeddingModel: 'fireworks/qwen3-embedding-8b',
    vectorStore: 'pinecone',
  };
  /** Returned on the first N calls, to simulate vectors that are still landing. */
  emptyResponses = 0;

  async search(body: Record<string, unknown>) {
    this.requests.push(body);
    if (this.emptyResponses > 0) {
      this.emptyResponses -= 1;
      return { ...this.response!, hits: [] };
    }
    return this.response;
  }
}

function build(env: Record<string, string> = {}, profile: Record<string, unknown> = {}) {
  const jobs = new FakeJobRepository();
  const rag = new FakeRag();
  const profiles = {
    getById: async () => ({
      id: PROFILE,
      userId: USER,
      resumeText: 'Backend engineer with Kubernetes and PostgreSQL experience.',
      preferences: { roles: ['Staff Backend Engineer'], skills: ['TypeScript', 'Go'] },
      ...profile,
    }),
  };
  const service = new SemanticMatchService(
    jobs as never,
    rag as unknown as RagClientService,
    profiles as unknown as ProfileService,
    config({ RAG_DRAIN_WAIT_MS: '50', RAG_EMPTY_SEARCH_RETRY_MS: '10', ...env }),
  );
  return { service, jobs, rag };
}

describe('SemanticMatchService', () => {
  // ---------- query construction ----------

  it('searches with the resume text and the wanted roles', async () => {
    const { service, jobs, rag } = build();
    jobs.add({ id: 'job-1', profileId: PROFILE, runId: RUN, scoredAt: new Date() });

    await service.rankRun(RUN, PROFILE);

    // Everything travels as text from the profile row: there is no catalog to
    // join against on the other side.
    const request = rag.requests[0];
    expect(request.documentIds).toBeUndefined();
    expect(String(request.queryText)).toContain('Kubernetes');
    expect(request.roleQueries).toEqual(['Staff Backend Engineer']);
    expect(request.runId).toBe(RUN);
    expect(request.userId).toBe(USER);
  });

  // ---------- persistence ----------

  it('writes the score, the snippet and a 1-based rank onto each job', async () => {
    const { service, jobs } = build();
    jobs.add({ id: 'job-1', profileId: PROFILE, runId: RUN, scoredAt: new Date() });
    jobs.add({ id: 'job-2', profileId: PROFILE, runId: RUN, scoredAt: new Date() });

    const result = await service.rankRun(RUN, PROFILE);

    expect(result.ranked).toBe(2);
    expect(jobs.rows.get('job-1')?.semanticScore).toBeCloseTo(0.82);
    expect(jobs.rows.get('job-1')?.semanticSnippet).toBe('Kubernetes and PostgreSQL');
    // Rank 0 would read as "unranked" next to a null score.
    expect(jobs.rows.get('job-1')?.semanticRank).toBe(1);
    expect(jobs.rows.get('job-2')?.semanticRank).toBe(2);
  });

  it('does not write onto a job outside the profile or the run', async () => {
    const { service, jobs } = build();
    jobs.add({ id: 'job-1', profileId: PROFILE, runId: RUN, scoredAt: new Date() });
    // Same id, another profile: the update must not match it.
    jobs.add({ id: 'job-2', profileId: 'other-profile', runId: RUN, scoredAt: new Date() });

    await service.rankRun(RUN, PROFILE);

    expect(jobs.rows.get('job-1')?.semanticScore).toBeCloseTo(0.82);
    expect(jobs.rows.get('job-2')?.semanticScore).toBeUndefined();
  });

  it('reports how many postings never got a score', async () => {
    const { service, jobs } = build();
    jobs.add({
      id: 'job-1',
      profileId: PROFILE,
      runId: RUN,
      scoredAt: new Date(),
      semanticScore: 0.5,
    });
    // Present but never indexed, so nothing will ever score it.
    jobs.add({ id: 'job-9', profileId: PROFILE, runId: RUN, scoredAt: new Date(), status: 'new' });

    const result = await service.rankRun(RUN, PROFILE);
    expect(result.skipped).toBe(1);
  });

  // ---------- resilience ----------

  it('returns an empty result rather than throwing when search is unavailable', async () => {
    const { service, jobs, rag } = build();
    jobs.add({ id: 'job-1', profileId: PROFILE, runId: RUN, scoredAt: new Date() });
    rag.response = null;

    const result = await service.rankRun(RUN, PROFILE);
    expect(result).toMatchObject({ ranked: 0, skipped: 1, embeddingModel: null });
  });

  it('does nothing at all when the RAG service is not configured', async () => {
    const { service, jobs, rag } = build();
    rag.enabled = false;
    jobs.add({ id: 'job-1', profileId: PROFILE, runId: RUN, scoredAt: new Date() });

    const result = await service.rankRun(RUN, PROFILE);
    expect(result.ranked).toBe(0);
    // Not even a request: the feature is off, not broken.
    expect(rag.requests).toHaveLength(0);
  });

  it('retries a search that comes back empty for a run that has postings', async () => {
    const { service, jobs, rag } = build();
    jobs.add({ id: 'job-1', profileId: PROFILE, runId: RUN, scoredAt: new Date() });
    // The rows are in the database but their vectors have not landed yet.
    rag.emptyResponses = 2;

    const result = await service.rankRun(RUN, PROFILE);

    expect(rag.requests.length).toBe(3);
    // Only job-1 exists here, so the second hit updates nothing.
    expect(result.ranked).toBe(1);
  });

  it('does not retry when the run genuinely has no postings', async () => {
    const { service, rag } = build();
    rag.emptyResponses = 2;

    await service.rankRun(RUN, PROFILE);
    // Nothing to wait for, so a second request would only add latency.
    expect(rag.requests).toHaveLength(1);
  });

  it('settles a run with no postings without waiting out the timeout', async () => {
    const { service } = build({ RAG_DRAIN_WAIT_MS: '45_000' });

    const started = Date.now();
    const result = await service.rankRun(RUN, PROFILE);

    // A run that found nothing is settled as far as anything can tell; blocking
    // for the whole timeout would add a minute of dead time to every empty run.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.ranked).toBe(0);
  });

  // ---------- re-ranking everything ----------

  it('asks for the widest search when re-ranking every job', async () => {
    const { service, rag } = build();
    await service.rankAll(PROFILE);
    // The default 20 would leave the rest of the user's jobs on stale scores.
    expect(rag.requests[0].topK).toBe(200);
    expect(rag.requests[0].runId).toBeUndefined();
  });
});
