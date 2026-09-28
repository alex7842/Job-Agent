import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import express from 'express';
import { MAX_DOCUMENT_BYTES } from '@job-agent/shared';
import { AppModule, ObserveInstrument } from './app.module.js';
import { brokersFrom, ensureKafkaTopics } from './kafka/kafka.config.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
    // rawBody: the local-mode document upload route takes the file as the request
    // body, and no built-in body parser claims a PDF.
    rawBody: true,
  });

  // A document upload arrives as text/plain or application/pdf. Nest's built-in
  // parsers only claim JSON and urlencoded bodies, so they would leave the stream
  // unread and the handler would see zero bytes — `rawBody: true` alone does not
  // help, because it only observes the parsers Nest registers. Scoped to the one
  // route that needs it, and limited so an oversized body is refused by the
  // parser rather than buffered.
  app.use('/documents/:id/content', express.raw({ type: '*/*', limit: MAX_DOCUMENT_BYTES }));

  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  // Hybrid app: the HTTP API also runs the Kafka consumers
  // (jobs.raw -> filter/dedupe/store -> jobs.new -> AI-score -> jobs.scored).
  const config = app.get(ConfigService);
  await ensureKafkaTopics(brokersFrom(config));

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: { clientId: 'jobs-consumer', brokers: brokersFrom(config) },
      // Group id => multiple API replicas share the load; one message per group.
      consumer: { groupId: 'job-pipeline' },
      subscribe: { fromBeginning: false },
    },
  });

  await app.startAllMicroservices();
  await app.listen(Number(process.env.PORT ?? 3000));
}
await bootstrap();
