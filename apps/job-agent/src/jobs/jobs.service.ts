import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { JobStatus, RawJob, RunStatus, type RunStats } from '@job-agent/shared';
import { QueryJobsDto } from './dto/query-jobs.dto.js';
import { Job } from './entities/job.entity.js';
import { SearchRun } from './entities/search-run.entity.js';
import { dedupeHash } from './pipeline/filters.js';
import { ScoreResult } from './pipeline/scorer.service.js';
import { OutboxService, type PendingEvent } from '../outbox/outbox.service.js';

// description is big -> left out of list responses
const LIST_COLUMNS: (keyof Job)[] = [
  'id',
  'source',
  'title',
  'company',
  'location',
  'remote',
  'salaryText',
  'applyUrl',
  'postedAt',
  'matchScore',
  'matchReason',
  'highlights',
  'redFlags',
  'semanticScore',
  'semanticSnippet',
  'semanticRank',
  'semanticAt',
  'status',
  'scoredAt',
  // Carried in the list, not just the detail: an unscored job with a reason
  // attached ("no API key", "rate limited") is diagnosable from the list, and
  // one without it is indistinguishable from a pending score.
  'scoreError',
  'createdAt',
];

@Injectable()
export class JobsService {
  constructor(
    @InjectRepository(Job) private readonly jobs: Repository<Job>,
    @InjectRepository(SearchRun) private readonly runs: Repository<SearchRun>,
    private readonly outbox: OutboxService,
    private readonly dataSource: DataSource,
  ) {}

  // ---------- runs ----------
  async createRun(profileId: string, workflowId: string): Promise<string> {
    const run = await this.runs.save(this.runs.create({ profileId, workflowId }));
    return run.id;
  }

  async finishRun(runId: string, stats: RunStats) {
    const results = Object.values(stats);
    const failed = results.filter((r) => r.error).length;
    const status =
      results.length > 0 && failed === results.length
        ? RunStatus.FAILED
        : failed > 0
          ? RunStatus.PARTIAL
          : RunStatus.COMPLETED;
    await this.runs.update(runId, { status, stats, finishedAt: new Date() });
  }

  listRuns(profileId: string, limit = 20) {
    return this.runs.find({ where: { profileId }, order: { startedAt: 'DESC' }, take: limit });
  }

  /** Scoped read, for a handler that acts on a run's id. */
  async getOwnedRun(runId: string, profileId: string): Promise<SearchRun> {
    const run = await this.runs.findOneBy({ id: runId, profileId });
    if (!run) throw new NotFoundException(`Run ${runId} not found`);
    return run;
  }

  // ---------- jobs ----------
  /**
   * Stores a posting, and optionally records the events its arrival implies.
   *
   * The insert and the outbox rows share one transaction, so a job row can never
   * exist without the events that score and index it. `events` is a callback
   * because the payloads need the generated job id.
   *
   * Returns the new job id, or null if it already existed (dedupe).
   */
  async insertIfNew(
    profileId: string,
    source: string,
    runId: string,
    raw: RawJob,
    events?: (jobId: string) => PendingEvent[],
  ): Promise<string | null> {
    return this.dataSource.transaction(async (manager) => {
      const res = await manager
        .createQueryBuilder()
        .insert()
        .into(Job)
        .values({
          profileId,
          runId,
          source,
          externalId: raw.externalId,
          dedupeHash: dedupeHash(profileId, raw),
          title: raw.title,
          company: raw.company,
          location: raw.location ?? null,
          remote: raw.remote ?? null,
          salaryText: raw.salaryText ?? null,
          description: raw.description ?? null,
          applyUrl: raw.applyUrl,
          postedAt: raw.postedAt ? new Date(raw.postedAt) : null,
        })
        .orIgnore()
        .returning('id')
        .execute();

      const id = (res.raw?.[0]?.id as string | undefined) ?? null;
      if (id && events) await this.outbox.enqueue(manager, events(id));
      return id;
    });
  }

  async list(profileId: string, q: QueryJobsDto) {
    const qb = this.jobs
      .createQueryBuilder('j')
      .select(LIST_COLUMNS.map((c) => `j.${c}`))
      .where('j.profileId = :profileId', { profileId });

    if (q.status) qb.andWhere('j.status = :status', { status: q.status });
    else qb.andWhere('j.status != :ignored', { ignored: JobStatus.IGNORED });
    if (q.minScore !== undefined)
      qb.andWhere('j.matchScore >= :minScore', { minScore: q.minScore });
    if (q.source) qb.andWhere('j.source = :source', { source: q.source });
    if (q.q) qb.andWhere('(j.title ILIKE :q OR j.company ILIKE :q)', { q: `%${q.q}%` });

    if (q.sort === 'date') {
      qb.orderBy('j.postedAt', 'DESC', 'NULLS LAST');
    } else if (q.sort === 'semantic') {
      // NULLS LAST, because a job that could not be embedded has no similarity at
      // all and belongs at the bottom rather than at the top as a zero.
      qb.orderBy('j.semanticScore', 'DESC', 'NULLS LAST').addOrderBy(
        'j.matchScore',
        'DESC',
        'NULLS LAST',
      );
    } else {
      qb.orderBy('j.matchScore', 'DESC', 'NULLS LAST').addOrderBy(
        'j.postedAt',
        'DESC',
        'NULLS LAST',
      );
    }

    const [items, total] = await qb
      .skip((q.page - 1) * q.limit)
      .take(q.limit)
      .getManyAndCount();
    return { items, total, page: q.page, limit: q.limit };
  }

  /**
   * By id alone, for the Kafka pipeline: the job event already carries the ids
   * and the broker is not a user. Never call this from an HTTP handler — use
   * getOwnedById so a guessed id cannot reach another user's job.
   */
  async getById(id: string): Promise<Job> {
    const job = await this.jobs.findOneBy({ id });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    return job;
  }

  /**
   * The HTTP read path. Filtering on `id` + `profileId` in one query means a
   * foreign id is a miss rather than a read, and the 404 is indistinguishable
   * from the job not existing.
   */
  async getOwnedById(id: string, profileId: string): Promise<Job> {
    const job = await this.jobs.findOneBy({ id, profileId });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    return job;
  }

  async updateStatus(id: string, profileId: string, status: JobStatus) {
    await this.getOwnedById(id, profileId);
    await this.jobs.update(id, { status });
    return this.getOwnedById(id, profileId);
  }

  async saveScore(id: string, r: ScoreResult) {
    await this.jobs.update(id, {
      matchScore: r.score,
      matchReason: r.reason,
      highlights: r.highlights,
      redFlags: r.redFlags,
      scoredAt: new Date(),
      scoreError: null,
    });
  }

  saveScoreError(id: string, error: string) {
    return this.jobs.update(id, { scoreError: error.slice(0, 1000) });
  }

  resetScore(id: string) {
    return this.jobs.update(id, { scoredAt: null, matchScore: null, scoreError: null });
  }

  /** HTTP rescore path: verify ownership before clearing the score. */
  async resetScoreOwned(id: string, profileId: string) {
    await this.getOwnedById(id, profileId);
    return this.resetScore(id);
  }
}
