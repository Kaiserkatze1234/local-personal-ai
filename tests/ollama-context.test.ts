/**
 * Regression: the runtime request context must NEVER default to the model's
 * advertised maximum. (Real-world failure: qwen3:4b reports 262144 and Ollama
 * allocated ~35.4 GB of KV cache — generation died on a laptop. Omitting
 * num_ctx entirely lets the model default win, so we always send it.)
 * Pure unit tests — a stubbed fetch captures the exact /api/chat bodies.
 */
import { describe, expect, it } from 'vitest';
import { hardwareContextCeiling, MIN_NUM_CTX, OllamaAdapter } from '../src/main/providers/adapters/ollama.js';
import type { GenerationRequest } from '../src/shared/types/models.js';

const ADVERTISED_MAX = 262144;

function jsonRes(obj: unknown): Response {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) } as Response;
}

interface Harness {
  chatBodies: { options?: { num_ctx?: number; num_predict?: number } }[];
  fetchImpl: typeof fetch;
}

function harness(): Harness {
  const chatBodies: { options?: { num_ctx?: number } }[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const url = String(_url);
    if (url.includes('/api/show'))
      return jsonRes(
        process.env.NESTED_SHOW === '1'
          ? { model_info: { qwen3: { 'qwen3.context_length': ADVERTISED_MAX } } } // older Ollama shape
          : { model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': ADVERTISED_MAX } }, // current flat shape
      );
    if (url.includes('/api/chat')) {
      const body = JSON.parse(String(init?.body)) as { options?: { num_ctx?: number; num_predict?: number }; stream?: boolean };
      chatBodies.push(body);
      if (body.stream) {
        const chunk = `${JSON.stringify({ message: { content: 'ok' }, done: true })}\n`;
        let first = true;
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async () =>
                first ? ((first = false), { done: false, value: new TextEncoder().encode(chunk) }) : { done: true, value: undefined },
            }),
          },
        } as unknown as Response;
      }
      return jsonRes({ message: { content: 'ok' }, done: true, eval_count: 3, prompt_eval_count: 5 });
    }
    return jsonRes({
      models: [{ name: 'dummy:latest', details: { family: 'qwen3', parameter_size: '4B', quantization_level: 'Q4_K_M' } }],
    });
  }) as unknown as typeof fetch;
  return { chatBodies, fetchImpl };
}

const req = (extra: Partial<GenerationRequest> = {}): GenerationRequest => ({
  modelId: 'ollama:dummy:latest',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

describe('num_ctx policy (never the advertised model maximum)', () => {
  it('maxTokens reaches the server as num_predict (generate + stream), same class as num_ctx', async () => {
    const h = harness();
    const a = new OllamaAdapter({ baseUrl: 'http://test', fetchImpl: h.fetchImpl });
    await a.chat.generate(req({ maxTokens: 64 }));
    expect(h.chatBodies.at(-1)!.options!.num_predict).toBe(64);
    for await (const _c of a.chat.stream(req({ maxTokens: 96 }))) {
      /* consume */
    }
    expect(h.chatBodies.at(-1)!.options!.num_predict).toBe(96);
    await a.chat.generate(req()); // unset -> absent, server default (not 0!)
    expect(h.chatBodies.at(-1)!.options!.num_predict).toBeUndefined();
  });

  it('metadata keeps 262144, but generate() sends the 4096 default — defined, not undefined', async () => {
    const h = harness();
    const a = new OllamaAdapter({ baseUrl: 'http://test', fetchImpl: h.fetchImpl });
    expect(await a.refineContext('dummy:latest')).toBe(ADVERTISED_MAX); // informational (req 5)
    const models = await a.discoverModels();
    expect(models[0]!.contextLength).toBeGreaterThanOrEqual(4096); // metadata untouched by the fix
    await a.chat.generate(req());
    const sent = h.chatBodies.at(-1)!.options!.num_ctx;
    expect(sent).toBe(4096);
    expect(sent).not.toBe(ADVERTISED_MAX);
  });

  it('stream() sends num_ctx too (the crash path was streaming chat turns)', async () => {
    const h = harness();
    const a = new OllamaAdapter({ baseUrl: 'http://test', fetchImpl: h.fetchImpl });
    for await (const _c of a.chat.stream(req())) {
      /* consume */
    }
    expect(h.chatBodies.at(-1)!.options!.num_ctx).toBe(4096);
  });

  it('explicit per-request contextTokens wins', async () => {
    const h = harness();
    const a = new OllamaAdapter({ baseUrl: 'http://test', fetchImpl: h.fetchImpl, context: { maxTokens: 131_072 } });
    await a.chat.generate(req({ contextTokens: 8192 }));
    expect(h.chatBodies.at(-1)!.options!.num_ctx).toBe(8192);
  });

  it('adapter default from a LIVE config getter re-reads every request', async () => {
    const h = harness();
    let cfg = 2048;
    const a = new OllamaAdapter({
      baseUrl: 'http://test',
      fetchImpl: h.fetchImpl,
      context: { defaultTokens: () => cfg, maxTokens: 131_072 },
    });
    await a.chat.generate(req());
    cfg = 10240;
    await a.chat.generate(req());
    expect(h.chatBodies[0]!.options!.num_ctx).toBe(2048);
    expect(h.chatBodies[1]!.options!.num_ctx).toBe(10240);
  });

  it('overrides are clamped to the hardware ceiling and a usable floor', async () => {
    const h = harness();
    const a = new OllamaAdapter({ baseUrl: 'http://test', fetchImpl: h.fetchImpl, context: { maxTokens: 16384 } });
    await a.chat.generate(req({ contextTokens: 999_999 }));
    expect(h.chatBodies.at(-1)!.options!.num_ctx).toBe(16384); // sane max for the machine
    await a.chat.generate(req({ contextTokens: 10 }));
    expect(h.chatBodies.at(-1)!.options!.num_ctx).toBe(MIN_NUM_CTX); // never a silly small window
  });

  it('reads the advertised max from BOTH /api/show shapes (flat current, nested legacy)', async () => {
    const h = harness();
    const a = new OllamaAdapter({ baseUrl: 'http://test', fetchImpl: h.fetchImpl });
    expect(await a.refineContext('dummy:latest')).toBe(ADVERTISED_MAX);
    process.env.NESTED_SHOW = '1';
    const h2 = harness();
    const a2 = new OllamaAdapter({ baseUrl: 'http://test', fetchImpl: h2.fetchImpl });
    expect(await a2.refineContext('dummy:latest')).toBe(ADVERTISED_MAX);
    delete process.env.NESTED_SHOW;
    // and requests stay bounded in either case
    await a2.chat.generate(req());
    expect(h2.chatBodies.at(-1)!.options!.num_ctx).toBe(4096);
  });

  it('hardware ceiling table: coarse, monotone, always within [4096, 32768]', () => {
    const gib = (n: number) => n * 1024 ** 3;
    expect(hardwareContextCeiling(gib(6))).toBe(4096);
    expect(hardwareContextCeiling(gib(8))).toBe(8192);
    expect(hardwareContextCeiling(gib(16))).toBe(16384); // the target laptop
    expect(hardwareContextCeiling(gib(32))).toBe(32768);
    expect(hardwareContextCeiling(0)).toBe(8192); // unknown -> conservative
    const real = hardwareContextCeiling(); // machine-independent bounds only
    expect(real).toBeGreaterThanOrEqual(4096);
    expect(real).toBeLessThanOrEqual(32768);
  });
});
