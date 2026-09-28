import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import express from 'express';
import { MAX_DOCUMENT_BYTES } from '@job-agent/shared';
import { AppModule } from './app.module.js';
import { brokersFrom, ensureKafkaTopics } from './kafka/kafka.config.js';
import { EMBEDDING_PROVIDER, OBJECT_STORE, VECTOR_STORE } from './ports.js';
import type { EmbeddingProvider, ObjectStore, VectorStore } from './ports.js';

const logger = new Logger('RagService');

/**
 * One process serves both transports: HTTP for synchronous search calls from the
 * job agent, and Kafka for the indexing events. That keeps the deployment a
 * single unit and lets a search be answered while indexing continues behind it.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // The relayed upload arrives as text/plain or application/pdf. Nest's parsers
  // only claim JSON and urlencoded, so the stream would be left unread and the
  // handler would see zero bytes; `rawBody: true` alone does not help, because it
  // only observes the parsers Nest registers. Scoped to the one route, and
  // limited so an oversized body is refused here rather than buffered.
  app.use(
    '/internal/documents/:documentId/content',
    express.raw({ type: '*/*', limit: MAX_DOCUMENT_BYTES }),
  );

  const config = app.get(ConfigService);

  // Fail fast and loudly. A dimension mismatch or a missing bucket is far
  // cheaper to discover here than as an empty search result seen by a user.
  const embeddings = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);
  const vectors = app.get<VectorStore>(VECTOR_STORE);
  const objects = app.get<ObjectStore>(OBJECT_STORE);
  await vectors.ping();
  await objects.ping();

  const brokers = brokersFrom(config);
  // Indexing is this service's reason to exist, so an unreachable broker must stop
  // the boot: silently running without a consumer would accept uploads and never
  // index them. RAG_SKIP_KAFKA is an explicit opt-in for search-only runs.
  const skipKafka = config.get<string>('RAG_SKIP_KAFKA') === 'true';
  if (skipKafka) {
    logger.warn(
      'RAG_SKIP_KAFKA=true: starting WITHOUT the indexing consumer. Documents will not be indexed.',
    );
  } else {
    await ensureKafkaTopics(brokers);
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.KAFKA,
      options: {
        client: { clientId: config.get<string>('KAFKA_CLIENT_ID', 'rag-service'), brokers },
        // Group id => multiple RAG replicas share the load; one message per group.
        consumer: { groupId: config.get<string>('RAG_KAFKA_GROUP', 'rag-service') },
        subscribe: { fromBeginning: false },
      },
    });
    await app.startAllMicroservices();
  }

  const port = Number(config.get<string>('RAG_PORT') ?? process.env.RAG_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  app.enableShutdownHooks();

  logger.log(
    `HTTP on :${port}, Kafka group "${config.get<string>('RAG_KAFKA_GROUP', 'rag-service')}"`,
  );

  const degraded = embeddings.model === 'offline-hashed-bow' || vectors.name === 'memory';
  if (degraded) {
    logger.warn(
      `DEGRADED: embeddings=${embeddings.model} (${embeddings.dimensions}d), vectors=${vectors.name}, ` +
        `objects=${objects.name}. Retrieval is lexical only — set EMBEDDING_PROVIDER and VECTOR_STORE for real semantic search.`,
    );
  } else {
    logger.log(`Embeddings: ${embeddings.model} (${embeddings.dimensions}d) into ${vectors.name}`);
  }
}

bootstrap().catch((error) => {
  logger.error('Failed to start RAG service', error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
