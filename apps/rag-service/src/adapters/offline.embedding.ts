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
 * understanding of synonymy, which is exactly the gap a real model fills. It is
 * never a good retrieval model, so it is restricted to this purpose.
 *
 * Being deterministic also makes retrieval assertions in tests meaningful.
 */
@Injectable()
export class OfflineEmbedding implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  constructor(dimensions = 384) {
    this.model = 'offline-hashed-bow';
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
    const compact = lower.replace(/\s+/g, ' ').trim();
    for (let i = 0; i < Math.max(0, compact.length - 3); i += 2) {
      addHash(v, `#${compact.slice(i, i + 3)}`, 0.15);
    }

    return l2normalizeArray(v);
  }
}

/** Signed hashing: two buckets per feature so collisions partially cancel. */
function addHash(v: Float64Array, feature: string, weight: number): void {
  let h1 = 2166136261;
  for (let i = 0; i < feature.length; i++) {
    h1 ^= feature.charCodeAt(i);
    h1 = Math.imul(h1, 16777619);
  }
  const h2 = Math.imul(h1 ^ 0x9e3779b9, 2654435761);
  const i1 = Math.abs(h1) % v.length;
  const i2 = Math.abs(h2) % v.length;
  v[i1] += weight;
  v[i2] -= weight * 0.5;
}

function l2normalizeArray(v: Float64Array): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return Array.from(v);
  return Array.from(v, (x) => x / norm);
}
