import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { RunStatus } from '@job-agent/shared';
import { Job } from '../jobs/entities/job.entity.js';
import { SearchRun } from '../jobs/entities/search-run.entity.js';
import { OutboxEvent } from '../outbox/entities/outbox-event.entity.js';
import { Profile } from '../profile/profile.entity.js';
import { User } from '../auth/user.entity.js';

/** Longest list the dashboard renders without scrolling forever. */
const RECENT_LIMIT = 10;

/**
 * Where "pending" work is counted from.
 *
 * Every count is a plain SQL aggregate rather than something derived from
 * TypeORM entities, because these are cross-profile totals: the point of the
 * dashboard is to see the whole system, not one user's slice.
 */
@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(Job) private readonly jobs: Repository<Job>,
    @InjectRepository(SearchRun) private readonly runs: Repository<SearchRun>,
    @InjectRepository(OutboxEvent) private readonly events: Repository<OutboxEvent>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  async overview() {
    const [
      totalUsers,
      totalProfiles,
      totalJobs,
      // A job with neither a score nor an error is genuinely in flight. These
      // are the rows a user sees as "scoring…" in the UI, so this number and
      // that spinner mean the same thing.
      awaitingScore,
      // Failed rows are counted separately rather than folded in: they are not
      // in flight, and hiding them inside a "pending" count would make a
      // pipeline that is failing look like one that is merely busy.
      scoreFailed,
      runsByStatus,
      outboxPending,
      stuckOutbox,
      recentJobs,
      recentRuns,
      lastRun,
    ] = await Promise.all([
      this.users.count(),
      this.profiles.count(),
      this.jobs.count(),
      this.jobs
        .createQueryBuilder('j')
        .where('j.scoredAt IS NULL')
        .andWhere('j.scoreError IS NULL')
        .getCount(),
      this.jobs
        .createQueryBuilder('j')
        .where('j.scoreError IS NOT NULL')
        .andWhere('j.scoredAt IS NULL')
        .getCount(),
      this.runs
        .createQueryBuilder('r')
        .select('r.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('r.status')
        .getRawMany<{ status: RunStatus; count: string }>(),
      this.events.createQueryBuilder('e').where('e.publishedAt IS NULL').getCount(),
      // Unpublished for over five minutes means the relay is down or the broker
      // is refusing; the outbox itself logs this, and the dashboard shows it.
      this.events
        .createQueryBuilder('e')
        .where('e.publishedAt IS NULL')
        .andWhere(`e.createdAt < NOW() - INTERVAL '5 minutes'`)
        .getCount(),
      this.jobs
        .createQueryBuilder('j')
        .select([
          'j.id',
          'j.title',
          'j.company',
          'j.source',
          'j.matchScore',
          'j.scoredAt',
          'j.createdAt',
        ])
        .orderBy('j.createdAt', 'DESC')
        .take(RECENT_LIMIT)
        .getMany(),
      this.runs.find({ order: { startedAt: 'DESC' }, take: RECENT_LIMIT }),
      this.runs.findOne({ where: { status: RunStatus.RUNNING }, order: { startedAt: 'DESC' } }),
    ]);

    return {
      users: { total: totalUsers, profiles: totalProfiles },
      jobs: {
        total: totalJobs,
        awaitingScore,
        scoreFailed,
      },
      runs: {
        byStatus: Object.fromEntries(runsByStatus.map((r) => [r.status, Number(r.count)])),
        running: runsByStatus.find((r) => r.status === RunStatus.RUNNING)?.count ?? '0',
        lastStartedAt: lastRun?.startedAt.toISOString() ?? null,
      },
      outbox: { pending: outboxPending, stuck: stuckOutbox },
      recentJobs,
      recentRuns,
    };
  }

  /** Unpublished events, oldest first: what the relay is working through. */
  pendingEvents(limit = RECENT_LIMIT) {
    return this.events.find({
      where: { publishedAt: IsNull() },
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  /**
   * The most recent scoring failures, deduplicated by message.
   *
   * Grouped in SQL because the interesting question is "what is breaking", and
   * a list of 500 identical rows answers it worse than one row per distinct
   * error with a count beside it.
   */
  async scoreFailures(limit = 20) {
    return this.jobs
      .createQueryBuilder('j')
      .select('j.scoreError', 'error')
      .addSelect('COUNT(*)', 'count')
      .addSelect('MAX(j.createdAt)', 'latest')
      .where('j.scoreError IS NOT NULL')
      .groupBy('j.scoreError')
      .orderBy('COUNT(*)', 'DESC')
      .limit(limit)
      .getRawMany<{ error: string; count: string; latest: Date }>();
  }

  /** Users, for the roster. Only ever read through the admin guard. */
  listUsers(limit = 50) {
    return this.users.find({
      select: { id: true, email: true, createdAt: true },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
