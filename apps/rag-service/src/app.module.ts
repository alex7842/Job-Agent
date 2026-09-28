// Side-effect import: must run before the TypeOrmModule options below, which
// read process.env at module-evaluation time.
import './env.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentEntity } from './database/document.entity.js';
import { DocumentRepository } from './database/document.repository.js';
import { EmbeddingsModule } from './embeddings.module.js';
import { VectorStoreModule } from './vector-store.module.js';
import { ObjectStoreModule } from './object-store.module.js';
import { IngestionService } from './ingestion/ingestion.service.js';
import { TextExtractor } from './ingestion/text-extractor.service.js';
import { InternalDocumentsController } from './api/internal-documents.controller.js';
import { InternalSearchController } from './api/internal-search.controller.js';
import { InternalIngestionController } from './api/internal-ingestion.controller.js';
import { InternalGuard } from './api/internal.guard.js';
import { HealthController } from './api/health.controller.js';
import { IndexingConsumer } from './kafka/indexing.consumer.js';
import { KafkaPublisherService } from './kafka/publisher.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    // synchronize stays off: the RAG service has real migrations, and letting
    // TypeORM invent schema would fight the job agent's table ownership.
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      entities: [DocumentEntity],
      synchronize: false,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    }),
    TypeOrmModule.forFeature([DocumentEntity]),
    EmbeddingsModule,
    VectorStoreModule,
    ObjectStoreModule,
  ],
  controllers: [
    InternalSearchController,
    InternalDocumentsController,
    InternalIngestionController,
    HealthController,
    IndexingConsumer,
  ],
  providers: [
    IngestionService,
    TextExtractor,
    DocumentRepository,
    InternalGuard,
    KafkaPublisherService,
  ],
})
export class AppModule {}
