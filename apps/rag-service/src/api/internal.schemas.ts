import { z } from 'zod';
import { DOCUMENT_KINDS, MAX_DOCUMENT_BYTES, isAllowedDocumentMime } from '@job-agent/shared';

/**
 * Request schemas for the internal API, kept apart from the controllers so each
 * class stays small enough to stay readable.
 */

const uuid = z.string().uuid();

export const ingestDocumentSchema = z.object({
  documentId: uuid,
  profileId: uuid,
});

/**
 * Opening an upload. The job agent has already authenticated the user and
 * validated the file, so this only re-checks the invariants that the object
 * store must not be asked to violate regardless of who called.
 */
export const presignDocumentSchema = z.object({
  documentId: uuid,
  profileId: uuid,
  userId: uuid,
  kind: z.enum(DOCUMENT_KINDS),
  fileName: z.string().min(1).max(255),
  // Re-checked here even though the job agent already validated it: the mime
  // type decides which extractor runs and is what the object is stored as, so
  // this boundary is the one that must not accept an arbitrary type.
  mimeType: z
    .string()
    .min(1)
    .max(120)
    .refine(isAllowedDocumentMime, 'Unsupported file type. Allowed: PDF, DOCX, TXT, MD.'),
  sizeBytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
  isPrimary: z.boolean().optional(),
});

/** Metadata for a relayed (local-mode) upload, sent as headers next to the bytes. */
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
