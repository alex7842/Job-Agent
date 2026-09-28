import { z } from 'zod';

/**
 * Contracts for the RAG pipeline (apps/rag-service) and the document store that
 * feeds it.
 *
 * Shape of the flow:
 *
 *   documents.changed  -> extract text from S3 -> chunk -> embed -> Pinecone
 *   jobs.index         -> chunk job text      -> embed -> Pinecone
 *   POST /internal/search -> embed the resume + each wanted role,
 *                             query Pinecone per query, merge with RRF
 *
 * Job vectors and resume vectors deliberately share one namespace and one
 * embedding model, because comparing them is the entire point.
 */

export const VECTOR_KINDS = ['job', 'document'] as const;
export type VectorKind = (typeof VECTOR_KINDS)[number];

/** What a stored vector represents. Lets one namespace serve both corpora. */
export const VectorKind = { JOB: 'job', DOCUMENT: 'document' } as const satisfies Record<
  string,
  VectorKind
>;

// ---------- documents ----------

export const DOCUMENT_KINDS = ['resume', 'cover_letter', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_STATUSES = [
  'uploaded', // object is in the bucket, nothing extracted yet
  'indexing', // a consumer is extracting/embedding it
  'ready', // chunks are in the vector store
  'failed', // extraction or embedding failed; errorMessage says why
  'deleted', // soft-deleted, vectors removed
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_STATUS = {
  UPLOADED: 'uploaded',
  INDEXING: 'indexing',
  READY: 'ready',
  FAILED: 'failed',
  DELETED: 'deleted',
} as const satisfies Record<string, DocumentStatus>;

/** Bytes. Keeps a stray 2GB file from wedging the extractors. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const ALLOWED_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
] as const;

export const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'txt', 'md'] as const;
export type DocumentExtension = (typeof DOCUMENT_EXTENSIONS)[number];

export const isAllowedDocumentMime = (mime: string): boolean =>
  (ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(mime.split(';')[0].trim());

/** Derive the extension from the file name; used to pick an extractor. */
export const documentExtension = (fileName: string): DocumentExtension | null => {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return (DOCUMENT_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as DocumentExtension)
    : null;
};

export type DocumentSummary = {
  id: string;
  profileId: string;
  kind: DocumentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  /** Set while a resume is used as the search query source. */
  isPrimary: boolean;
  chunkCount: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export const documentKindSchema = z.enum(DOCUMENT_KINDS);

// ---------- ingestion ----------

/** One vector in the store. Ids are deterministic so re-indexing overwrites. */
export type VectorRecord = {
  id: string;
  values: number[];
  metadata: VectorMetadata;
};

export type VectorMetadata = {
  kind: VectorKind;
  profileId: string;
  userId: string;
  /** jobs only */
  jobId?: string;
  runId?: string;
  source?: string;
  title?: string;
  company?: string;
  /** documents only */
  documentId?: string;
  documentKind?: DocumentKind;
  chunkIndex?: number;
  /** The embedded text, kept for reranking and for explaining a match. */
  text: string;
};

export type IngestDocumentsResult = {
  documentId: string;
  chunks: number;
  /** Chunk vectors actually written; 0 when the document had no text. */
  indexed: number;
  status: DocumentStatus;
  errorMessage?: string;
};

// ---------- uploads ----------

/**
 * How the bytes reach the object store.
 *
 * 's3' is the production path: the RAG service presigns a PUT and the browser
 * sends the file straight to the bucket, so the bytes never touch either API.
 * 'local' is the credential-free dev path, where the bytes have to be relayed
 * through the job agent because there is no bucket to presign against.
 */
export const UPLOAD_MODES = ['s3', 'local'] as const;
export type UploadMode = (typeof UPLOAD_MODES)[number];

export type PresignDocumentRequest = {
  /** Minted by the job agent, which owns the document catalog. */
  documentId: string;
  profileId: string;
  userId: string;
  kind: DocumentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  isPrimary?: boolean;
};

export type PresignDocumentResponse = {
  /** Where the object lives. Owned by the RAG service; the caller only stores it. */
  objectKey: string;
  mode: UploadMode;
  /** A presigned bucket URL when mode is 's3'; null in local mode. */
  uploadUrl: string | null;
  expiresInSeconds: number;
  maxBytes: number;
};

export type IngestJobsResult = {
  indexed: number;
  /** Jobs skipped because they had no text worth embedding. */
  skipped: number;
};

// ---------- search ----------

export type SearchRequest = {
  profileId: string;
  userId: string;
  /**
   * Raw text to embed as the query. Omit it to let the RAG service build the
   * query from the user's own documents (see `documentIds`), which is the
   * normal case: the resume is already indexed, so re-shipping its text from
   * the job agent would be a second copy of the same thing.
   */
  queryText?: string;
  /** Documents whose extracted text becomes the query. */
  documentIds?: string[];
  /** One query per wanted role; merged with RRF alongside the other queries. */
  roleQueries?: string[];
  topK?: number;
  /** Restrict to jobs discovered in this run (a manual "search now"). */
  runId?: string;
  /** 'hybrid' re-ranks the semantic hits with the LLM. */
  strategy?: 'semantic' | 'hybrid';
};

export type SearchHit = {
  jobId: string;
  score: number;
  /** 0-1, averaged over the queries that retrieved this job. */
  similarity: number;
  title: string | null;
  company: string | null;
  source: string | null;
  /** Best-matching chunk, so a UI can explain the match. */
  snippet: string | null;
  /** Which query surfaces contributed; RRF makes this meaningful. */
  matchedBy: string[];
};

export type SearchResponse = {
  hits: SearchHit[];
  /** Which adapter actually ran, so a fallback is never mistaken for a real model. */
  embeddingModel: string;
  vectorStore: string;
  /** True when no index was available and results came from the fallback path. */
  degraded: boolean;
};

/** A query longer than this is truncated; embedding cost is linear in length. */
export const MAX_QUERY_CHARS = 20_000;

/** Documents whose text is folded into one query. More is just noise. */
export const MAX_QUERY_DOCUMENTS = 10;

const searchRequestShape = z.object({
  profileId: z.string().min(1),
  userId: z.string().min(1),
  queryText: z.string().max(MAX_QUERY_CHARS).optional(),
  documentIds: z.array(z.string().min(1)).max(MAX_QUERY_DOCUMENTS).optional(),
  roleQueries: z.array(z.string().min(1).max(500)).max(10).optional(),
  topK: z.number().int().min(1).max(200).optional(),
  runId: z.string().optional(),
  strategy: z.enum(['semantic', 'hybrid']).optional(),
});

/**
 * At least one query source is required. Accepting an all-empty request would
 * return zero hits with `degraded: false`, which reads to a caller exactly like
 * "this candidate genuinely matches nothing" — the most expensive way to be
 * wrong.
 */
export const searchRequestSchema = searchRequestShape.refine(
  (r) =>
    Boolean(r.queryText?.trim()) ||
    Boolean(r.documentIds?.length) ||
    Boolean(r.roleQueries?.some((q) => q.trim())),
  { message: 'One of queryText, documentIds or roleQueries is required' },
);

/** The standard RRF damping constant. Larger values flatten rank differences. */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion. Merges ranked lists from independent queries without
 * needing their scores on a common scale — cosine and BM25-style scores are not
 * comparable, ranks are.
 *
 * `keyOf` is required, and that is the whole point: the same posting arrives as a
 * *different object* from each query, so fusing on object identity would treat
 * every occurrence as distinct and return duplicates. Items are therefore keyed
 * by a stable id, and the first occurrence supplies the representative payload.
 */
export function reciprocalRankFusion<T>(
  rankedLists: Array<{ label: string; items: T[] }>,
  keyOf: (item: T) => string,
  k = RRF_K,
): Array<{ item: T; score: number; matchedBy: string[] }> {
  const fused = new Map<string, { item: T; score: number; matchedBy: string[] }>();

  for (const { label, items } of rankedLists) {
    items.forEach((item, index) => {
      const key = keyOf(item);
      const contribution = 1 / (k + index + 1);
      const existing = fused.get(key);
      if (existing) {
        existing.score += contribution;
        if (!existing.matchedBy.includes(label)) existing.matchedBy.push(label);
      } else {
        fused.set(key, { item, score: contribution, matchedBy: [label] });
      }
    });
  }

  return [...fused.values()].sort((a, b) => b.score - a.score);
}
