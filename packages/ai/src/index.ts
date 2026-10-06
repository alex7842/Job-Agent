import { HttpChatModel, type ChatModelConfig } from './chat.js';
import { HttpEmbeddingModel, type EmbeddingModelConfig } from './embeddings.js';
import { FallbackChatModel, type FallbackChatModelOptions } from './fallback.js';
import { resolveProvider } from './providers.js';
import type { ChatModel, EmbeddingModel } from './ports.js';

/**
 * Factories take a config value and a provider *name*. Everything provider
 * specific is looked up from the descriptor, so callers pass the same few keys
 * regardless of which backend is configured — which is the whole point:
 * `SCORING_PROVIDER=openrouter` and `SCORING_PROVIDER=mistral` are the same
 * code path.
 *
 * Framework-free by design: the services read their own config and pass plain
 * values in, so this package needs no knowledge of Nest.
 */
export function createChatModel(config: ChatModelConfig = {}): ChatModel {
  const { provider, ...rest } = config;
  return new HttpChatModel({ ...rest, descriptor: resolveProvider(provider) });
}

/** Chat model plus optional fallbacks, each a full config of its own. */
export type ResilientChatModelConfig = ChatModelConfig & {
  /**
   * Providers tried when the primary cannot serve the request. A provider with
   * no key is still constructed, so a missing fallback credential surfaces as
   * one skipped attempt rather than a boot failure.
   */
  fallbacks?: ChatModelConfig[];
  cooldownMs?: number;
  onFailover?: FallbackChatModelOptions['onFailover'];
};

/**
 * `createChatModel` wrapped in the failover chain.
 *
 * Returns the plain `HttpChatModel` when no fallbacks are configured, so the
 * common case adds one object to the stack and nothing to the behaviour — a
 * caller that never configures a fallback cannot observe this existing.
 */
export function createResilientChatModel(config: ResilientChatModelConfig = {}): ChatModel {
  const { fallbacks, cooldownMs, onFailover, ...primary } = config;
  const model = createChatModel(primary);
  if (!fallbacks?.length) return model;

  return new FallbackChatModel({
    primary: model,
    fallbacks: fallbacks.map((f) => createChatModel(f)),
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
    ...(onFailover !== undefined ? { onFailover } : {}),
  });
}

export function createEmbeddingModel(config: EmbeddingModelConfig = {}): EmbeddingModel {
  const { provider, ...rest } = config;
  return new HttpEmbeddingModel({ ...rest, descriptor: resolveProvider(provider) });
}

export { HttpChatModel } from './chat.js';
export type { ChatModelConfig, HttpChatModelOptions } from './chat.js';
export { FallbackChatModel } from './fallback.js';
export type { ChainAttempt, ChainStatus, FallbackChatModelOptions } from './fallback.js';
export { resolveChatChain } from './chain-config.js';
export type { ChatChainEnv, EnvLookup, ResolvedChatChain } from './chain-config.js';
export { HttpEmbeddingModel, l2normalize } from './embeddings.js';
export type { EmbeddingModelConfig, HttpEmbeddingModelOptions } from './embeddings.js';
export { PROVIDERS, providerNames, resolveProvider } from './providers.js';
export type { ChatFlavor, EmbeddingFlavor, ProviderDescriptor } from './providers.js';
export { AiError } from './ports.js';
export type {
  ChatModel,
  ChatRequest,
  ChatResult,
  EmbeddingModel,
  JsonSchema,
  StructuredOutput,
  TokenUsage,
} from './ports.js';
