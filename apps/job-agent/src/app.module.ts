import './env.js';
import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { RagModule } from './rag/rag.module.js';
import { SemanticModule } from './semantic/semantic.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { TypeOrmModule } from '@nestjs/typeorm';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    // Global so KafkaModule / sources / TemporalClientService can inject ConfigService.
    // The monorepo's root .env is already in process.env (see ./env.ts).
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 5432,
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      autoLoadEntities: true,
      // dev convenience (DB_SYNC=true in .env); prod should use `pnpm migration:run`
      synchronize: process.env.DB_SYNC === 'true',
    }),
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    ObserveModule.forRoot({
      appKey: 'YOUR_APP_KEY',
      appSecret: 'YOUR_APP_SECRET',
      serviceId: 'task-app',
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
    DocumentsModule,
    SemanticModule,
    TasksModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
