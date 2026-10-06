import { backoffMs, clip, extractJson, postJson } from './http.js';
import type { ProviderDescriptor } from './providers.js';
import {
  AiError,
  type ChatModel,
  type ChatRequest,
  type ChatResult,
  type JsonSchema,
} from './ports.js';

export type ChatModelConfig = {
  /** Provider name from config; resolved by the factory. */
  provider?: string;
  /** Env var name, used in the "no key" error. */
  apiKeyEnv?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Override the declared capability; used by tests and by local runtimes. */
  structuredOutput?: ProviderDescriptor['chat']['structuredOutput'];
  sleep?: (ms: number) => Promise<void>;
  onCall?: (info: { provider: string; model: string; ms: number; ok: boolean }) => void;
};

export type HttpChatModelOptions = Omit<ChatModelConfig, 'provider'> & {
  descriptor: ProviderDescriptor;
};

/** Output-token budget when the caller does not name one. */
const DEFAULT_MAX_TOKENS = 2048;
/** Ceiling for the extra attempt made after a reply was cut off. */
const RETRY_MAX_TOKENS = 8192;

/**
 * Chat adapter over the OpenAI-compatible wire format, which every provider we
 * care about speaks — including local runtimes.
 *
 * The one genuinely provider-specific behaviour is how hard JSON can be
 * constrained, and that is handled as a *capability* rather than a branch: the
 * descriptor declares the strongest guarantee, and if the provider rejects the
 * request the instance quietly downgrades to `json_object` and, failing that,
 * to prompt-only for the rest of its life. A provider that adds or drops schema
 * support therefore degrades one row at a time instead of breaking every call.
 */
export class HttpChatModel implements ChatModel {
  readonly provider: string;
  readonly model: string;
  structuredOutput: 'json_schema' | 'json_object' | 'none';

  private readonly url: string;
  private readonly apiKey: string;
  private readonly apiKeyEnv: string;
  private readonly flavor: ProviderDescriptor['chat'];
  private readonly descriptor: ProviderDescriptor;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly onCall?: HttpChatModelOptions['onCall'];
  /** Set once a 400 proves this model cannot take the constraint we sent. */
  private downgradedTo: 'json_object' | 'none' | null = null;

  constructor(options: HttpChatModelOptions) {
    const { descriptor } = options;
    this.descriptor = descriptor;
    this.provider = descriptor.label;
    this.flavor = descriptor.chat;
    this.model = options.model ?? descriptor.chat.defaultModel ?? '';
    this.apiKeyEnv = options.apiKeyEnv ?? descriptor.apiKeyEnv[0] ?? 'AI_API_KEY';
    this.apiKey = options.apiKey ?? '';
    this.structuredOutput = options.structuredOutput ?? descriptor.chat.structuredOutput;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.sleep = options.sleep;
    this.onCall = options.onCall;

    if (!this.model) {
      throw new Error(
        `No model given for ${descriptor.label}. Set the model explicitly — ` +
          `${descriptor.label} has no sensible default here.`,
      );
    }
    const base = (options.baseUrl ?? descriptor.baseUrl).replace(/\/+$/, '');
    if (!base) {
      throw new Error(
        `${descriptor.label} needs a base URL. Set it, e.g. AI_BASE_URL=https://host/v1.`,
      );
    }
    this.url = `${base}${descriptor.chat.path}`;

    if (descriptor.requiresApiKey && !this.apiKey) {
      // Not thrown as an import-time crash: the chat port is resolved in jobs
      // that must boot and report a per-row scoreError instead of refusing to
      // start. Callers that cannot degrade read `missingCredential()`.
    }
  }

  /** True when the provider needs a key this instance does not have. */
  missingCredential(): boolean {
    return this.descriptor.requiresApiKey && !this.apiKey;
  }

  async complete<T = unknown>(request: ChatRequest): Promise<ChatResult<T>> {
    if (this.missingCredential()) {
      throw new AiError(
        `${this.apiKeyEnv} is not set, so ${this.provider} cannot be called. ` +
          (this.descriptor.signupUrl ? `Get a key at ${this.descriptor.signupUrl}` : '') +
          ' — or switch provider with LLM_PROVIDER.',
        { provider: this.provider, model: this.model },
      );
    }
    return this.attempt<T>(request, false);
  }

  /**
   * One HTTP round trip, with the two recoveries this layer owns.
   *
   * A reply the token budget cut short is the interesting one: the model was
   * still writing valid JSON when it ran out, so the fields it *did* finish are
   * discarded along with the partial one. Retrying with a bigger budget recovers
   * them, and reasoning models in particular need the room — their thinking
   * tokens come out of `max_tokens` before the answer starts, which is how a
   * 200-character object came back cut off mid-sentence.
   */
  private async attempt<T>(request: ChatRequest, retried: boolean): Promise<ChatResult<T>> {
    const startedAt = Date.now();
    const body = this.requestBody(request);
    try {
      const json = await postJson(this.url, this.headers(), body, {
        provider: this.provider,
        model: this.model,
        timeoutMs: request.timeoutMs ?? this.timeoutMs,
        maxRetries: this.maxRetries,
        ...(this.sleep ? { sleep: this.sleep } : {}),
      });
      const result = this.parse<T>(json);
      this.onCall?.({
        provider: this.provider,
        model: this.model,
        ms: Date.now() - startedAt,
        ok: true,
      });

      if (!retried && this.truncated(request, result)) {
        const budget = Math.min((request.maxTokens ?? DEFAULT_MAX_TOKENS) * 4, RETRY_MAX_TOKENS);
        await this.sleep?.(backoffMs(1, null));
        return this.attempt<T>({ ...request, maxTokens: budget }, true);
      }
      return result;
    } catch (error) {
      this.onCall?.({
        provider: this.provider,
        model: this.model,
        ms: Date.now() - startedAt,
        ok: false,
      });
      // A 400 mentioning the response format means this model cannot enforce a
      // schema. Downgrade and retry once rather than failing every row.
      if (await this.maybeDowngrade(error)) {
        return this.attempt<T>(request, retried);
      }
      throw error;
    }
  }

  /**
   * A schema'd answer the budget cut in half: unfinished JSON with a `length`
   * finish reason, as opposed to prose, which no budget would have fixed.
   */
  private truncated<T>(request: ChatRequest, result: ChatResult<T>): boolean {
    return request.schema !== undefined && result.data === null && result.finishReason === 'length';
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      // Local runtimes need no credential but most still require the header.
      authorization: `Bearer ${this.apiKey || 'not-needed'}`,
      // Attribution headers (OpenRouter); harmless where unused.
      ...(this.descriptor.headers ?? {}),
    };
  }

  private requestBody(request: ChatRequest): Record<string, unknown> {
    const user = request.schema
      ? `${request.prompt}\n\nRespond with JSON matching this schema and nothing else:\n${JSON.stringify(request.schema)}`
      : request.prompt;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        ...(request.system ? [{ role: 'system', content: request.system }] : []),
        { role: 'user', content: user },
      ],
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    };

    const format = this.responseFormat(request.schema, request.schemaName);
    if (format) body.response_format = format;

    // A provider with a smaller window than the document would 400 on; trimming
    // the prompt is better than losing the fields at the top of a resume.
    const cap = this.flavor.maxInputChars;
    if (cap) {
      const messages = body.messages as Array<{ role: string; content: string }>;
      const systemChars = messages[0]?.role === 'system' ? messages[0].content.length : 0;
      const budget = Math.max(2000, cap - systemChars);
      const last = messages[messages.length - 1];
      if (last && last.content.length > budget) last.content = last.content.slice(0, budget);
    }

    return body;
  }

  private responseFormat(schema: JsonSchema | undefined, name?: string): unknown {
    if (!schema) return null;
    const effective = this.downgradedTo ?? this.structuredOutput;
    if (effective === 'json_schema') {
      return { type: 'json_schema', json_schema: { name: name ?? 'response', schema } };
    }
    if (effective === 'json_object') return { type: 'json_object' };
    return null;
  }

  private parse<T>(json: unknown): ChatResult<T> {
    const choice = (json as { choices?: ChatChoice[] } | null)?.choices?.[0];
    const finishReason = choice?.finish_reason ?? null;
    if (finishReason === 'content_filter') {
      throw new AiError(`${this.provider} refused the request (content_filter)`, {
        provider: this.provider,
        model: this.model,
      });
    }
    const text = choice?.message?.content ?? '';

    const result: ChatResult<T> = {
      data: null,
      text,
      model: this.model,
      provider: this.provider,
      finishReason,
      usage: normaliseUsage(json),
    };

    if (!text) return result;
    const payload = extractJson(text);
    if (!payload) return result;
    try {
      // Shape is deliberately not trusted: a json_object-only provider can still
      // return something that fails the caller's schema, and that is the
      // caller's zod pass to reject, not this layer's.
      result.data = JSON.parse(payload) as T;
    } catch {
      result.data = null;
    }
    return result;
  }

  /**
   * Decide whether a failure is really "this model does not support
   * json_schema", and if so remember the weaker mode for subsequent calls.
   */
  private async maybeDowngrade(error: unknown): Promise<boolean> {
    if (!(error instanceof AiError) || error.status !== 400) return false;
    if (!/response_format|json_schema|schema/i.test(error.message)) return false;

    const next = this.downgradedTo ?? this.structuredOutput;
    if (next === 'json_schema') this.downgradedTo = 'json_object';
    else if (next === 'json_object') this.downgradedTo = 'none';
    else return false;

    await this.sleep?.(backoffMs(1, null));
    return true;
  }
}

type ChatChoice = {
  finish_reason?: string | null;
  message?: { content?: string | null };
};

function normaliseUsage(json: unknown): ChatResult['usage'] {
  const usage = (json as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage) return null;
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const input = num(usage.prompt_tokens) ?? num(usage.input_tokens);
  const output = num(usage.completion_tokens) ?? num(usage.output_tokens);
  const total = num(usage.total_tokens);
  if (input === undefined && output === undefined && total === undefined) return null;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(total !== undefined ? { total } : {}),
  };
}

export { clip };
