import { ConfigService } from '@nestjs/config';
import { Kafka } from 'kafkajs';
import { TOPICS } from '@job-agent/shared';

export const brokersFrom = (config: ConfigService): string[] =>
  (config.get<string>('KAFKA_BROKERS') ?? 'localhost:9092')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);

/**
 * The topics this service touches: three consumed, one produced. Created
 * idempotently on boot so a fresh broker comes up correctly with no manual step.
 */
const RAG_TOPICS = [
  TOPICS.JOB_INDEX,
  TOPICS.DOC_CHANGED,
  TOPICS.DOC_DELETED,
  TOPICS.DOC_INDEXED,
] as const;

/**
 * Idempotent, so a fresh broker comes up correctly with no manual step.
 *
 * DLQ deliberately gets one partition while the others get three: the DLQ is
 * low-volume and single-consumer, while the indexing topics are partitioned by
 * profileId so one user's documents are handled in order and in parallel across
 * users.
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
