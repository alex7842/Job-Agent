import {
  AiError,
  type ChatModel,
  type ChatRequest,
  type ChatResult,
  type StructuredOutput,
} from './ports.js';

/**
 * Statuses worth trying a different provider for.
 *
 * Deliberately narrow. A 400 means the *request* is wrong and every provider
 * will reject it the same way; a 401/403 means the credential is wrong, and
 * burning a second provider's quota on a misconfiguration helps nobody. What is
 * left is the category that is genuinely provider-specific: the primary is out
 * of quota, out of rate limit, or down. `402` is OpenRouter's "add credits" and
 * is the one that matters most here, because a `:free` model that has exhausted
 * its daily allowance returns exactly that.
 */
const FAILOVER_STATUS = new Set([402, 408, 409, 425, 429, 500, 502, 503, 504]);

/** How long to believe a failover before trying the primary again. */
const DEFAULT_COOLDOWN_MS = 60_000;

/** One provider's outcome for one request. */
export type ChainAttempt = {
  provider: string;
  model: string;
  ok: boolean;
  ms: number;
  /** True for the attempt that produced the returned answer. */
  served: boolean;
  error: string | null;
  status: number | null;
};

/**
 * Live state of the chain, for the admin dashboard. Cheap to read: the counters
 * are in-process and reset on restart, which the endpoint reports rather than
 * pretending to be durable history.
 */
export type ChainStatus = {
  /** Configured order, each with what it last did. */
  chain: ChainAttempt[];
  /** The provider the next request goes to first. */
  active: { provider: string; model: string };
  /** True while the primary is parked after a failover. */
  primaryParked: boolean;
  /** Milliseconds until the primary is retried; 0 while it is preferred. */
  cooldownRemainingMs: number;
  /** Failover events since boot, keyed by the provider that gave up. */
  failovers: Record<string, number>;
  /** Requests answered by the primary without a failover. */
  servedByPrimary: number;
  /** Requests answered by a fallback. */
  servedByFallback: number;
  /** Requests that failed on every configured provider. */
  failed: number;
  startedAt: string;
};

export type FailoverInfo = {
  from: string;
  to: string;
  error: string;
  status: number | null;
};

export type FallbackHook = (info: FailoverInfo) => void;

export type FallbackChatModelOptions = {
  /** Tried first, and the one reported as this model's provider and model. */
  primary: ChatModel;
  /** Tried in order when the primary cannot serve the request. */
  fallbacks: ChatModel[];
  cooldownMs?: number;
  onFailover?: FallbackHook;
  /** Injected in tests; defaults to Date.now. */
  now?: () => number;
};

/**
 * A chat model that fails over to a second provider.
 *
 * This is a decorator rather than more retry logic inside `HttpChatModel`
 * because retrying the same provider cannot fix being out of quota. The retry
 * loop in `http.ts` handles a rate limit measured in seconds; a `:free` model
 * that has spent its daily allowance keeps returning 429 for hours, and every
 * one of those retries is latency added to a request that was always going to
 * fail. Once a provider earns a failover it is parked for a cooldown so later
 * calls go straight to the working one.
 *
 * Three details that matter for correctness:
 *
 * 1. The cooldown starts when the *primary* fails over and expires on its own.
 *    It is not reset by a success on the fallback, because that says nothing
 *    about whether the primary recovered — so a primary that is merely flaky
 *    eventually gets retried and returns to the front of the chain.
 * 2. A parked primary is still tried, last. A cooldown is a suspicion, not a
 *    verdict, and the chain must never end up with nobody to ask.
 * 3. The request crosses over unchanged. The schema, temperature and token
 *    budget are the caller's, and a fallback that quietly dropped the schema
 *    constraint would return a differently-shaped answer while presenting itself
 *    as the same operation — which for the scorer means a zod rejection.
 */
export class FallbackChatModel implements ChatModel {
  readonly provider: string;
  readonly model: string;
  readonly structuredOutput: StructuredOutput;

  private readonly primary: ChatModel;
  private readonly fallbacks: ChatModel[];
  private readonly cooldownMs: number;
  private readonly onFailover?: FallbackChatModelOptions['onFailover'];
  private readonly now: () => number;

  private readonly startedAt = new Date().toISOString();
  /** Wall-clock time the primary becomes eligible again; 0 while healthy. */
  private cooldownUntil = 0;
  /** Last outcome per configured provider, keyed by `provider|model`. */
  private readonly lastAttempt = new Map<string, ChainAttempt>();
  private failovers: Record<string, number> = {};
  private servedByPrimary = 0;
  private servedByFallback = 0;
  private failed = 0;

  constructor(options: FallbackChatModelOptions) {
    this.primary = options.primary;
    this.fallbacks = options.fallbacks;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.onFailover = options.onFailover;
    this.now = options.now ?? Date.now;

    // Reported as the primary, so a log line or error names the provider the
    // operator configured rather than whichever one happened to answer.
    this.provider = options.primary.provider;
    this.model = options.primary.model;
    this.structuredOutput = options.primary.structuredOutput;
  }

  /** The provider that will answer the next request. */
  activeProvider(): string {
    return this.chain()[0].provider;
  }

  status(): ChainStatus {
    const remaining = this.cooldownRemainingMs();
    const chain = this.chain(remaining);
    return {
      chain: chain.map((model) => ({
        provider: model.provider,
        model: model.model,
        ...(this.lastAttempt.get(key(model)) ?? {
          ok: false,
          ms: 0,
          served: false,
          error: null,
          status: null,
        }),
      })),
      active: { provider: chain[0].provider, model: chain[0].model },
      primaryParked: remaining > 0,
      cooldownRemainingMs: remaining,
      failovers: { ...this.failovers },
      servedByPrimary: this.servedByPrimary,
      servedByFallback: this.servedByFallback,
      failed: this.failed,
      startedAt: this.startedAt,
    };
  }

  async complete<T = unknown>(request: ChatRequest): Promise<ChatResult<T>> {
    const chain = this.chain(this.cooldownRemainingMs());
    const errors: string[] = [];

    for (const [index, model] of chain.entries()) {
      const isPrimary = model === this.primary;
      const startedAt = this.now();
      try {
        const result = await model.complete<T>(request);
        this.lastAttempt.set(key(model), {
          provider: model.provider,
          model: model.model,
          ok: true,
          ms: this.now() - startedAt,
          served: true,
          error: null,
          status: null,
        });

        if (isPrimary) {
          // The primary answered, so whatever was wrong with it has cleared.
          this.cooldownUntil = 0;
          this.servedByPrimary++;
        } else {
          this.servedByFallback++;
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = error instanceof AiError ? error.status : null;
        errors.push(`${model.provider} ${model.model}: ${message}`);
        this.lastAttempt.set(key(model), {
          provider: model.provider,
          model: model.model,
          ok: false,
          ms: this.now() - startedAt,
          served: false,
          error: message,
          status,
        });

        // Not provider-specific, so no other provider will do better. This
        // includes a missing credential, which the layer reports with no status.
        if (status === null || !FAILOVER_STATUS.has(status)) {
          this.failed++;
          throw error;
        }

        // Park the primary so the next request skips its backoff. A cooldown
        // that has not started is left alone: expiring on its own is what
        // brings a recovered provider back.
        if (isPrimary) this.cooldownUntil = this.now() + this.cooldownMs;

        const next = chain[index + 1];
        if (next) {
          this.failovers[model.provider] = (this.failovers[model.provider] ?? 0) + 1;
          this.onFailover?.({ from: model.provider, to: next.provider, error: message, status });
        }
      }
    }

    this.failed++;
    // Every configured provider was exhausted, so this is an outage rather than
    // a config mistake. Each reason is in the message: provider, status, wording.
    throw new AiError(`All configured providers failed. ${errors.join(' | ')}`, {
      provider: this.provider,
      model: this.model,
    });
  }

  /**
   * Order to try. The primary leads unless it is inside its cooldown, in which
   * case it moves to the end — still attempted, because that is the only thing
   * that ever discovers it has recovered.
   */
  private chain(cooldownRemaining = 0): ChatModel[] {
    if (cooldownRemaining > 0) return [...this.fallbacks, this.primary];
    return [this.primary, ...this.fallbacks];
  }

  private cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - this.now());
  }
}

const key = (model: ChatModel) => `${model.provider}|${model.model}`;
