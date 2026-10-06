import { AiError } from './ports.js';

export type HttpOptions = {
  provider: string;
  model: string;
  timeoutMs: number;
  /** Attempts beyond the first. 3 means up to 4 tries. */
  maxRetries: number;
  /** Injected in tests to keep backoff instant. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retrying these is pointless: the same request fails the same way. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * POST JSON with retry on rate limits and transient upstream errors.
 *
 * This exists because free tiers are aggressively rate-limited — Mistral's free
 * plan is around 1 request/second — so a run that scores a few dozen jobs will
 * hit 429 by design. Treating that as a hard failure would make the free tier
 * unusable for anything but toy traffic, and the alternative (sleeping between
 * every call) would be guesswork. Backoff honours `Retry-After` when the
 * provider sends it and adds jitter so parallel callers do not resynchronise.
 *
 * 4xx other than the retryable set fail immediately: a bad key or an unsupported
 * parameter will not fix itself, and retrying would just delay the real error.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: HttpOptions,
): Promise<unknown> {
  const sleep = options.sleep ?? defaultSleep;

  let lastError: AiError | null = null;
  let retryAfter: string | null = null;
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt, retryAfter ?? undefined));
    retryAfter = null;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (cause) {
      // Timeouts and socket resets are the network's version of a 503.
      lastError = new AiError(
        `${options.provider} request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { provider: options.provider, model: options.model },
      );
      continue;
    }

    if (res.ok) return (await res.json().catch(() => null)) as unknown;

    const detail = await res.text().catch(() => '');
    lastError = new AiError(
      `${options.provider} ${options.model} failed: ${res.status} ${clip(detail, 300)}`,
      { provider: options.provider, model: options.model, status: res.status },
    );

    if (!RETRYABLE_STATUS.has(res.status)) throw lastError;
    retryAfter = res.headers.get('retry-after');
  }

  throw (
    lastError ??
    new AiError(`${options.provider} ${options.model} failed for an unknown reason`, {
      provider: options.provider,
      model: options.model,
    })
  );
}

/**
 * Exponential with full jitter, or the provider's own advice when it gave any.
 * `Retry-After` may be seconds or a date; both are accepted.
 */
export function backoffMs(attempt: number, retryAfter?: string | null): number {
  const advised = parseRetryAfter(retryAfter);
  if (advised !== null) return advised;
  const ceiling = Math.min(30_000, 500 * 2 ** (attempt - 1));
  return Math.round(Math.random() * ceiling) + 100;
}

function parseRetryAfter(header: string | null | undefined): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds * 1000));
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.min(60_000, Math.max(0, date - Date.now()));
}

/** Shorten for a human-readable error, marking that something was removed. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Hard character cap, exact and silent.
 *
 * Used for model input rather than `clip`: an ellipsis appended to a chunk being
 * embedded would put a stray character into the vector, and the whole point of
 * the cap is that the result fits the provider's limit.
 */
export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Pull a JSON object out of a model reply.
 *
 * Constrained decoding makes this almost always redundant, but a truncated
 * answer (finish reason "length") or a chatty model still yields prose or a
 * fenced block, and callers must not have to care which.
 */
export function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // fall through to extraction
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  if (fenced) {
    try {
      JSON.parse(fenced);
      return fenced;
    } catch {
      // fall through
    }
  }
  return trimmed.match(/\{[\s\S]*\}/)?.[0] ?? null;
}
