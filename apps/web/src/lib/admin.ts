import type { AdminOverview } from '@job-agent/shared';
import { api } from './api';

/**
 * GET /admin/overview
 *
 * A thin re-export rather than a second fetch: `api.ts` owns the bearer token,
 * the single-flight refresh, and the `/api` prefix, so calling `fetch` from here
 * would bypass all three.
 */
export const adminOverview = (): Promise<AdminOverview> => api.adminOverview();
