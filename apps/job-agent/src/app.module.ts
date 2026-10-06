import './env.js';
import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AdminModule } from './admin/admin.module.js';
import { AuthModule } from './auth/auth.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { RagModule } from './rag/rag.module.js';
import { SemanticModule } from './semantic/semantic.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, type DataSourceOptions } from 'typeorm';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

const SCHEMA_SYNC_LOCK = 473829001;

const database = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

@Module({
  imports: [
    // Global so KafkaModule / sources / TemporalClientService can inject ConfigService.
    // The monorepo's root .env is already in process.env (see ./env.ts).
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'postgres',
        ...database,
        autoLoadEntities: true,
        // dev convenience (DB_SYNC=true in .env); prod should use `pnpm migration:run`
        synchronize: process.env.DB_SYNC === 'true',
      }),
      dataSourceFactory: async (options) => {
        const dataSource = new DataSource(options as DataSourceOptions);
        if (!dataSource.options.synchronize) {
          await dataSource.initialize();
          return dataSource;
        }
        const lock = new DataSource({ type: 'postgres', ...database } as DataSourceOptions);
        await lock.initialize();
        try {
          await lock.query('SELECT pg_advisory_lock($1)', [SCHEMA_SYNC_LOCK]);
          await dataSource.initialize();
        } finally {
          await lock
            .query('SELECT pg_advisory_unlock($1)', [SCHEMA_SYNC_LOCK])
            .catch(() => undefined);
          await lock.destroy();
        }
        return dataSource;
      },
    }),
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    ObserveModule.forRoot({
      appKey: 'c3PUs8HLrtVnJF!2',
      appSecret: 'Q1VHEH^hc61tbwmd2RqOcyvy289eA&PPR^XvixsQz2b6c',
      serviceId: 'job-agent',
    }),
    // Global, so Jobs/Profile controllers can use JwtAuthGuard. Imported last
    // because it reads JWT_SECRET at module-init time.
    AuthModule,
    // Global, so the pipeline, the documents module and the Temporal worker all
    // share one RAG client. Imported before them so the provider is resolvable.
    RagModule,
    // Global: JobsService writes outbox rows in the same transaction as a job
    // insert, and the relay publishes them.
    OutboxModule,
    JobsModule,
    SemanticModule,
    TasksModule,
    // Last: it reads entities from Jobs/Profile and guards from Auth.
    AdminModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
