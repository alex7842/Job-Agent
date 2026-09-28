import 'reflect-metadata';
import '../env.js';
import { DataSource } from 'typeorm';
import { DocumentEntity } from './document.entity.js';

/** Discrete DB_* fields, matching apps/job-agent so one .env drives both services. */
export const databaseOptions = {
  type: 'postgres' as const,
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
};

/**
 * Standalone data source for the TypeORM CLI, so `pnpm migration:run` targets
 * whatever database the process was given.
 */
export const AppDataSource = new DataSource({
  ...databaseOptions,
  entities: [DocumentEntity],
  migrations: ['dist/database/migrations/*.js'],
  // Never on: the RAG service owns real migrations, and letting TypeORM invent
  // schema would fight the job agent's table ownership.
  synchronize: false,
});
