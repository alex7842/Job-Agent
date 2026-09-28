import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { OutboxService } from './outbox.service.js';
import { KafkaProducerService } from '../kafka/kafka-producer.service.js';

const RELAY_INTERVAL_MS = 500;
const BATCH = 50;

/**
 * Publishes outbox rows to Kafka.
 *
 * Deliberately not a Kafka consumer offset: the point is that a broker outage
 * cannot lose a decided event, and that a slow broker cannot block the jobs.raw
 * partition. The trade is at-least-once, so every consumer of these two topics is
 * written to tolerate a repeat.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(OutboxRelayService.name);
  private timer?: NodeJS.Timeout;
  private draining = false;
  private lastStuckReport = 0;

  constructor(
    private readonly outbox: OutboxService,
    private readonly producer: KafkaProducerService,
  ) {}

  onModuleInit() {
    // setInterval rather than @Interval(): a test or a short-lived worker
    // process can construct this without wanting a background loop at all.
    this.timer = setInterval(() => void this.drain(), RELAY_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async drain(): Promise<void> {
    // A slow broker must not start a second overlapping drain.
    if (this.draining) return;
    this.draining = true;
    try {
      const pending = await this.outbox.take(BATCH);
      for (const row of pending) {
        try {
          await this.producer.emit(row.topic, row.partitionKey, row.payload);
          await this.outbox.markPublished(row.id);
        } catch (e) {
          // Left unpublished on purpose. The next drain retries it, and the row
          // keeps its place in the order.
          await this.outbox.markFailed(row.id, e instanceof Error ? e.message : String(e));
        }
      }
      if (Date.now() - this.lastStuckReport > 60_000) {
        this.lastStuckReport = Date.now();
        await this.outbox.reportStuck();
      }
    } catch (e) {
      this.log.error(`Outbox drain failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.draining = false;
    }
  }
}
