import { Injectable, Logger } from '@nestjs/common';
import type { VectorRecord } from '@job-agent/shared';
import type { QueryOptions, VectorMatch, VectorStore } from '../ports.js';

type Entry = { id: string; values: number[]; metadata: Record<string, unknown> };

/**
 * In-process cosine-similarity store.
 *
 * This is the default when no Pinecone key is present, and it is what the tests
 * run against. It exists so the RAG flow is runnable and verifiable on a laptop
 * with no cloud account: same interface, same ranking maths, no network. The
 * tradeoff is that vectors do not survive a restart and live in one process.
 */
@Injectable()
export class MemoryVectorStore implements VectorStore {
  readonly name = 'memory';
  private readonly log = new Logger(MemoryVectorStore.name);
  private readonly namespaces = new Map<string, Map<string, Entry>>();
  private dimensions = 0;

  async upsert(namespace: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const store = this.namespaces.get(namespace) ?? new Map<string, Entry>();

    for (const record of records) {
      if (record.values.length !== this.dimensions) {
        // Guards against a dimension change mid-process, which would silently
        // poison every subsequent similarity score.
        if (this.dimensions === 0) this.dimensions = record.values.length;
        else
          throw new Error(
            `Embedding dimension changed mid-process: store was built with ${this.dimensions}, received ${record.values.length}. Restart the service.`,
          );
      }
      store.set(record.id, {
        id: record.id,
        values: record.values,
        metadata: record.metadata as Record<string, unknown>,
      });
    }

    this.namespaces.set(namespace, store);
  }

  async query(namespace: string, vector: number[], options: QueryOptions): Promise<VectorMatch[]> {
    const store = this.namespaces.get(namespace);
    if (!store || store.size === 0) return [];

    const scored: VectorMatch[] = [];
    for (const entry of store.values()) {
      if (options.filter && !matchesFilter(entry.metadata, options.filter)) continue;
      scored.push({
        id: entry.id,
        score: cosine(vector, entry.values),
        metadata: entry.metadata,
      });
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, options.topK);
  }

  async listIds(namespace: string, idPrefix: string): Promise<string[]> {
    const store = this.namespaces.get(namespace);
    if (!store) return [];
    return [...store.keys()].filter((id) => id.startsWith(idPrefix));
  }

  async deleteByIds(namespace: string, ids: string[]): Promise<void> {
    const store = this.namespaces.get(namespace);
    if (!store || ids.length === 0) return;
    for (const id of ids) store.delete(id);
  }

  async deleteByPrefix(namespace: string, idPrefix: string): Promise<void> {
    const store = this.namespaces.get(namespace);
    if (!store) return;
    // Map iterators tolerate deleting the entry they are on, so no snapshot copy.
    for (const id of store.keys()) {
      if (id.startsWith(idPrefix)) store.delete(id);
    }
  }

  async deleteNamespace(namespace: string): Promise<void> {
    this.namespaces.delete(namespace);
  }

  async ping(): Promise<void> {
    const size = [...this.namespaces.values()].reduce((n, s) => n + s.size, 0);
    this.log.log(
      `In-memory vector store ready (${this.namespaces.size} namespaces, ${size} vectors)`,
    );
  }

  /** Test/introspection helper. */
  sizeOf(namespace: string): number {
    return this.namespaces.get(namespace)?.size ?? 0;
  }
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Supports the equality and $in/$eq/$ne forms we actually send, and treats an
 * unknown operator as "does not match" so a typo cannot silently widen a filter.
 */
export function matchesFilter(
  metadata: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    const actual = metadata[key];

    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      const ops = expected as Record<string, unknown>;
      if ('$in' in ops) {
        if (!Array.isArray(ops.$in) || !ops.$in.includes(actual)) return false;
      } else if ('$eq' in ops) {
        if (actual !== ops.$eq) return false;
      } else if ('$ne' in ops) {
        if (actual === ops.$ne) return false;
      } else {
        return false;
      }
      continue;
    }

    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
      continue;
    }

    if (actual !== expected) return false;
  }
  return true;
}
