import { ConfigService } from '@nestjs/config';
import { Kafka } from 'kafkajs';
import { TOPICS } from '@job-agent/shared';

export const brokersFrom = (config: ConfigService): string[] =>
  (config.get<string>('KAFKA_BROKERS') ?? 'localhost:9092')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);

/** The one topic this service touches. Created idempotently on boot. */
const RAG_TOPICS = [TOPICS.JOB_INDEX] as const;

/**
 * Idempotent, so a fresh broker comes up correctly with no manual step.
 *
 * The DLQ deliberately gets one partition while the others get three: the DLQ is
 * low-volume and single-consumer, while jobs.index is partitioned by profileId so
 * one user's postings are handled in order and in parallel across users.
 */
export async function ensureKafkaTopics(brokers: string[]): Promise<void> {
  const admin = new Kafka({ clientId: 'rag-admin', brokers }).admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: RAG_TOPICS.map((topic) => ({ topic, numPartitions: 3, replicationFactor: 1 })),
    });
  } finally {
    await admin.disconnect();
  }
}
