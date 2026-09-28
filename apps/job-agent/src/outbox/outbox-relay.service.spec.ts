import { describe, expect, it } from 'vitest';
import { OutboxRelayService } from './outbox-relay.service.js';
import type { OutboxService } from './outbox.service.js';
import type { KafkaProducerService } from '../kafka/kafka-producer.service.js';
import type { OutboxEvent } from './entities/outbox-event.entity.js';

function pending(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: 'out-1',
    topic: 'jobs.new',
    partitionKey: 'profile-1',
    payload: { jobId: 'job-1' },
    attempts: 0,
    lastError: null,
    publishedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as OutboxEvent;
}

class FakeOutbox {
  rows: OutboxEvent[] = [];
  published: string[] = [];
  failed: { id: string; error: string }[] = [];
  stuckReports = 0;

  async take() {
    return this.rows;
  }
  async markPublished(id: string) {
    this.published.push(id);
  }
  async markFailed(id: string, error: string) {
    this.failed.push({ id, error });
  }
  async reportStuck() {
    this.stuckReports += 1;
  }
}

class FlakyProducer {
  readonly emitted: { topic: string; key: string; value: unknown }[] = [];
  failTopics = new Set<string>();

  async emit(topic: string, key: string, value: unknown) {
    if (this.failTopics.has(topic)) throw new Error('broker unavailable');
    this.emitted.push({ topic, key, value });
  }
}

const build = () => {
  const outbox = new FakeOutbox();
  const producer = new FlakyProducer();
  const relay = new OutboxRelayService(
    outbox as unknown as OutboxService,
    producer as unknown as KafkaProducerService,
  );
  return { outbox, producer, relay };
};

describe('OutboxRelayService', () => {
  it('publishes pending events and marks them done', async () => {
    const { relay, producer, outbox } = build();
    outbox.rows = [pending(), pending({ id: 'out-2', topic: 'jobs.index' })];

    await relay.drain();

    expect(producer.emitted.map((m) => m.topic)).toEqual(['jobs.new', 'jobs.index']);
    // Only then: marking first would lose the event if the send failed.
    expect(outbox.published).toEqual(['out-1', 'out-2']);
  });

  it('keeps the profile as the partition key so per-profile order survives', async () => {
    const { relay, producer, outbox } = build();
    outbox.rows = [pending()];

    await relay.drain();
    // Ordering is the whole reason the key is the profile id.
    expect(producer.emitted[0].key).toBe('profile-1');
  });

  it('leaves a failed event unpublished so the next drain retries it', async () => {
    const { relay, producer, outbox } = build();
    outbox.rows = [pending(), pending({ id: 'out-2', topic: 'jobs.index' })];
    producer.failTopics = new Set(['jobs.index']);

    await relay.drain();

    expect(outbox.published).toEqual(['out-1']);
    expect(outbox.failed).toHaveLength(1);
    // One event failing must not hold back the rest of the batch.
    expect(producer.emitted.map((m) => m.topic)).toEqual(['jobs.new']);
  });

  it('does not start a second drain while one is running', async () => {
    const { relay, outbox, producer } = build();
    outbox.rows = [pending()];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = {
      take: async () => {
        await gate;
        return outbox.rows;
      },
    };
    Object.assign(outbox, slow);

    const first = relay.drain();
    await relay.drain();
    release();
    await first;

    // A slow broker must not stack up overlapping drains on the same rows.
    expect(producer.emitted).toHaveLength(1);
  });
});
