import { Injectable } from '@nestjs/common';
import type { EmbeddingProvider } from '../ports.js';

/**
 * A deterministic, dependency-free embedding used when no provider is
 * configured, so `pnpm dev` and the test suite exercise the real pipeline with
 * no keys and no network.
 *
 * It is a hashed bag of words plus character trigrams — a random-projection
 * style bag-of-words embedding. That gives genuine lexical similarity (shared
 * words and shared word shapes score high) and nothing more: it has no
 * understanding of synonymy, which is exactly the gap a real model fills. It
 * is never a good retrieval model, so it is restricted to this purpose.
 *
 * Being deterministic also makes retrieval assertions in tests meaningful.
 */
export const OFFLINE_EMBEDDING_MODEL = 'offline-hashed-bow';

@Injectable()
export class OfflineEmbedding implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  constructor(dimensions = 384) {
    this.model = OFFLINE_EMBEDDING_MODEL;
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const v = new Float64Array(this.dimensions);
    const lower = text.toLowerCase();

    for (const token of lower.split(/[^a-z0-9+#.]+/).filter(Boolean)) {
      addHash(v, token, 1);
      // Trigrams of the token stem catch shared morphology ("engineer" vs
      // "engineering") that exact-token matching would miss.
      if (token.length > 4) {
        const stem = token.slice(0, Math.min(7, token.length));
        addHash(v, `~${stem}`, 0.5);
      }
    }

    // Character trigrams of the raw text: fuzzy/typo tolerance.
    const flat = lower.replace(/\s+/g, ' ');
    for (let i = 0; i + 3 <= flat.length; i++) {
      addHash(v, `#${flat.slice(i, i + 3)}`, 0.25);
    }

    return l2normalizeLocal(Array.from(v));
  }
}

function addHash(v: Float64Array, token: string, weight: number): void {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  v[Math.abs(h) % v.length] += weight;
}

function l2normalizeLocal(vector: number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}
