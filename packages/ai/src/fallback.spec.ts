import { describe, expect, it, vi } from 'vitest';
import {
  AiError,
  createResilientChatModel,
  FallbackChatModel,
  resolveChatChain,
  type ChatModel,
  type ChatRequest,
  type ChatResult,
} from './index.js';

/**
 * The failover chain is what keeps a free-tier outage from turning into a run
 * full of `scoreError` rows, so these tests pin the two properties that matter:
 * a provider-specific failure moves to the fallback, and anything else does not
 * waste a second provider's quota to be told the same thing.
 */

/**
 * Scripted providers, so no network is involved and a call can be made to fail
 * in a way a real endpoint would not let us arrange.
 *
 * The cast is on `complete` only: `ChatResult<T>` is generic in a way a scripted
 * answer cannot honestly reproduce, and every assertion here reads the default
 * `unknown` parameterisation anyway.
 */
type Script = Array<() => Promise<ChatResult>>;

function scripted(provider: string, model: string, script: Script): ChatModel {
  let call = 0;
  return {
    provider,
    model,
    structuredOutput: 'json_schema',
    complete: (async () => {
      const next = script[Math.min(call, script.length - 1)];
      call++;
      return next();
    }) as ChatModel['complete'],
  };
}

const ok = (provider: string, value: unknown = { score: 90 }): ChatResult => ({
  data: value as never,
  text: JSON.stringify(value),
  model: 'm',
  provider,
  finishReason: 'stop',
  usage: null,
});

// The status is in the message as well, because that is what postJson produces
// and what these assertions read.
const fails = (status: number | null, detail = 'boom') =>
  Promise.reject(
    new AiError(`p m failed: ${status} ${detail}`, { provider: 'p', model: 'm', status }),
  );

/** A model that succeeds once and is not callable again. */
const working = (provider: string, onCall?: () => void): ChatModel =>
  scripted(provider, 'm', [
    () => {
      onCall?.();
      return Promise.resolve(ok(provider));
    },
  ]);

/** A model that always fails with one status. */
const broken = (provider: string, status: number | null, detail = 'boom'): ChatModel => {
  let calls = 0;
  return {
    provider,
    model: 'm',
    structuredOutput: 'json_schema',
    complete: (() => {
      calls++;
      return fails(status, detail);
    }) as ChatModel['complete'],
    // Exposed only so a test can assert a model was never called.
    ...({ calls: () => calls } as Record<string, unknown>),
  };
};

describe('failover chain', () => {
  it('answers from the primary when it works, and never touches the fallback', async () => {
    const fallback = vi.fn();
    const model = new FallbackChatModel({
      primary: working('Primary'),
      fallbacks: [working('Backup', fallback)],
    });

    const result = await model.complete({ prompt: 'x' });
    expect(result.data).toEqual({ score: 90 });
    expect(fallback).not.toHaveBeenCalled();
    expect(model.status().servedByPrimary).toBe(1);
    expect(model.status().servedByFallback).toBe(0);
  });

  it('moves to the fallback on a 429 and does not retry the parked primary', async () => {
    let primaryCalls = 0;
    const primary = broken('Primary', 429, 'rate limited');
    // Count the attempts, since the whole point is that the parked primary is
    // not called again while the cooldown lasts.
    const counted: ChatModel = {
      ...primary,
      complete: ((r: ChatRequest) => {
        primaryCalls++;
        return primary.complete(r);
      }) as ChatModel['complete'],
    };
    const model = new FallbackChatModel({
      primary: counted,
      fallbacks: [working('Backup')],
      cooldownMs: 60_000,
      now: () => 1_000,
    });

    const first = await model.complete({ prompt: 'x' });
    expect(first.data).toEqual({ score: 90 });

    // Second call in the same cooldown must go straight to the backup. If it
    // re-tried the primary, every row in the run would pay the 429 backoff
    // again, which is the cost this cooldown exists to avoid.
    const second = await model.complete({ prompt: 'x' });
    expect(second.data).toEqual({ score: 90 });
    expect(primaryCalls).toBe(1);
    expect(model.status().primaryParked).toBe(true);
    expect(model.status().servedByFallback).toBe(2);
    expect(model.status().failovers).toEqual({ Primary: 1 });
  });

  it('brings the primary back once the cooldown expires, rather than demoting it forever', async () => {
    let clock = 1_000;
    let primaryHealthy = false;
    const primary = scripted('Primary', 'm', [
      () => (primaryHealthy ? Promise.resolve(ok('Primary')) : fails(429)),
    ]);
    const model = new FallbackChatModel({
      primary,
      fallbacks: [working('Backup')],
      cooldownMs: 5_000,
      now: () => clock,
    });

    await model.complete({ prompt: 'x' });
    expect(model.status().active.provider).toBe('Backup');

    clock += 6_000;
    primaryHealthy = true;
    const result = await model.complete({ prompt: 'x' });
    expect(result.data).toEqual({ score: 90 });
    expect(model.status().active.provider).toBe('Primary');
    expect(model.status().primaryParked).toBe(false);
  });

  it('fails over on an out-of-quota 402, which is what an exhausted free tier returns', async () => {
    const primary = broken('OpenRouter', 402, 'Insufficient credits');
    const model = new FallbackChatModel({
      primary,
      fallbacks: [working('NVIDIA')],
      now: () => 1_000,
    });
    expect((await model.complete({ prompt: 'x' })).data).toEqual({ score: 90 });
  });

  it('does not burn the fallback on a 401, which no other key would fix', async () => {
    const fallback = vi.fn();
    const model = new FallbackChatModel({
      primary: broken('Primary', 401, 'invalid api key'),
      fallbacks: [working('Backup', fallback)],
    });

    await expect(model.complete({ prompt: 'x' })).rejects.toThrow(/401/);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('does not failover on a 400, since the request is what is wrong', async () => {
    const fallback = vi.fn();
    const model = new FallbackChatModel({
      primary: broken('Primary', 400, 'response_format unsupported'),
      fallbacks: [working('Backup', fallback)],
    });
    await expect(model.complete({ prompt: 'x' })).rejects.toThrow(/400/);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('names every provider when all of them fail', async () => {
    const model = new FallbackChatModel({
      primary: broken('OpenRouter', 429, 'rate limited'),
      fallbacks: [broken('NVIDIA', 503, 'service unavailable')],
      now: () => 1_000,
    });

    await expect(model.complete({ prompt: 'x' })).rejects.toThrow(
      /All configured providers failed.*OpenRouter.*rate limited.*NVIDIA.*service unavailable/s,
    );
    expect(model.status().failed).toBe(1);
  });

  it('passes the request through unchanged, so the schema constraint survives', async () => {
    const request: ChatRequest = { prompt: 'score', schema: { type: 'object' }, temperature: 0.3 };
    let seen: ChatRequest | null = null;
    const model = new FallbackChatModel({
      primary: broken('Primary', 429),
      fallbacks: [
        {
          provider: 'Backup',
          model: 'b',
          structuredOutput: 'json_schema',
          complete: ((r: ChatRequest) => {
            seen = r;
            return Promise.resolve(ok('Backup'));
          }) as ChatModel['complete'],
        },
      ],
    });

    await model.complete(request);
    // A fallback that quietly dropped the schema would return a differently
    // shaped answer while claiming to be the same operation.
    expect(seen).toEqual(request);
  });

  it('reports the provider it was configured with, not the one that answered', async () => {
    const model = new FallbackChatModel({
      primary: broken('OpenRouter', 429),
      fallbacks: [working('NVIDIA')],
      now: () => 1_000,
    });
    const result = await model.complete({ prompt: 'x' });
    // The result names the provider that actually answered...
    expect(result.provider).toBe('NVIDIA');
    // ...while the model's own identity stays the configured one, so logs and
    // the dashboard keep pointing at the primary.
    expect(model.provider).toBe('OpenRouter');
    expect(model.status().active.provider).toBe('NVIDIA');
  });
});

describe('resolveChatChain', () => {
  const env = (values: Record<string, string>) => (name: string) => values[name];

  it('reads each provider key from the env var that provider declares', () => {
    const chain = resolveChatChain(
      env({
        SCORING_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'or-key',
        SCORING_FALLBACK_PROVIDER: 'nvidia',
        NVIDIA_API_KEY: 'nv',
      }),
      {
        defaultProvider: 'openrouter',
        providerEnv: 'SCORING_PROVIDER',
        modelEnv: 'SCORING_MODEL',
        fallbackProviderEnv: 'SCORING_FALLBACK_PROVIDER',
        fallbackModelEnv: 'SCORING_FALLBACK_MODEL',
      },
    );
    // Not interchangeable: reusing one provider's key for another is how a
    // config mistake becomes a baffling 401 from the wire.
    expect(chain.config.apiKey).toBe('or-key');
    expect(chain.config.fallbacks?.[0].apiKey).toBe('nv');
    expect(chain.order).toEqual(['OpenRouter', 'NVIDIA']);
    expect(chain.missingCredentials).toEqual([]);
  });

  it('treats a blank model var as unset, so the descriptor default applies', () => {
    const chain = resolveChatChain(
      env({ SCORING_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', SCORING_MODEL: '' }),
      {
        defaultProvider: 'openrouter',
        providerEnv: 'SCORING_PROVIDER',
        modelEnv: 'SCORING_MODEL',
        fallbackProviderEnv: 'SCORING_FALLBACK_PROVIDER',
        fallbackModelEnv: 'SCORING_FALLBACK_MODEL',
      },
    );
    // `.env` ships `SCORING_MODEL=`; letting "" through fails at boot with
    // "no model given".
    expect(chain.config.model).toBeUndefined();
  });

  it('configures no fallback when the env var is blank', () => {
    const chain = resolveChatChain(env({ OPENROUTER_API_KEY: 'k' }), {
      defaultProvider: 'openrouter',
      providerEnv: 'SCORING_PROVIDER',
      modelEnv: 'SCORING_MODEL',
      fallbackProviderEnv: 'SCORING_FALLBACK_PROVIDER',
      fallbackModelEnv: 'SCORING_FALLBACK_MODEL',
    });
    expect(chain.config.fallbacks).toBeUndefined();
    expect(chain.order).toEqual(['OpenRouter']);
  });

  it('reports a missing key without failing, since a fallback may cover it', () => {
    const chain = resolveChatChain(
      env({
        SCORING_PROVIDER: 'openrouter',
        SCORING_FALLBACK_PROVIDER: 'nvidia',
        NVIDIA_API_KEY: 'nv',
      }),
      {
        defaultProvider: 'openrouter',
        providerEnv: 'SCORING_PROVIDER',
        modelEnv: 'SCORING_MODEL',
        fallbackProviderEnv: 'SCORING_FALLBACK_PROVIDER',
        fallbackModelEnv: 'SCORING_FALLBACK_MODEL',
      },
    );
    // The primary has no key but the fallback does, so this chain is usable:
    // only a chain where every provider lacks one is dead.
    expect(chain.missingCredentials).toEqual(['OpenRouter']);
    expect(chain.missingCredentials.length).not.toBe(chain.order.length);
  });

  it('takes the first non-empty model var, so a parse-specific override wins', () => {
    const chain = resolveChatChain(
      env({
        OPENROUTER_API_KEY: 'k',
        SCORING_MODEL: 'scoring-model',
        RESUME_PARSING_MODEL: 'parse-model',
      }),
      {
        defaultProvider: 'openrouter',
        providerEnv: 'SCORING_PROVIDER',
        modelEnv: ['RESUME_PARSING_MODEL', 'SCORING_MODEL'],
        fallbackProviderEnv: 'SCORING_FALLBACK_PROVIDER',
        fallbackModelEnv: 'SCORING_FALLBACK_MODEL',
      },
    );
    expect(chain.config.model).toBe('parse-model');
  });

  it('ignores a blank override and falls through to the shared one', () => {
    const chain = resolveChatChain(
      env({ OPENROUTER_API_KEY: 'k', SCORING_MODEL: 'shared', RESUME_PARSING_MODEL: '' }),
      {
        defaultProvider: 'openrouter',
        providerEnv: 'SCORING_PROVIDER',
        modelEnv: ['RESUME_PARSING_MODEL', 'SCORING_MODEL'],
        fallbackProviderEnv: 'SCORING_FALLBACK_PROVIDER',
        fallbackModelEnv: 'SCORING_FALLBACK_MODEL',
      },
    );
    expect(chain.config.model).toBe('shared');
  });
});

describe('createResilientChatModel', () => {
  it('is the plain model when no fallback is configured', async () => {
    const model = createResilientChatModel({ provider: 'openrouter', apiKey: 'k' });
    expect(model.constructor.name).toBe('HttpChatModel');
  });

  it('builds a chain when one is configured', async () => {
    const model = createResilientChatModel({
      provider: 'openrouter',
      apiKey: 'k',
      fallbacks: [{ provider: 'nvidia', apiKey: 'nv' }],
    });
    expect(model.constructor.name).toBe('FallbackChatModel');
    // The descriptor default is used per provider, so the two can be the same
    // weights and a failover costs latency rather than behaviour.
    expect(model.model).toBe('nvidia/nemotron-3-super-120b-a12b:free');
  });
});
