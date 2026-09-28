import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository, type EntityManager } from 'typeorm';
import { OutboxEvent } from './entities/outbox-event.entity.js';

/** One publish that still has to happen, built once the job id is known. */
export type PendingEvent = { topic: string; key: string; value: unknown };

/** An older unpublished row than this is reported rather than retried silently. */
const STUCK_AFTER_MS = 5 * 60 * 1000;

@Injectable()
export class OutboxService {
  private readonly log = new Logger(OutboxService.name);

  constructor(@InjectRepository(OutboxEvent) private readonly events: Repository<OutboxEvent>) {}

  /**
   * Writes the event rows using the caller's transaction manager, so they
   * commit or roll back together with the domain change that justified them.
   */
  async enqueue(manager: EntityManager, pending: PendingEvent[]): Promise<void> {
    if (pending.length === 0) return;
    await manager.insert(
      OutboxEvent,
      pending.map((e) => ({
        topic: e.topic,
        partitionKey: e.key,
        payload: e.value as Record<string, unknown>,
      })),
    );
  }

  /** Oldest first, so a partition sees its events in the order they were decided. */
  async take(limit: number): Promise<OutboxEvent[]> {
    return this.events.find({
      where: { publishedAt: IsNull() },
      order: { createdAt: 'ASC', id: 'ASC' },
      take: limit,
    });
  }

  async markPublished(id: string): Promise<void> {
    await this.events.update(id, { publishedAt: new Date(), lastError: null });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.events.increment({ id }, 'attempts', 1);
    await this.events.update(id, { lastError: error.slice(0, 2000) });
  }

  /**
   * Old unpublished rows mean the relay is down or the broker has been refusing
   * these events for a while. Worth a loud log: nothing retries them on their own
   * beyond the relay, and the affected jobs are silently unscored meanwhile.
   */
  async reportStuck(): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
    const count = await this.events.count({
      where: { publishedAt: IsNull(), createdAt: LessThan(cutoff) },
    });
    if (count > 0)
      this.log.error(`${count} event(s) pending for over ${STUCK_AFTER_MS / 60000} min`);
  }
}
