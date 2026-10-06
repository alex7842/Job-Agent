import { postJson, truncate } from './http.js';
import type { ProviderDescriptor } from './providers.js';
import { AiError, type EmbeddingModel } from './ports.js';

export type EmbeddingModelConfig = {
  /** Provider name from config; resolved by the factory. */
  provider?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Must match the vector store's index dimension. */
  dimensions?: number;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  onCall?: (info: { provider: string; model: string; texts: number; ms: number }) => void;
};

export type HttpEmbeddingModelOptions = Omit<EmbeddingModelConfig, 'provider'> & {
  descriptor: ProviderDescriptor;
};

/**
 * Embeddings over the OpenAI-compatible wire format.
 *
 * Two invariants are enforced here rather than trusted, because both failures
 * are silent and expensive:
 *
 * 1. Rows are matched by the `index` field, not by arrival order, and any
 *    mismatch in count or index throws. Callers zip vectors back onto chunks
 *    positionally, so a reordered response would attach the wrong vector to
 *    the wrong chunk and nothing downstream would notice.
 * 2. Every returned vector must have exactly `dimensions` components. A short
 *    vector is the fingerprint of writing two models into one index, which
 *    Pinecone rejects loudly here rather than the ranking quietly going wrong.
 */
export class HttpEmbeddingModel implements EmbeddingModel {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;

  private readonly url: string;
  private readonly apiKey: string;
  private readonly apiKeyEnv: string;
  private readonly descriptor: ProviderDescriptor;
  private readonly flavor: NonNullable<ProviderDescriptor['embeddings']>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly onCall?: HttpEmbeddingModelOptions['onCall'];

  constructor(options: HttpEmbeddingModelOptions) {
    const { descriptor } = options;
    const flavor = descriptor.embeddings;
    if (!flavor) {
      throw new Error(`${descriptor.label} does not offer an embeddings endpoint in this layer.`);
    }
    this.descriptor = descriptor;
    this.flavor = flavor;
    this.provider = descriptor.label;
    this.model = options.model ?? flavor.defaultModel ?? '';
    this.apiKeyEnv = options.apiKeyEnv ?? descriptor.apiKeyEnv[0] ?? 'AI_API_KEY';
    this.apiKey = options.apiKey ?? '';
    this.dimensions = options.dimensions ?? flavor.defaultDimensions ?? 0;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.sleep = options.sleep;
    this.onCall = options.onCall;

    if (!this.model) {
      throw new Error(`No embedding model given for ${descriptor.label}. Set EMBEDDING_MODEL.`);
    }
    if (!this.dimensions) {
      throw new Error(
        `Embedding dimensions are unknown for ${descriptor.label}. ` +
          `Set EMBEDDING_DIMENSIONS to match your index (e.g. ${flavor.defaultDimensions ?? 1024}).`,
      );
    }
    const base = (options.baseUrl ?? descriptor.baseUrl).replace(/\/+$/, '');
    if (!base) {
      throw new Error(`${descriptor.label} needs a base URL. Set AI_BASE_URL=https://host/v1.`);
    }
    this.url = `${base}${flavor.path}`;
  }

  missingCredential(): boolean {
    return this.descriptor.requiresApiKey && !this.apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (this.missingCredential()) {
      throw new AiError(
        `${this.apiKeyEnv} is not set, so ${this.provider} cannot embed. ` +
          (this.descriptor.signupUrl ? `Get a key at ${this.descriptor.signupUrl}` : '') +
          ' — or switch with EMBEDDING_PROVIDER.',
        { provider: this.provider, model: this.model },
      );
    }

    const batchSize = this.flavor.maxBatch ?? 64;
    const out: number[][] = [];
    const startedAt = Date.now();

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      out.push(...(await this.batch(batch)));
    }

    this.onCall?.({
      provider: this.provider,
      model: this.model,
      texts: texts.length,
      ms: Date.now() - startedAt,
    });
    return out;
  }

  private async batch(texts: string[]): Promise<number[][]> {
    const capped = texts.map((t) => truncate(t, this.flavor.maxInputChars ?? 24_000));
    const payload: Record<string, unknown> = {
      model: this.model,
      [this.flavor.inputField]: capped,
    };
    // Only sent where the provider documents it: a model that does not know the
    // field rejects the whole request with a 400.
    if (this.flavor.dimensionsParam) payload[this.flavor.dimensionsParam] = this.dimensions;

    const json = await postJson(
      this.url,
      {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey || 'not-needed'}`,
        ...(this.descriptor.headers ?? {}),
      },
      payload,
      {
        provider: this.provider,
        model: this.model,
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
        ...(this.sleep ? { sleep: this.sleep } : {}),
      },
    );

    const rows = (json as { data?: Array<{ index?: number; embedding?: number[] }> } | null)?.data;
    if (!rows || rows.length !== texts.length) {
      throw new AiError(
        `${this.provider} returned ${rows?.length ?? 0} embeddings for ${texts.length} inputs`,
        { provider: this.provider, model: this.model },
      );
    }

    return (
      rows
        .map((row, position) => ({ row, position }))
        // `index` is the documented contract; position is only a fallback for
        // providers that omit it.
        .sort((a, b) => (a.row.index ?? a.position) - (b.row.index ?? b.position))
        .map(({ row, position }) => {
          const vector = row.embedding;
          if (!Array.isArray(vector)) {
            throw new AiError(
              `${this.provider} returned an unusable embedding for input ${position}`,
              {
                provider: this.provider,
                model: this.model,
              },
            );
          }
          if (vector.length !== this.dimensions) {
            throw new AiError(
              `${this.provider} ${this.model} returned a ${vector.length}-d vector but ` +
                `${this.dimensions} was expected. The index dimension and the embedding model must ` +
                `agree; mixing models in one index produces meaningless similarity scores.`,
              { provider: this.provider, model: this.model },
            );
          }
          return l2normalize(vector);
        })
    );
  }
}

/**
 * Not every provider returns unit-length vectors, and a cosine metric on
 * un-normalised input silently ranks short chunks highest — length starts
 * scoring as if it were relevance. Normalising makes the metric mean what it
 * says on every provider.
 */
export function l2normalize(vector: number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}
