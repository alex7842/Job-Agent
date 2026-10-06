import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MAX_QUERY_CHARS,
  VectorKind,
  reciprocalRankFusion,
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
    private readonly config: ConfigService,
  ) {}

  // ---------- jobs ----------

  /**
   * Index job postings discovered by the job agent. Postings are chunked
   * paragraph-first so a requirement list stays intact as one unit.
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
    const queries = this.buildQueries(request);
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
   * The candidate's resume text first, because it is the most complete statement
   * of what they have done; then one query per role they want.
   */
  private buildQueries(request: SearchRequest): string[] {
    const queries: string[] = [];

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
