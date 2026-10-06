import 'reflect-metadata';
import '../env.js';
import { DataSource } from 'typeorm';

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
 * Standalone data source for the TypeORM CLI.
 *
 * The RAG service keeps no tables of its own any more: a resume is extracted on
 * the way through and its text lands on the job agent's profile row, so there is
 * nothing here for a migration to create.
 */
export const AppDataSource = new DataSource({ ...databaseOptions, synchronize: false });
