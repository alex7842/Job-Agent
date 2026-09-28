import { ConfigService } from '@nestjs/config';
import { Kafka } from 'kafkajs';
import { TOPICS } from '@job-agent/shared';

export const brokersFrom = (config: ConfigService): string[] =>
  config.get<string>('KAFKA_BROKERS', 'localhost:9092').split(',');

/** Idempotent - creates topics if missing. Called on API + worker boot. */
export async function ensureKafkaTopics(brokers: string[]) {
  const admin = new Kafka({ clientId: 'jobs-admin', brokers }).admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: Object.values(TOPICS).map((topic) => ({
        topic,
        numPartitions: topic === TOPICS.DLQ ? 1 : 3,
        replicationFactor: 1,
      })),
    });
  } finally {
    await admin.disconnect();
  }
}
