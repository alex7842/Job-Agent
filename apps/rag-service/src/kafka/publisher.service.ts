import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, type Producer } from 'kafkajs';

/**
 * Publishes indexing outcomes back to the job agent (documents.indexed).
 *
 * Deliberately plain KafkaJS rather than Nest's ClientKafka: this service only
 * produces to one topic and must stay independently deployable, so it has no
 * reason to adopt the API process's hybrid-microservice setup.
 *
 * Connection is lazy, and a send failure is swallowed by `emit`. Reporting a
 * document's index status is a courtesy to the UI: if the broker is briefly
 * down, the vectors are still written and searchable, and losing the status
 * event must not turn into a failed indexing attempt.
 */
@Injectable()
export class KafkaPublisherService implements OnModuleDestroy {
  private readonly log = new Logger(KafkaPublisherService.name);
  private producer: Producer | null = null;
  private connecting: Promise<Producer> | null = null;

  constructor(config: ConfigService) {
    this.brokers = (config.get<string>('KAFKA_BROKERS') ?? 'localhost:9092')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);
  }

  private readonly brokers: string[];

  private ready(): Promise<Producer> {
    if (this.connecting) return this.connecting;
    const kafka = new Kafka({ clientId: 'rag-publisher', brokers: this.brokers });
    const producer = kafka.producer();
    this.connecting = producer
      .connect()
      .then(() => {
        this.producer = producer;
        return producer;
      })
      .catch((error: unknown) => {
        // Allow a later call to retry instead of caching the rejection forever.
        this.connecting = null;
        throw error;
      });
    return this.connecting;
  }

  async emit(topic: string, key: string, value: unknown): Promise<void> {
    try {
      const producer = await this.ready();
      await producer.send({ topic, messages: [{ key, value: JSON.stringify(value) }] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`Could not publish to ${topic}: ${message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer?.disconnect().catch(() => undefined);
  }
}
