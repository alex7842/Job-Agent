import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule, ObserveInstrument } from './app.module.js';
import { brokersFrom, ensureKafkaTopics } from './kafka/kafka.config.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });

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