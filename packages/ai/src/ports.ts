/**
 * Ports for the AI layer. Everything above this file speaks in terms of
 * "complete a prompt" and "embed texts", never "call Mistral" or "call
 * Fireworks", so switching provider is a config change (LLM_PROVIDER /
 * EMBEDDING_PROVIDER) rather than a code change.
 *
 * Two ports, not one, because they are swappable for different reasons: a chat
 * model can be swapped freely, while an embedding model cannot (see the note
 * on EmbeddingModel.model).
 */

/** JSON Schema object, passed through to providers that constrain decoding. */
export type JsonSchema = Record<string, unknown>;

export type TokenUsage = {
  input?: number;
  output?: number;
  total?: number;
};

/**
 * How a provider can be made to answer with JSON. Ordered strongest first.
 *
 * The distinction matters because constrained decoding is the difference
 * between "cannot return prose" and "asked nicely to return JSON": a provider
 * that only supports `json_object` still yields valid JSON but may invent
 * fields, so callers must keep validating the shape with zod regardless. It
 * also decides whether the schema is worth sending at all.
 */
export type StructuredOutput = 'json_schema' | 'json_object' | 'none';

export type ChatRequest = {
  /** Highest-priority instruction. Kept separate so providers place it correctly. */
  system?: string;
  prompt: string;
  /**
   * When present the response is parsed as JSON and returned in `data`. The
   * schema is sent to the provider as a decoding constraint when supported,
   * and always repeated in the prompt, because the model never sees it as
   * context — repeating it keeps generated strings on-topic.
   */
  schema?: JsonSchema;
  /** Name for the schema in provider APIs that require one. */
  schemaName?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
};

export type ChatResult<T = unknown> = {
  /** Parsed JSON when a schema was requested, else null. Never throws on shape. */
  data: T | null;
  /** Raw text as returned, always populated. Useful for logging failures. */
  text: string;
  model: string;
  provider: string;
  finishReason: string | null;
  usage: TokenUsage | null;
};

export interface ChatModel {
  readonly provider: string;
  readonly model: string;
  /** Capability, so callers and tests can branch without provider checks. */
  readonly structuredOutput: StructuredOutput;

  /**
   * Throws `AiError` on transport, auth or rate-limit failure; returns
   * `data: null` with the raw text when the answer was not valid JSON, so a
   * malformed reply degrades one row instead of failing a whole run.
   */
  complete<T = unknown>(request: ChatRequest): Promise<ChatResult<T>>;
}

export interface EmbeddingModel {
  readonly provider: string;
  /**
   * Stable identity of the *model*, recorded on every vector written.
   *
   * This is not decoration. Vectors from two different models share no vector
   * space, so writing them into one index produces similarity scores that are
   * noise rather than an error — and a matching dimension count does not make
   * them compatible (mistral-embed and qwen3-embedding-8b are both 1024d).
   * Callers stamp this on write and filter queries by it, so a provider change
   * makes old vectors invisible instead of quietly poisoning ranking.
   */
  readonly model: string;
  readonly dimensions: number;

  /** Must preserve input order: callers zip results back positionally. */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Failure with enough context to act on: which provider, which model, what the
 * provider said. Retries are handled inside the layer, so reaching here means
 * the call genuinely failed.
 */
export class AiError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly status: number | null;

  constructor(
    message: string,
    options: { provider: string; model: string; status?: number | null },
  ) {
    super(message);
    this.name = 'AiError';
    this.provider = options.provider;
    this.model = options.model;
    this.status = options.status ?? null;
  }
}
