import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pinecone } from '@pinecone-database/pinecone';
import type { VectorRecord } from '@job-agent/shared';
import type { QueryOptions, VectorMatch, VectorStore } from '../ports.js';

/**
 * Pinecone serverless. Vectors live in one namespace per user, with a `kind`
 * metadata field separating job postings from document chunks, so a single
 * embedding space holds both and the two can be compared directly.
 *
 * The index dimension is fixed at creation time and must equal the embedding
 * model's output, so ping() compares them and fails loudly — a mismatch
 * otherwise shows up as a mysteriously empty index.
 *
 * Docs: https://docs.pinecone.io/guides/index-data
 */
@Injectable()
export class PineconeVectorStore implements VectorStore {
  readonly name = 'pinecone';
  private readonly log = new Logger(PineconeVectorStore.name);
  private readonly client: Pinecone;
  private readonly indexName: string;
  private readonly expectedDims: number;

  /** Upserting in batches of 100 is Pinecone's documented per-request limit. */
  private static readonly UPSERT_BATCH = 100;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('PINECONE_API_KEY');
    const indexName = config.get<string>('PINECONE_INDEX', 'job-agent');
    const expectedDims = Number(config.get<string>('PINECONE_DIMENSIONS', '0')) || 0;

    if (!apiKey) throw new Error('PINECONE_API_KEY is required for VECTOR_STORE=pinecone');
    if (!expectedDims) {
      throw new Error(
        'PINECONE_DIMENSIONS is required for VECTOR_STORE=pinecone: the index dimension must match the embedding model.',
      );
    }

    this.client = new Pinecone({ apiKey });
    this.indexName = indexName;
    this.expectedDims = expectedDims;
  }

  async upsert(namespace: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const ns = this.client.index(this.indexName).namespace(namespace);

    for (let i = 0; i < records.length; i += PineconeVectorStore.UPSERT_BATCH) {
      const batch = records.slice(i, i + PineconeVectorStore.UPSERT_BATCH);
      await ns.upsert(
        batch.map((r) => ({
          id: r.id,
          values: r.values,
          metadata: {
            ...r.metadata,
            // Pinecone caps metadata size per record; the tail of a chunk is
            // only used for display, so truncating here is harmless.
            text: r.metadata.text.slice(0, 4_000),
          },
        })),
      );
    }
    this.log.debug(`Upserted ${records.length} vectors into ${namespace}`);
  }

  async query(namespace: string, vector: number[], options: QueryOptions): Promise<VectorMatch[]> {
    const result = await this.client
      .index(this.indexName)
      .namespace(namespace)
      .query({
        vector,
        topK: options.topK,
        filter: options.filter as Record<string, unknown> | undefined,
        includeMetadata: options.includeText !== false,
      });

    return (result.matches ?? []).map((m) => ({
      id: m.id,
      score: m.score ?? 0,
      metadata: (m.metadata ?? {}) as Record<string, unknown>,
    }));
  }

  async listIds(namespace: string, idPrefix: string): Promise<string[]> {
    const ns = this.client.index(this.indexName).namespace(namespace);
    const ids: string[] = [];
    let token: string | undefined;

    do {
      // The SDK's option type wants a string, so only pass a token once we
      // actually have one; the first page starts from the beginning.
      const page = await ns.listPaginated({
        prefix: idPrefix,
        limit: 1_000,
        ...(token ? { paginationToken: token } : {}),
      });
      // The SDK types `id` as optional on a list entry, so narrow rather than
      // trusting it: a vector with no id could never be deleted anyway.
      for (const vector of page.vectors ?? []) {
        if (typeof vector.id === 'string') ids.push(vector.id);
      }
      token = page.pagination?.next;
    } while (token);

    return ids;
  }

  async deleteByIds(namespace: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.index(this.indexName).namespace(namespace).deleteMany(ids);
  }

  /**
   * Pinecone has no server-side prefix delete, so list the namespace and delete
   * what matches. Idempotent, which is what deleting a document relies on.
   */
  async deleteByPrefix(namespace: string, idPrefix: string): Promise<void> {
    const ids = await this.listIds(namespace, idPrefix);
    await this.deleteByIds(namespace, ids);
    if (ids.length > 0)
      this.log.log(`Deleted ${ids.length} vectors matching ${idPrefix} in ${namespace}`);
  }

  async deleteNamespace(namespace: string): Promise<void> {
    await this.client.index(this.indexName).namespace(namespace).deleteAll();
    this.log.log(`Deleted namespace ${namespace}`);
  }

  async ping(): Promise<void> {
    const described = await this.client.describeIndex(this.indexName);
    const actual = described.dimension;
    if (actual !== this.expectedDims) {
      throw new Error(
        `Pinecone index "${this.indexName}" has ${actual} dimensions but the embedding provider produces ` +
          `${this.expectedDims}. Re-create the index with the matching dimension, or set PINECONE_DIMENSIONS=${actual}.`,
      );
    }
    this.log.log(`Pinecone index "${this.indexName}" ready (${actual} dims, ${described.metric})`);
  }
}
