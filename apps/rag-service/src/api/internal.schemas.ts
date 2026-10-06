import { z } from 'zod';

/**
 * Request schemas for the internal API, kept apart from the controllers so each
 * class stays small enough to stay readable.
 */

const uuid = z.string().uuid();

/**
 * The profile id of a relayed upload, as a header next to the bytes: the body is
 * a PDF or DOCX, so there is nowhere to put it in a JSON envelope.
 */
export const relayedUploadHeaders = {
  profileId: 'x-rag-profile-id',
  sizeBytes: 'x-rag-size-bytes',
} as const;

/**
 * Bounded at 200 jobs per call. A run that finds more is chunked by the caller
 * rather than sent as one body: a single huge request is more likely to be
 * rejected by a proxy, and smaller batches give partial progress on failure.
 */
export const ingestJobsSchema = z.object({
  profileId: uuid,
  userId: uuid,
  jobs: z
    .array(
      z.object({
        jobId: z.string().min(1),
        runId: z.string().optional(),
        title: z.string().optional(),
        company: z.string().optional(),
        source: z.string().optional(),
        text: z.string().min(1),
      }),
    )
    .max(200),
});
