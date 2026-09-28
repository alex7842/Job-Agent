import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { createRequire } from 'module';
import { NativeConnection, Worker } from '@temporalio/worker';
import { AppModule } from '../app.module.js';
import { TASK_QUEUE } from '@job-agent/shared';
import { JobsService } from '../jobs/jobs.service.js';
import { SourcesRegistry } from '../jobs/sources/sources.registry.js';
import { brokersFrom, ensureKafkaTopics } from '../kafka/kafka.config.js';
import { KafkaProducerService } from '../kafka/kafka-producer.service.js';
import { ProfileService } from '../profile/profile.service.js';
import { SemanticMatchService } from '../semantic/semantic-match.service.js';
import { createActivities } from './activities.js';
import { TemporalClientService } from './temporal-client.service.js';

const require = createRequire(import.meta.url);

/**
 * Separate process from the API: `npm run dev:worker`.
 * Boots a Nest application context (DI, no HTTP), registers the schedule, then polls the task queue.
 */
async function run() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const config = app.get(ConfigService);
  await ensureKafkaTopics(brokersFrom(config));

  const connection = await NativeConnection.connect({
    address: config.get<string>('TEMPORAL_ADDRESS', 'localhost:7233'),
  });

  const worker = await Worker.create({
    connection,
    namespace: config.get<string>('TEMPORAL_NAMESPACE', 'default'),
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve('./workflows'),
    activities: createActivities({
      profiles: app.get(ProfileService),
      jobs: app.get(JobsService),
      sources: app.get(SourcesRegistry),
      producer: app.get(KafkaProducerService),
      semantic: app.get(SemanticMatchService),
    }),
  });

  await app.get(TemporalClientService).ensureSchedule();
  console.log(
    `Temporal worker up (queue: ${TASK_QUEUE}); schedule "${config.get('SCHEDULE_CRON', '0 10 * * *')}" registered`,
  );

  await worker.run();
  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
