import type { StructuredOutput } from './ports.js';

/**
 * Provider descriptors: everything the wire layer needs to know about a
 * provider, declared as data.
 *
 * The providers here share one wire format (OpenAI-compatible chat completions
 * plus an embeddings endpoint), so the adapters are thin. What actually differs
 * is catalogued below rather than spread through `if (provider === ...)` checks
 * in the call sites: base URL, default model ids, the field name for a batch of
 * inputs, whether a dimension parameter exists, batch caps, and how strongly
 * JSON can be constrained.
 *
 * Adding a provider means adding a descriptor here. Anything OpenAI-compatible
 * (Ollama, OpenRouter, LM Studio, vLLM, Together) works through the generic
 * descriptor with a different baseUrl — no new adapter code.
 */
export type ChatFlavor = {
  path: string;
  /** Strongest JSON guarantee this provider gives. */
  structuredOutput: StructuredOutput;
  defaultModel?: string;
  /** Rejects the request when the prompt exceeds the context window. */
  maxInputChars?: number;
  /** Some providers cap the whole batch, not just one call. */
  maxBatch?: number;
};

export type EmbeddingFlavor = {
  path: string;
  defaultModel?: string;
  defaultDimensions?: number;
  /**
   * Field the batch of texts goes in. OpenAI's API takes `input`, Mistral's
   * takes `inputs`.
   */
  inputField: 'input' | 'inputs';
  /**
   * Dimensionality truncation parameter, when the provider has one. Matryoshka
   * models let a larger vector be truncated to a prefix cheaply; others are
   * fixed and reject the field.
   */
  dimensionsParam?: 'dimensions' | 'output_dimension';
  maxBatch?: number;
  /** Per-text cap, so one pathological chunk cannot fail a whole batch. */
  maxInputChars?: number;
};

export type ProviderDescriptor = {
  /** Used in logs and error messages; the env value is the source of truth. */
  label: string;
  baseUrl: string;
  /** Where to get a key, surfaced in the "no key" error. */
  signupUrl?: string;
  /** Env vars checked in order; first non-empty wins. */
  apiKeyEnv: string[];
  /** False for local runtimes that need no credential. */
  requiresApiKey: boolean;
  chat: ChatFlavor;
  embeddings?: EmbeddingFlavor;
  /**
   * Extra headers sent on every request. OpenRouter asks for `HTTP-Referer`
   * and `X-Title` so requests can be attributed on its dashboard; they are
   * advisory and never carry a credential.
   */
  headers?: Record<string, string>;
  /** Non-fatal caveats worth surfacing once at boot. */
  notes?: string[];
};

export const PROVIDERS: Record<string, ProviderDescriptor> = {
  /**
   * Mistral's free "Experiment" tier: phone verification, no credit card,
   * roughly 1 request/second and a monthly token cap. Chosen as the default
   * because it is the only no-billing option that covers *both* chat and
   * embeddings, and mistral-embed is 1024d — the same width as the index this
   * project already has.
   */
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    signupUrl: 'https://console.mistral.ai',
    apiKeyEnv: ['MISTRAL_API_KEY'],
    requiresApiKey: true,
    chat: {
      path: '/chat/completions',
      structuredOutput: 'json_schema',
      defaultModel: 'mistral-small-latest',
      maxInputChars: 120_000,
    },
    embeddings: {
      path: '/embeddings',
      defaultModel: 'mistral-embed',
      defaultDimensions: 1024,
      inputField: 'inputs',
      // No dimension parameter is sent: mistral-embed defaults to 1024, which
      // is what the descriptor advertises. Sending output_dimension for a model
      // that does not support it is a 400, so it is left off.
      maxBatch: 64,
      maxInputChars: 24_000,
    },
    notes: [
      'Free tier is rate-limited to about 1 request/second; the layer retries on 429, so expect slower runs.',
    ],
  },

  /**
   * OpenRouter is the single cloud provider here: one key covers scoring,
   * resume parsing and embeddings, and the chat side can run on the free tier.
   *
   * One key and one OpenAI-compatible base URL for hundreds of models,
   * including a `:free` tier that costs nothing.
   *
   * The free tier is metered per *model*, not per key, and those quotas are
   * small and inconsistent — a `:free` model can answer for a while and then
   * start returning 429 "temporarily rate-limited upstream" for minutes at a
   * time. That is exactly the failure the retry layer in `http.ts` exists for,
   * and why the default below is a single named model rather than the
   * `openrouter/free` auto-router: an auto-router re-picks a different
   * upstream on every attempt, so a retried request can change quality
   * mid-batch and its routing rules are opaque.
   *
   * `nvidia/nemotron-3-super-120b-a12b:free` is the default because it was the
   * only free model tested that honoured `response_format: json_schema`
   * reliably (6/6 clean replies, ~4s); this service cannot run without a
   * schema-constrained scorer. The other free models that advertise
   * structured outputs (qwen3.8-27b, gemma-4) answered 429 "rate-limited
   * upstream" on every attempt, and nemotron-3-ultra-550b returned malformed
   * JSON roughly a third of the time. Its reasoning is visible in the model
   * card, not hidden behind a router.
   */
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    signupUrl: 'https://openrouter.ai/keys',
    apiKeyEnv: ['OPENROUTER_API_KEY'],
    requiresApiKey: true,
    chat: {
      path: '/chat/completions',
      structuredOutput: 'json_schema',
      defaultModel: 'nvidia/nemotron-3-super-120b-a12b:free',
      // 256k context on this model; the cap is far below it on purpose, since
      // a resume plus a posting is a few thousand characters and the budget is
      // really about not paying for a runaway prompt.
      maxInputChars: 120_000,
    },
    embeddings: {
      path: '/embeddings',
      // OpenRouter proxies the OpenAI embedding models. 3-small is 1536d
      // natively and accepts `dimensions`, so it can be truncated to 1024 to
      // match an existing index without re-creating it.
      defaultModel: 'openai/text-embedding-3-small',
      defaultDimensions: 1024,
      inputField: 'input',
      dimensionsParam: 'dimensions',
      maxBatch: 64,
      maxInputChars: 24_000,
    },
    headers: {
      'HTTP-Referer': 'https://github.com/job-agent',
      'X-Title': 'job-agent',
    },
    notes: [
      'Free models (":free") are limited to a handful of requests per model per day, so a bulk rescore will exhaust the quota and scoreError those rows.',
      'Free endpoints are frequently 429 rate-limited upstream; the layer retries with backoff, but a long batch can still fail. Add credits to lift the limit.',
    ],
  },

  /**
   * NVIDIA's own hosted catalogue (build.nvidia.com), reached through the
   * OpenAI-compatible `integrate.api.nvidia.com/v1` endpoint.
   *
   * This exists as the *fallback* for OpenRouter rather than as a default,
   * because the two failure modes are independent. OpenRouter's `:free` models
   * run on third-party capacity that returns 429 and "not enough credits" when
   * the daily allowance runs out; NVIDIA meters a developer's own quota
   * separately. One account's exhausted allowance therefore does not take the
   * other down, which is what makes a two-provider setup worth having at all.
   *
   * The default model is deliberately the *same weights* as the OpenRouter
   * default (`nvidia/nemotron-3-super-120b-a12b`), just without the `:free`
   * suffix. A failover that silently changed model would change scoring
   * behaviour along with it; this way a 429 costs latency and nothing else.
   * Verified to honour `response_format: json_schema` on this endpoint, which
   * the scorer cannot work without.
   *
   * No `embeddings` flavor: the catalogue does offer `nvidia/nemotron-3-embed-1b`,
   * but its width is not something this layer can assume, and guessing a
   * dimension is the exact failure that makes an index's similarity scores
   * meaningless. Setting EMBEDDING_MODEL/EMBEDDING_DIMENSIONS by hand once the
   * index is created for it is the honest route.
   */
  nvidia: {
    label: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    signupUrl: 'https://build.nvidia.com',
    apiKeyEnv: ['NVIDIA_API_KEY'],
    requiresApiKey: true,
    chat: {
      path: '/chat/completions',
      structuredOutput: 'json_schema',
      defaultModel: 'nvidia/nemotron-3-super-120b-a12b',
      maxInputChars: 120_000,
    },
    notes: [
      'Free developer credits with per-model rate limits; this endpoint is the fallback when OpenRouter is rate-limited or out of quota.',
      'Chat only here — embedding models need an explicit EMBEDDING_MODEL and EMBEDDING_DIMENSIONS because the width is not declared.',
    ],
  },

  /**
   * Ollama running on the same machine. Free and unmetered, but needs the
   * daemon up and the model pulled first (`ollama pull qwen3 bge-m3`).
   * No API key, so a placeholder is sent to satisfy the auth header.
   */
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyEnv: ['OLLAMA_API_KEY'],
    requiresApiKey: false,
    chat: {
      path: '/chat/completions',
      // Ollama's OpenAI-compatible endpoint does not enforce a schema, so the
      // schema rides in the prompt and zod does the validating.
      structuredOutput: 'none',
      defaultModel: 'qwen3',
    },
    embeddings: {
      path: '/embeddings',
      defaultModel: 'bge-m3',
      defaultDimensions: 1024,
      inputField: 'input',
      maxBatch: 32,
      maxInputChars: 24_000,
    },
    notes: ['Run `ollama serve` and `ollama pull qwen3 bge-m3` before starting the services.'],
  },

  /**
   * Generic escape hatch for anything OpenAI-compatible. Base URL and model
   * must be supplied explicitly rather than guessed, since a wrong default
   * would fail at request time with a far less obvious message.
   */
  'openai-compatible': {
    label: 'OpenAI-compatible endpoint',
    baseUrl: '',
    apiKeyEnv: ['OPENAI_COMPATIBLE_API_KEY', 'OPENAI_API_KEY'],
    requiresApiKey: false,
    chat: { path: '/chat/completions', structuredOutput: 'json_object', maxInputChars: 120_000 },
    embeddings: {
      path: '/embeddings',
      inputField: 'input',
      maxBatch: 64,
      maxInputChars: 24_000,
    },
  },
};

export const providerNames = () => Object.keys(PROVIDERS);

/**
 * Accepts the obvious aliases so `LLM_PROVIDER=gemini` or `=lmstudio` does not
 * dead-end on a typo error — the nearest generic descriptor is used instead.
 */
const ALIASES: Record<string, string> = {
  mistralai: 'mistral',
  'mistral-ai': 'mistral',
  local: 'ollama',
  lmstudio: 'openai-compatible',
  'lm-studio': 'openai-compatible',
  vllm: 'openai-compatible',
  together: 'openai-compatible',
  gemini: 'openai-compatible',
  google: 'openai-compatible',
  'open-router': 'openrouter',
  open_router: 'openrouter',
  nim: 'nvidia',
  'nvidia-nim': 'nvidia',
  openai: 'openai-compatible',
};

export function resolveProvider(name: string | undefined): ProviderDescriptor {
  const wanted = (name ?? '').trim().toLowerCase();
  const key = ALIASES[wanted] ?? wanted;
  const descriptor = PROVIDERS[key];
  if (!descriptor) {
    throw new Error(
      `Unknown AI provider "${name}". Available: ${providerNames().join(', ')}. ` +
        `Any OpenAI-compatible service also works via "openai-compatible".`,
    );
  }
  return descriptor;
}
