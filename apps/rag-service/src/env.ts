import { config as loadEnvFile } from 'dotenv';
import { resolve } from 'node:path';

/**
 * Preloads env vars for the whole process.
 *
 * The monorepo keeps ONE .env at the root, but every script runs with cwd set to
 * this package (pnpm/turbo guarantee that), so the root file is `../../.env` from
 * here. `dotenv` never overrides an already-set variable, so the root file wins
 * and `apps/rag-service/.env` (if present) only fills the gaps — and real
 * environment variables in production always win over both.
 *
 * Imported for its side effect at the top of app.module.ts and data-source.ts,
 * because those read process.env at module-evaluation time.
 */
loadEnvFile({ path: resolve(process.cwd(), '../../.env') });
loadEnvFile();
