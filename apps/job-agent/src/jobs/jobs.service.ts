import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JobStatus, RawJob, RunStatus, type RunStats } from '@job-agent/shared';
import { QueryJobsDto } from './dto/query-jobs.dto.js';
import { Job } from './entities/job.entity.js';
import { SearchRun } from './entities/search-run.entity.js';
import { dedupeHash } from './pipeline/filters.js';
import { ScoreResult } from './pipeline/scorer.service.js';

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
  'status',
  'scoredAt',
  'createdAt',
];

@Injectable()
export class JobsService {
  constructor(
    @InjectRepository(Job) private readonly jobs: Repository<Job>,
    @InjectRepository(SearchRun) private readonly runs: Repository<SearchRun>,
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

  listRuns(limit = 20) {
    return this.runs.find({ order: { startedAt: 'DESC' }, take: limit });
  }

  // ---------- jobs ----------
  /** Returns the new job id, or null if it already existed (dedupe). */
  async insertIfNew(
    profileId: string,
    source: string,
    runId: string,
    raw: RawJob,
  ): Promise<string | null> {
    const res = await this.jobs
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
    return res.raw?.[0]?.id ?? null;
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

    if (q.sort === 'date') qb.orderBy('j.postedAt', 'DESC', 'NULLS LAST');
    else
      qb.orderBy('j.matchScore', 'DESC', 'NULLS LAST').addOrderBy(
        'j.postedAt',
        'DESC',
        'NULLS LAST',
      );

    const [items, total] = await qb
      .skip((q.page - 1) * q.limit)
      .take(q.limit)
      .getManyAndCount();
    return { items, total, page: q.page, limit: q.limit };
  }

  async getById(id: string): Promise<Job> {
    const job = await this.jobs.findOneBy({ id });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    return job;
  }

  async updateStatus(id: string, status: JobStatus) {
    await this.getById(id);
    await this.jobs.update(id, { status });
    return this.getById(id);
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
}
