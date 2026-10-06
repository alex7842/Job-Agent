import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createChatModel, createEmbeddingModel, AiError } from './index.js';
import { resolveProvider } from './providers.js';

/**
 * These tests pin the behaviour the callers depend on: order preservation on
 * embeddings, dimension enforcement, 429 tolerance, and graceful degradation
 * when a provider cannot enforce a JSON schema.
 *
 * `fetch` is stubbed rather than a server started, because the point is the
 * request and response handling, not the network.
 */
const noSleep = () => Promise.resolve();

function okResponse(body: unknown, init: { headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function textResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

const embeddingRow = (i: number, dims = 4) => ({
  index: i,
  embedding: Array.from({ length: dims }, (_, k) => (i + 1) * (k + 1)),
});

describe('provider registry', () => {
  it('resolves aliases so a near-miss name still routes', () => {
    expect(resolveProvider('MistralAI').label).toBe('Mistral');
    expect(resolveProvider('local').label).toBe('Ollama');
    expect(resolveProvider('gemini').label).toBe('OpenAI-compatible endpoint');
    // openrouter used to alias to the generic descriptor, which needs a base
    // URL and model set by hand; it is a real provider now.
    expect(resolveProvider('openrouter').label).toBe('OpenRouter');
    expect(resolveProvider('open-router').label).toBe('OpenRouter');
  });

  it('gives OpenRouter a default free model and its attribution headers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: '{"a":1}' } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const model = createChatModel({ provider: 'openrouter', apiKey: 'k', sleep: noSleep });
    expect(model.model).toBe('nvidia/nemotron-3-super-120b-a12b:free');
    await model.complete({ prompt: 'x', schema: { type: 'object' } });

    expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer k');
    // Case is preserved as declared; fetch lowercases it on the wire.
    expect(headers['X-Title']).toBe('job-agent');
    expect(headers['HTTP-Referer']).toBe('https://github.com/job-agent');
    // The scorer depends on a real constraint, so the default must be the
    // strongest one rather than json_object.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).response_format.type).toBe(
      'json_schema',
    );
    vi.unstubAllGlobals();
  });

  it('names the OpenRouter key env var and where to get one', async () => {
    await expect(
      createChatModel({ provider: 'openrouter', apiKey: '' }).complete({ prompt: 'x' }),
    ).rejects.toThrow(/OPENROUTER_API_KEY.*openrouter.ai\/keys/s);
  });

  it('fails loudly on an unknown provider, listing the alternatives', () => {
    expect(() => resolveProvider('wat')).toThrow(/Unknown AI provider "wat".*mistral/s);
  });

  it('does not invent a default model for a generic endpoint', () => {
    expect(() => createChatModel({ provider: 'openai-compatible', apiKey: 'x' })).toThrow(
      /No model given/,
    );
  });
});

describe('chat', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const chat = () =>
    createChatModel({ provider: 'mistral', apiKey: 'k', sleep: noSleep, maxRetries: 2 });

  it('sends the schema as a decoding constraint and returns parsed data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"score":91,"reason":"good"}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await chat().complete({
      system: 'be terse',
      prompt: 'score this',
      schema: { type: 'object', properties: { score: { type: 'number' } } },
      schemaName: 'Score',
      temperature: 0.3,
      maxTokens: 512,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.model).toBe('mistral-small-latest');
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'Score',
        schema: { type: 'object', properties: { score: { type: 'number' } } },
      },
    });
    // The model never sees the schema as context, so it is repeated in the prompt.
    expect(body.messages[1].content).toContain('Respond with JSON matching this schema');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(512);

    expect(result.data).toEqual({ score: 91, reason: 'good' });
    expect(result.usage).toEqual({ input: 12, output: 4, total: 16 });
    expect(result.provider).toBe('Mistral');
  });

  it('never throws on an unusable shape, so one bad row cannot fail a run', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(okResponse({ choices: [{ message: { content: 'no json here' } }] })),
    );
    const result = await chat().complete({ prompt: 'x', schema: { type: 'object' } });
    expect(result.data).toBeNull();
    expect(result.text).toBe('no json here');
  });

  it('recovers JSON from a fenced or chatty reply', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          choices: [{ message: { content: 'Here you go:\n```json\n{"a":1}\n```' } }],
        }),
      ),
    );
    const result = await chat().complete({ prompt: 'x', schema: { type: 'object' } });
    expect(result.data).toEqual({ a: 1 });
  });

  it('retries an answer the token budget cut off, with more room', async () => {
    // finish_reason "length" on a schema request means the model was still
    // writing valid JSON when it ran out. The finished fields are thrown away
    // otherwise, and reasoning models hit this routinely because their thinking
    // tokens come out of max_tokens first.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          choices: [{ finish_reason: 'length', message: { content: '{"score":55,"reason":"cut' } }],
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          choices: [
            { finish_reason: 'stop', message: { content: '{"score":55,"reason":"complete"}' } },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await chat().complete({
      prompt: 'score this',
      schema: { type: 'object' },
      maxTokens: 512,
    });

    expect(result.data).toEqual({ score: 55, reason: 'complete' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).max_tokens).toBe(2048);
  });

  it('gives up after one larger retry, so a runaway model cannot loop', async () => {
    // A fresh Response per call: a body can only be read once.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        okResponse({
          choices: [{ finish_reason: 'length', message: { content: '{"score":1' } }],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await chat().complete({ prompt: 'x', schema: { type: 'object' } });

    expect(result.data).toBeNull();
    expect(result.finishReason).toBe('length');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry prose, which no budget would have fixed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: 'I cannot help.' } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await chat().complete({ prompt: 'x', schema: { type: 'object' } });

    expect(result.data).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 then succeeds, which is what a free tier requires', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse(429, 'rate limited', { 'retry-after': '1' }))
      .mockResolvedValueOnce(okResponse({ choices: [{ message: { content: '{"ok":true}' } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await chat().complete({ prompt: 'x', schema: { type: 'object' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.data).toEqual({ ok: true });
  });

  it('does not retry a 401: a bad key will not fix itself', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse(401, 'invalid api key'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(chat().complete({ prompt: 'x' })).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a suspended account with the provider name and status', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(textResponse(412, '{"error":{"message":"Account ... is suspended"}}')),
    );
    await expect(chat().complete({ prompt: 'x' })).rejects.toThrow(
      /Mistral .* failed: 412.*suspended/s,
    );
  });

  it('downgrades to json_object when the model rejects json_schema, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse(400, 'response_format json_schema is not supported'))
      .mockResolvedValueOnce(okResponse({ choices: [{ message: { content: '{"a":2}' } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const model = createChatModel({
      provider: 'mistral',
      apiKey: 'k',
      sleep: noSleep,
      maxRetries: 0,
    });
    const result = await model.complete({ prompt: 'x', schema: { type: 'object' } });

    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(retryBody.response_format).toEqual({ type: 'json_object' });
    expect(result.data).toEqual({ a: 2 });
  });

  it('keeps no prompt schema for a provider that cannot enforce one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: '{"a":3}' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await createChatModel({ provider: 'ollama', sleep: noSleep }).complete({
      prompt: 'x',
      schema: { type: 'object' },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.response_format).toBeUndefined();
    const user = body.messages.find((m: { role: string }) => m.role === 'user');
    expect(user.content).toContain('Respond with JSON matching this schema');
  });

  it('refuses to call without a key, and says where to get one', async () => {
    const model = createChatModel({ provider: 'mistral', apiKey: '' });
    await expect(model.complete({ prompt: 'x' })).rejects.toThrow(
      /MISTRAL_API_KEY.*console.mistral.ai/s,
    );
  });

  it('reports a content-filter refusal as an error rather than empty text', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          okResponse({ choices: [{ finish_reason: 'content_filter', message: {} }] }),
        ),
    );
    await expect(chat().complete({ prompt: 'x' })).rejects.toThrow(/content_filter/);
  });

  it('carries provider, model and status on the error for logs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse(403, 'forbidden')));
    try {
      await chat().complete({ prompt: 'x' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AiError);
      expect((error as AiError).provider).toBe('Mistral');
      expect((error as AiError).status).toBe(403);
      expect((error as AiError).model).toBe('mistral-small-latest');
    }
  });
});

describe('embeddings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const embedder = () => createEmbeddingModel({ provider: 'mistral', apiKey: 'k', sleep: noSleep });

  it('uses the input field the provider documents', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ data: [embeddingRow(0, 1024)] }));
    vi.stubGlobal('fetch', fetchMock);
    await embedder().embed(['hello']);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.model).toBe('mistral-embed');
    expect(body.inputs).toEqual(['hello']);
    // mistral-embed has no truncation parameter, and sending one is a 400.
    expect(body.output_dimension).toBeUndefined();
    expect(body.dimensions).toBeUndefined();
  });

  it('sends the dimensions parameter only where it exists', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ data: [embeddingRow(0, 1024)] }));
    vi.stubGlobal('fetch', fetchMock);
    await createEmbeddingModel({
      provider: 'openrouter',
      apiKey: 'k',
      dimensions: 1024,
      sleep: noSleep,
    }).embed(['hello']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/embeddings');
    // 3-small is 1536d natively and accepts the truncation, so 1024 is legal
    // without changing the existing index width.
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'openai/text-embedding-3-small',
      input: ['hello'],
      dimensions: 1024,
    });
  });

  it('restores input order from the index field, not arrival order', async () => {
    const a = Array.from({ length: 1024 }, (_, k) => k + 1);
    const b = Array.from({ length: 1024 }, (_, k) => k + 2);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          data: [
            { index: 1, embedding: b },
            { index: 0, embedding: a },
          ],
        }),
      ),
    );
    const [first] = await embedder().embed(['one', 'two']);
    // Index 0 must come back first even though the response listed it second.
    expect(first[0]).toBeCloseTo(a[0] / norm(a), 6);
  });

  it('rejects a wrong-width vector instead of poisoning the index', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ data: [embeddingRow(0, 512)] })));
    await expect(embedder().embed(['hello'])).rejects.toThrow(/512-d vector but 1024 was expected/);
  });

  it('normalises so a cosine metric does not rank by length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ data: [embeddingRow(0, 1024)] })),
    );
    const [vector] = await embedder().embed(['hello']);
    const length = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    expect(length).toBeCloseTo(1, 6);
  });

  it('throws when the provider returns the wrong number of vectors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ data: [embeddingRow(0, 1024)] })),
    );
    await expect(embedder().embed(['a', 'b'])).rejects.toThrow(/1 embeddings for 2 inputs/);
  });

  it('batches rather than sending one request per text', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const count = (JSON.parse(init.body as string).inputs as string[]).length;
      return Promise.resolve(
        okResponse({ data: Array.from({ length: count }, (_, i) => embeddingRow(i, 1024)) }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const texts = Array.from({ length: 70 }, (_, i) => `t${i}`);
    const vectors = await embedder().embed(texts);
    // Mistral's batch cap is 64, so 70 texts must be 2 requests, not 70.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vectors).toHaveLength(70);
  });

  it('clips a pathological input so one chunk cannot fail the batch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ data: [embeddingRow(0, 1024)] }));
    vi.stubGlobal('fetch', fetchMock);
    await embedder().embed(['x'.repeat(200_000)]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect((body.inputs[0] as string).length).toBeLessThanOrEqual(24_000);
  });

  it('returns an empty array for no input without calling the provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await embedder().embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function norm(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}
