import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmbeddingProvider } from '../ports.js';

/**
 * Google AI Studio (gemini-embedding-001) — the default because it is free on
 * the AI Studio tier, needs only an API key, and is the strongest of the
 * free options. Matryoshka truncation lets us pin 1536 dimensions, which stays
 * inside Pinecone's serverless limit.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/embeddings
 */
export const GEMINI_MODEL = 'gemini-embedding-001';
export const GEMINI_DIMENSIONS = 1536;
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const BATCH_LIMIT = 100; // documented per-request cap
// The model caps input at 2048 tokens; ~8000 chars is a safe ceiling for
// English text and keeps one pathological chunk from failing the whole batch.
const MAX_INPUT_CHARS = 8_000;

@Injectable()
export class GeminiEmbedding implements EmbeddingProvider {
  readonly model = GEMINI_MODEL;
  readonly dimensions = GEMINI_DIMENSIONS;
  private readonly apiKey: string;

  constructor(config: ConfigService) {
    const key = config.get<string>('GEMINI_API_KEY') ?? config.get<string>('GOOGLE_API_KEY');
    if (!key) {
      throw new Error(
        'GEMINI_API_KEY is required for EMBEDDING_PROVIDER=gemini. Get a free key at https://aistudio.google.com/apikey',
      );
    }
    this.apiKey = key;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_LIMIT) {
      out.push(...(await this.batch(texts.slice(i, i + BATCH_LIMIT))));
    }
    return out;
  }

  private async batch(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${ENDPOINT}/${GEMINI_MODEL}:batchEmbedContents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${GEMINI_MODEL}`,
          content: { parts: [{ text: clip(text, MAX_INPUT_CHARS) }] },
          outputDimensionality: GEMINI_DIMENSIONS,
          taskType: 'RETRIEVAL_DOCUMENT',
        })),
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Gemini embeddings failed: ${res.status} ${clip(detail, 300)}`);
    }

    const json = (await res.json()) as { embeddings?: Array<{ values?: number[] }> };
    const vectors = (json.embeddings ?? []).map((e) => e.values ?? []);
    if (vectors.length !== texts.length) {
      throw new Error(`Gemini returned ${vectors.length} embeddings for ${texts.length} inputs`);
    }
    return vectors.map((v) => l2normalize(v));
  }
}

/** Rough token trim; keeps one pathological chunk from failing the batch. */
function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

export function l2normalize(vector: number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}
