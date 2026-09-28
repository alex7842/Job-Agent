import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DOCUMENT_STATUS,
  MAX_QUERY_CHARS,
  VectorKind,
  reciprocalRankFusion,
  type IngestDocumentsResult,
  type IngestJobsResult,
  type SearchHit,
  type SearchRequest,
  type SearchResponse,
  type VectorRecord,
} from '@job-agent/shared';
import {
  EMBEDDING_PROVIDER,
  OBJECT_STORE,
  VECTOR_STORE,
  namespaceFor,
  vectorId,
} from '../ports.js';
import type { EmbeddingProvider, ObjectStore, VectorStore } from '../ports.js';
import { chunkText } from './chunker.js';
import { TextExtractor } from './text-extractor.service.js';
import { DocumentRepository } from '../database/document.repository.js';

/** How many characters of a chunk to return as a human-readable snippet. */
/** Env values are strings; a bad one falls back rather than becoming NaN. */
const num = (raw: string | undefined, fallback: number): number =>
  Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : fallback;

const SNIPPET_CHARS = 320;
const DEFAULT_TOP_K = 20;
/** Candidates pulled from the vector store per query, before fusion. */
const CANDIDATES_PER_QUERY = 50;
/**
 * Only this many results per query count as evidence.
 *
 * A vector store always returns k neighbours, so every query "retrieves" every
 * job somewhere in its tail. Letting the tail vote would make matchedBy and the
 * averaged similarity meaningless — every job would be credited with every
 * query. Truncating each list to the positions a reader would actually look at
 * keeps both signals honest.
 */
const MATCH_DEPTH = 10;

@Injectable()
export class IngestionService {
  private readonly log = new Logger(IngestionService.name);

  constructor(
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @Inject(VECTOR_STORE) private readonly vectors: VectorStore,
    @Inject(OBJECT_STORE) private readonly objects: ObjectStore,
    private readonly extractor: TextExtractor,
    private readonly documents: DocumentRepository,
    private readonly config: ConfigService,
  ) {}

  // ---------- documents ----------

  /**
   * Index one stored document: download it, extract text, chunk, embed, upsert.
   *
   * Ordering matters. The old chunk vectors are deleted only after the new ones
   * are written, so a failure mid-flight leaves the previous version searchable
   * instead of a hole. Deleting first would make a transient Gemini error look
   * like the user's resume disappeared.
   */
  async ingestDocument(documentId: string): Promise<IngestDocumentsResult> {
    const doc = await this.documents.findById(documentId);
    if (!doc) {
      return {
        documentId,
        chunks: 0,
        indexed: 0,
        status: DOCUMENT_STATUS.FAILED,
        errorMessage: 'Document not found',
      };
    }
    if (doc.status === DOCUMENT_STATUS.DELETED) {
      return { documentId, chunks: 0, indexed: 0, status: DOCUMENT_STATUS.DELETED };
    }

    await this.documents.updateStatus(documentId, DOCUMENT_STATUS.INDEXING);
    const namespace = namespaceFor(doc.profileId);
    const idPrefix = `${VectorKind.DOCUMENT}:${documentId}:`;

    try {
      const object = await this.objects.get(doc.objectKey);
      const extracted = await this.extractor.extract(object.body, doc.fileName);

      if (!extracted.text) {
        // A scanned PDF has no text layer. Say so plainly rather than marking it
        // ready with zero searchable content.
        await this.documents.updateStatus(
          documentId,
          DOCUMENT_STATUS.FAILED,
          'No extractable text. The file is probably a scan or image; upload a text-based PDF or DOCX.',
          0,
        );
        await this.documents.setExtractedText(documentId, null);
        return {
          documentId,
          chunks: 0,
          indexed: 0,
          status: DOCUMENT_STATUS.FAILED,
          errorMessage: 'No extractable text',
        };
      }

      // Persist the extracted text before embedding: a search built from this
      // document is useful even if the vector write below fails, and re-running
      // the extractor to recover the text would mean re-reading the object.
      await this.documents.setExtractedText(documentId, extracted.text);

      const chunks = chunkText(extracted.text);
      const records: VectorRecord[] = [];

      if (chunks.length > 0) {
        const vectors = await this.embeddings.embed(chunks.map((c) => c.text));
        chunks.forEach((chunk, i) => {
          const values = vectors[i];
          if (!values) throw new Error(`Embedding provider returned no vector for chunk ${i}`);
          records.push({
            // Deterministic id => re-indexing the same document overwrites in place.
            id: vectorId(VectorKind.DOCUMENT, documentId, chunk.index),
            values,
            metadata: {
              kind: VectorKind.DOCUMENT,
              profileId: doc.profileId,
              userId: doc.userId,
              documentId: doc.documentId,
              documentKind: doc.kind,
              chunkIndex: chunk.index,
              title: doc.fileName,
              text: chunk.text,
            },
          });
        });

        await this.vectors.upsert(namespace, records);
      }

      // Drop only the chunks this generation did not replace. A plain prefix
      // delete here would also remove what was just written; and deleting before
      // the upsert would leave a searchable hole if embedding failed halfway.
      // Ids are deterministic, so "stale" is exactly "present but not in this set".
      const stale = (await this.vectors.listIds(namespace, idPrefix)).filter(
        (id) => !records.some((r) => r.id === id),
      );
      if (stale.length > 0) {
        await this.vectors.deleteByIds(namespace, stale);
        this.log.debug(`Removed ${stale.length} stale chunk(s) for document ${documentId}`);
      }

      await this.documents.updateStatus(documentId, DOCUMENT_STATUS.READY, null, records.length);

      this.log.log(
        `Indexed document ${documentId} (${records.length} chunks, ${extracted.detected})`,
      );
      return {
        documentId,
        chunks: chunks.length,
        indexed: records.length,
        status: DOCUMENT_STATUS.READY,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`Failed to index document ${documentId}: ${message}`);
      await this.documents.updateStatus(documentId, DOCUMENT_STATUS.FAILED, message, 0);
      return {
        documentId,
        chunks: 0,
        indexed: 0,
        status: DOCUMENT_STATUS.FAILED,
        errorMessage: message,
      };
    }
  }

  /** Index every ready document for a profile; used to warm a new namespace. */
  async ingestAllForProfile(profileId: string): Promise<IngestDocumentsResult[]> {
    const rows = await this.documents.listByProfile(profileId, {
      statuses: [DOCUMENT_STATUS.UPLOADED, DOCUMENT_STATUS.READY, DOCUMENT_STATUS.FAILED],
    });
    const results: IngestDocumentsResult[] = [];
    // Sequential on purpose: a burst of concurrent embedding calls is the
    // fastest way to hit a provider rate limit and fail every document at once.
    for (const row of rows) {
      results.push(await this.ingestDocument(row.documentId));
    }
    return results;
  }

  /** Remove a document's vectors and mark it deleted. Idempotent. */
  async deleteDocument(documentId: string, profileId: string): Promise<boolean> {
    const doc = await this.documents.findOwned(documentId, profileId);
    if (!doc) return false;

    await this.vectors.deleteByPrefix(
      namespaceFor(profileId),
      `${VectorKind.DOCUMENT}:${documentId}:`,
    );
    await this.documents.markDeleted(documentId);
    this.log.log(`Deleted document ${documentId}`);
    return true;
  }

  // ---------- jobs ----------

  /**
   * Index job postings discovered by the job agent. Jobs are chunked the same
   * way documents are so both corpora share one embedding space, which is what
   * makes resume-to-posting comparison meaningful.
   */
  async ingestJobs(
    profileId: string,
    userId: string,
    jobs: Array<{
      jobId: string;
      runId?: string;
      title?: string;
      company?: string;
      source?: string;
      text: string;
    }>,
  ): Promise<IngestJobsResult> {
    if (jobs.length === 0) return { indexed: 0, skipped: 0 };

    const namespace = namespaceFor(profileId);
    const records: VectorRecord[] = [];
    let skipped = 0;

    for (const job of jobs) {
      const text = job.text.trim();
      if (text.length < 20) {
        // Too little text makes a meaningless vector that pollutes the ranking.
        skipped += 1;
        continue;
      }

      const chunks = chunkText(text);
      if (chunks.length === 0) {
        skipped += 1;
        continue;
      }

      const vectors = await this.embeddings.embed(chunks.map((c) => c.text));
      chunks.forEach((chunk, i) => {
        records.push({
          id: vectorId(VectorKind.JOB, job.jobId, chunk.index),
          values: vectors[i],
          metadata: {
            kind: VectorKind.JOB,
            profileId,
            userId,
            jobId: job.jobId,
            runId: job.runId,
            title: job.title,
            company: job.company,
            source: job.source,
            chunkIndex: chunk.index,
            text: chunk.text,
          },
        });
      });
    }

    if (records.length > 0) {
      await this.vectors.upsert(namespace, records);
    }
    this.log.log(
      `Indexed ${records.length} job chunks for profile ${profileId} (${skipped} skipped)`,
    );
    return { indexed: records.length, skipped };
  }

  // ---------- search ----------

  /**
   * Multi-query semantic search with Reciprocal Rank Fusion.
   *
   * One embedding of a whole resume performs badly: a resume mixes many roles,
   * so its vector is an average that matches everything weakly. Searching once
   * per wanted role focuses each query, and fusing the ranked lists by position
   * recovers jobs that any single query surfaced. Fusion is by rank rather than
   * score because cosine scores from separate queries are not comparable.
   */
  async search(request: SearchRequest): Promise<SearchResponse> {
    const topK = request.topK ?? DEFAULT_TOP_K;
    const namespace = namespaceFor(request.profileId);
    const queries = await this.buildQueries(request);
    const meta = (): SearchResponseMeta => ({
      embeddingModel: this.embeddings.model,
      vectorStore: this.vectors.name,
      degraded: this.isDegraded,
    });

    if (queries.length === 0) return { hits: [], ...meta() };

    // One embedding call for all query variants, batched.
    const queryVectors = await this.embeddings.embed(queries);
    const candidates = Math.max(this.maxCandidates, topK);

    const filter: Record<string, unknown> = { kind: VectorKind.JOB, profileId: request.profileId };
    if (request.runId) filter.runId = request.runId;

    const rankedLists: Array<{ label: string; items: SearchHit[] }> = [];
    for (let i = 0; i < queries.length; i++) {
      const matches = await this.vectors.query(namespace, queryVectors[i], {
        topK: candidates,
        filter,
        includeText: true,
      });
      // Only the head of each list is evidence; the tail exists just to give
      // fusion a wider pool to draw from.
      rankedLists.push({
        label: queries[i].slice(0, 60),
        items: this.toHits(matches).slice(0, this.matchDepth),
      });
    }

    // RRF decides the *order*: it is the only way to merge ranked lists whose
    // scores came from different queries. It deliberately does not decide
    // `score` — 1/(k+rank) is nearly flat, so reporting it as match strength
    // would show 0.98 for a job that barely matched. Instead the fused order is
    // combined with real evidence: the best similarity any query found.
    const fused = reciprocalRankFusion(rankedLists, (hit) => hit.jobId).slice(0, topK);
    const hits = fused.map(({ item, matchedBy }) => {
      const similarities = rankedLists
        .filter((list) => list.items.some((h) => h.jobId === item.jobId))
        .map((list) => list.items.find((h) => h.jobId === item.jobId)?.similarity ?? 0);

      return {
        ...item,
        matchedBy,
        score: similarities.length > 0 ? Math.max(...similarities) : 0,
        similarity:
          similarities.length > 0
            ? similarities.reduce((a, b) => a + b, 0) / similarities.length
            : 0,
      };
    });

    return { hits, ...meta() };
  }

  /**
   * Collect the query variants, in the order they should be embedded.
   *
   * The user's own documents come first because they are the most complete
   * statement of what they are looking for. They are read from this service's
   * index rather than re-extracted from the object: the text is already stored
   * next to the vectors, and re-parsing a PDF on every search would put the
   * slowest part of the pipeline on the latency-sensitive path.
   */
  private async buildQueries(request: SearchRequest): Promise<string[]> {
    const queries: string[] = [];

    if (request.documentIds?.length) {
      const docs = await this.documents.extractedTextFor(request.profileId, request.documentIds);
      for (const doc of docs) {
        const text = truncate(doc.text, MAX_QUERY_CHARS);
        if (text.trim()) queries.push(text);
      }
    }

    if (request.queryText?.trim()) queries.push(truncate(request.queryText, MAX_QUERY_CHARS));

    for (const role of request.roleQueries ?? []) {
      const trimmed = role.trim();
      // Skip near-duplicates of the main query; fusing a list with itself just
      // doubles that query's weight.
      if (trimmed && !queries.some((q) => q.toLowerCase() === trimmed.toLowerCase())) {
        queries.push(trimmed);
      }
    }
    return queries;
  }

  private toHits(matches: Awaited<ReturnType<VectorStore['query']>>): SearchHit[] {
    return matches.map((m) => {
      const meta = m.metadata;
      const jobId = typeof meta.jobId === 'string' ? meta.jobId : (m.id.split(':')[1] ?? m.id);
      return {
        jobId,
        // Cosine similarity of the best chunk; a vector store may return cosine
        // or dot product, so clamp into a sane 0-1 range for the contract.
        similarity: clamp01(m.score),
        score: clamp01(m.score),
        title: asString(meta.title),
        company: asString(meta.company),
        source: asString(meta.source),
        snippet: asString(meta.text)?.slice(0, SNIPPET_CHARS) ?? null,
        matchedBy: [],
      };
    });
  }

  /**
   * True when the process is running on the offline/memory fallbacks. Surfaced in
   * the API response so a degraded result set is never mistaken for a real model.
   */
  private get isDegraded(): boolean {
    return this.embeddings.model === 'offline-hashed-bow' || this.vectors.name === 'memory';
  }

  private get maxCandidates(): number {
    return num(this.config.get<string>('RAG_MAX_CANDIDATES'), CANDIDATES_PER_QUERY);
  }

  private get matchDepth(): number {
    return num(this.config.get<string>('RAG_MATCH_DEPTH'), MATCH_DEPTH);
  }

  async health(): Promise<Record<string, unknown>> {
    await this.vectors.ping();
    await this.objects.ping();
    return {
      embedding: { provider: this.embeddings.model, dimensions: this.embeddings.dimensions },
      vectorStore: { name: this.vectors.name },
      objectStore: { name: this.objects.name },
      degraded: this.isDegraded,
      maxCandidates: this.maxCandidates,
      matchDepth: this.matchDepth,
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

type SearchResponseMeta = Pick<SearchResponse, 'embeddingModel' | 'vectorStore' | 'degraded'>;
