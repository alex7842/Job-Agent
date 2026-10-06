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

export const VECTOR_KINDS = ['job'] as const;
export type VectorKind = (typeof VECTOR_KINDS)[number];

/** What a stored vector represents. Lets one namespace serve both corpora. */
export const VectorKind = { JOB: 'job' } as const satisfies Record<string, VectorKind>;

// ---------- resume files ----------

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

/**
 * The Content-Type a stored file should be *served* as, from its extension.
 *
 * Separate from what it was stored as on purpose: a bucket object written before
 * the extractor started recording the sniffed type is `application/octet-stream`,
 * and a browser downloads that instead of rendering it. Overriding the type in the
 * response fixes those objects without a re-upload.
 */
export const documentMimeFor = (fileName: string): string | null => {
  switch (documentExtension(fileName)) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'txt':
      return 'text/plain';
    case 'md':
      return 'text/markdown';
    default:
      return null;
  }
};

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
  chunkIndex?: number;
  /** The embedded text, kept for reranking and for explaining a match. */
  text: string;
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
   * Raw text to embed as the query: the candidate's resume, plus their skills.
   * Omit it when only wanted roles are known.
   */
  queryText?: string;
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

const searchRequestShape = z.object({
  profileId: z.string().min(1),
  userId: z.string().min(1),
  queryText: z.string().max(MAX_QUERY_CHARS).optional(),
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
  (r) => Boolean(r.queryText?.trim()) || Boolean(r.roleQueries?.some((q) => q.trim())),
  { message: 'One of queryText or roleQueries is required' },
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
