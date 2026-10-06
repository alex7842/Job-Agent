import { randomUUID } from 'node:crypto';
import type { VectorRecord } from '@job-agent/shared';

/**
 * Ports (driven interfaces) for everything the RAG service needs from the
 * outside world. Each has a real adapter and a local one, selected by env, so
 * the whole pipeline runs with zero credentials and the adapters stay testable.
 */

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');
export const VECTOR_STORE = Symbol('VECTOR_STORE');
export const OBJECT_STORE = Symbol('OBJECT_STORE');

export interface EmbeddingProvider {
  /** Stable id recorded with vectors, so a model change is traceable. */
  readonly model: string;
  /** Must match the dimensionality of the configured Pinecone index. */
  readonly dimensions: number;

  /**
   * Embed many texts in one call. Implementations must preserve input order —
   * callers zip results back onto their chunks positionally.
   */
  embed(texts: string[]): Promise<number[][]>;
}

export interface QueryOptions {
  topK: number;
  /** Pinecone metadata filter, e.g. { kind: 'job', profileId: '...' }. */
  filter?: Record<string, unknown>;
  /** Include the stored chunk text so results can be explained. */
  includeText?: boolean;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface VectorStore {
  readonly name: string;

  /**
   * One namespace per user, so a missing filter is a hard failure to leak
   * rather than a silent cross-user read. Namespaces are created implicitly.
   */
  upsert(namespace: string, records: VectorRecord[]): Promise<void>;

  query(namespace: string, vector: number[], options: QueryOptions): Promise<VectorMatch[]>;

  /** Ids currently stored under a prefix. Used to find chunks a re-index replaced. */
  listIds(namespace: string, idPrefix: string): Promise<string[]>;

  /** Delete specific ids. Vectors that are absent are not an error. */
  deleteByIds(namespace: string, ids: string[]): Promise<void>;

  /** Prefix delete, used to drop every chunk of a deleted document. */
  deleteByPrefix(namespace: string, idPrefix: string): Promise<void>;

  /** Removes the namespace outright. Used when a profile is deleted. */
  deleteNamespace(namespace: string): Promise<void>;

  /** Cheap health probe so /health can report a broken configuration. */
  ping(): Promise<void>;
}

export interface StoredObject {
  body: Buffer;
  contentType: string;
  etag: string | null;
}

export interface ObjectStore {
  readonly name: string;

  /** Stream a PUT straight to the bucket and return only what we need. */
  put(key: string, body: Buffer, contentType: string): Promise<{ etag: string | null }>;

  get(key: string): Promise<StoredObject>;

  /** Signed URL the browser can upload to directly, so bytes never transit the API. */
  presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string>;

  /**
   * Signed, expiring URL the browser can open in a new tab to view a stored file.
   *
   * `fileName` sets the name and `inline` disposition so a PDF renders in the tab
   * rather than being saved. `contentType` overrides the type S3 would send, which
   * is what rescues an object stored as application/octet-stream by an older
   * version — the browser downloads those rather than rendering them.
   */
  presignGet(
    key: string,
    expiresInSeconds: number,
    options?: { fileName?: string; contentType?: string },
  ): Promise<string>;

  delete(key: string): Promise<void>;

  /** Cheap health probe so /health can report a broken configuration. */
  ping(): Promise<void>;
}

/** Namespace for everything belonging to one user. */
export const namespaceFor = (profileId: string) => `user-${profileId}`;

/**
 * Deterministic vector id. Same input -> same id, so re-indexing a document or
 * a job overwrites in place instead of accumulating near-duplicate vectors.
 */
export const vectorId = (kind: 'job' | 'document', ownerId: string, chunkIndex: number) =>
  `${kind}:${ownerId}:${chunkIndex}`;

/**
 * Where an uploaded object is stored. Generated here, by the service that owns
 * the object store, so the job agent never has to know a bucket layout — it
 * only records the key it is handed.
 *
 * The random component means a re-upload never overwrites the previous object
 * in place, so a failed index can still be re-run against the old bytes.
 */
export const buildObjectKey = (profileId: string, fileName: string): string => {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  return `documents/${profileId}/${randomUUID()}-${safe}`;
};
