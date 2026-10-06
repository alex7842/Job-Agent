import type { ChatModelConfig } from './chat.js';
import type { FallbackHook } from './fallback.js';
import type { ResilientChatModelConfig } from './index.js';
import { resolveProvider } from './providers.js';

/**
 * Reading the AI chain out of the environment in one place, so the scorer and
 * the resume parser cannot drift into configuring themselves differently.
 *
 * The lookup is a plain function rather than Nest's `ConfigService` so this
 * package stays framework-free; the apps pass `config.get` straight in.
 */
export type EnvLookup = (name: string) => string | undefined;

/** The env vars that describe one chat chain: primary and its fallback. */
export type ChatChainEnv = {
  /** Provider used when `providerEnv` is blank. */
  defaultProvider: string;
  /** e.g. SCORING_PROVIDER */
  providerEnv: string;
  /**
   * Model vars in precedence order, first non-empty wins; blank then falls to
   * the descriptor's own default. The parser passes two so an override for the
   * scorer's cheaper model does not silently change resume parsing too.
   */
  modelEnv: string | string[];
  /** e.g. SCORING_FALLBACK_PROVIDER — blank means no fallback. */
  fallbackProviderEnv: string;
  /** e.g. SCORING_FALLBACK_MODEL */
  fallbackModelEnv: string;
  /** Applied to every provider, e.g. a resume parser's longer timeout. */
  shared?: Partial<ChatModelConfig>;
  /** Chain-level only: how long the primary stays parked after a failover. */
  cooldownMs?: number;
  /** Chain-level only: notified when a request moves to the fallback. */
  onFailover?: FallbackHook;
};

export type ResolvedChatChain = {
  config: ResilientChatModelConfig;
  /** Provider labels in the order they will be tried. */
  order: string[];
  /** Labels whose key env var is unset. Empty in a healthy deployment. */
  missingCredentials: string[];
  /** Env var name to name in a "cannot do anything" error. */
  apiKeyEnv: string;
  signupUrl: string;
};

/**
 * Builds the chain from env, taking each provider's key from the env vars *that
 * provider declares* rather than from one shared variable.
 *
 * That matters: falling back to a different provider's key would turn a config
 * mistake into a baffling 401 from the wire, which is much harder to diagnose
 * than a missing variable named outright.
 */
export function resolveChatChain(env: EnvLookup, names: ChatChainEnv): ResolvedChatChain {
  const missingCredentials: string[] = [];

  const build = (provider: string | undefined, modelEnv: string | string[]) => {
    const descriptor = resolveProvider(provider);
    const apiKeyEnv = descriptor.apiKeyEnv[0];
    const apiKey = descriptor.apiKeyEnv.map((key) => env(key)).find(Boolean) ?? '';
    if (descriptor.requiresApiKey && !apiKey) missingCredentials.push(descriptor.label);
    // A blank value must not beat the descriptor default: `.env` ships
    // `SCORING_MODEL=`, and `??` alone would let "" through and fail at boot
    // with "no model given".
    const vars = Array.isArray(modelEnv) ? modelEnv : [modelEnv];
    const model = vars.map((name) => env(name)?.trim()).find(Boolean);
    return {
      name: provider ?? names.defaultProvider,
      label: descriptor.label,
      apiKeyEnv,
      apiKey,
      model: model || undefined,
    };
  };

  const primary = build(env(names.providerEnv)?.trim() || names.defaultProvider, names.modelEnv);
  const fallbackName = env(names.fallbackProviderEnv)?.trim();
  const fallback = fallbackName ? build(fallbackName, names.fallbackModelEnv) : null;

  const entry = (p: typeof primary): ChatModelConfig => ({
    provider: p.name,
    apiKey: p.apiKey,
    ...(p.model ? { model: p.model } : {}),
    ...names.shared,
  });

  return {
    config: {
      ...entry(primary),
      ...(fallback ? { fallbacks: [entry(fallback)] } : {}),
      ...(names.cooldownMs !== undefined ? { cooldownMs: names.cooldownMs } : {}),
      ...(names.onFailover ? { onFailover: names.onFailover } : {}),
    },
    order: fallback ? [primary.label, fallback.label] : [primary.label],
    missingCredentials,
    apiKeyEnv: primary.apiKeyEnv,
    signupUrl: resolveProvider(primary.name).signupUrl ?? 'your provider dashboard',
  };
}
