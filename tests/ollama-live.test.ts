/**
 * LEVEL 4 — real provider/model tests (testing philosophy, spec §44). These
 * run the PRODUCTION OllamaAdapter against a real ollama server with real
 * models. Activation (deterministic, see tests at the bottom for the rules):
 *
 *   $env:LPAI_LIVE_OLLAMA='1'          # the documented live-suite flag
 *   npx vitest run tests/ollama-live.test.ts
 *
 * Endpoint defaults to http://127.0.0.1:11434 (same as app auto-discovery);
 * LPAI_OLLAMA_URL overrides it and — for backward compatibility with the
 * established flow — also activates on its own. LPAI_LIVE_OLLAMA=0/false/off
 * force-disables everything. Normal `npm test` stays green without Ollama.
 *
 * Chat and embedding models are DISCOVERED and capability-gated here —
 * preferring qwen3:4b, else the first chat-capable model; embedding tests use
 * only embedding-capable models. Optional pins: LPAI_OLLAMA_MODEL /
 * LPAI_OLLAMA_EMBED_MODEL (a pin that is not installed+capable FAILS loudly;
 * no fake fallback models, ever).
 *
 * Nothing here is mocked: usage tokens come from the server's own counters,
 * the unload check reads /api/ps, and every /api/chat payload is captured on
 * the wire to verify options.num_ctx.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { OllamaAdapter } from '../src/main/providers/adapters/ollama.js';
import { DEFAULT_OLLAMA_URL, ollamaLiveActivation } from '../src/shared/ollamaLiveEnv.js';

const ACTIVATION = ollamaLiveActivation(process.env);
const BASE = ACTIVATION.baseUrl;
const wantModel = process.env.LPAI_OLLAMA_MODEL;
const wantEmbed = process.env.LPAI_OLLAMA_EMBED_MODEL;
const live = ACTIVATION.on ? describe : describe.skip;

if (!ACTIVATION.on && process.argv.join(' ').includes('ollama-live')) {
  console.log(`[live] suite SKIPPED — ${ACTIVATION.why}`);
}

async function ps(adapter: OllamaAdapter): Promise<{ name: string }[]> {
  const r = await fetch(`${adapter.baseUrl}/api/ps`);
  const j = (await r.json()) as { models?: { name: string }[] };
  return j.models ?? [];
}

/** small deterministic runtime context for the tests — never the model max */
const TEST_NUM_CTX = 2048;

live('real Ollama provider (§6/§7/§56)', () => {
  // every /api/chat body the adapter sends to the REAL server is captured so we
  // can assert the exact options.num_ctx — a model advertising 262144 must never
  // translate into a 262144-token request (real Windows failure: ~35.4 GB KV).
  const chatBodies: { options?: { num_ctx?: number }; model?: string; messages?: unknown[] }[] = [];
  const adapter = new OllamaAdapter({
    baseUrl: BASE,
    fetchImpl: async (u, i) => {
      if (String(u).includes('/api/chat') && i?.body) {
        chatBodies.push(JSON.parse(String(i.body)) as { options?: { num_ctx?: number }; model?: string; messages?: unknown[] });
      }
      return fetch(u as Parameters<typeof fetch>[0], i);
    },
  });

  let chatModel = '';
  let embedModel = '';

  beforeAll(async () => {
    const all = await adapter.discoverModels();
    // chat-capable = advertises text_generation and is NOT embedding-only
    const chatCapable = all.filter((m) => m.capabilities.includes('text_generation') && !m.capabilities.includes('embeddings'));
    if (wantModel) {
      const pinned = chatCapable.find((m) => m.name === wantModel);
      if (!pinned) {
        throw new Error(
          `LPAI_OLLAMA_MODEL='${wantModel}' is not an installed chat-capable model ` +
            `(chat-capable found: ${chatCapable.map((m) => m.name).join(', ') || 'NONE'})`,
        );
      }
      chatModel = pinned.name;
    } else {
      const preferred = chatCapable.find((m) => m.name.startsWith('qwen3:4b'));
      chatModel = (preferred ?? chatCapable[0])?.name ?? '';
    }
    if (!chatModel) throw new Error('no chat-capable model installed — `ollama pull` a chat model first');
    const embedCapable = all.filter((m) => m.capabilities.includes('embeddings'));
    if (wantEmbed) {
      const pinned = embedCapable.find((m) => m.name === wantEmbed);
      if (!pinned) throw new Error(`LPAI_OLLAMA_EMBED_MODEL='${wantEmbed}' is not an installed embedding-capable model`);
      embedModel = pinned.name;
    } else {
      embedModel = embedCapable[0]?.name ?? '';
    }
    console.log(`[live] chat model selected: ${chatModel} (preferred: qwen3:4b, fallback: first chat-capable)`);
    console.log(`[live] embed model selected: ${embedModel || 'NONE'}`);
  }, 60_000);

  it('every /api/chat request carries an explicit, bounded num_ctx (context bug regression)', async () => {
    await adapter.chat.generate({
      modelId: `ollama:${chatModel}`,
      messages: [{ role: 'user', content: 'Say: ctx' }],
      maxTokens: 8,
      contextTokens: TEST_NUM_CTX,
    } as never);
    expect(chatBodies.length).toBeGreaterThan(0);
    const sent = chatBodies.at(-1)!.options?.num_ctx;
    console.log(`[live] exact num_ctx sent to ${chatModel}: ${sent}`);
    expect(sent).toBe(TEST_NUM_CTX); // explicit small context -> honored (beats OLLAMA_CONTEXT_LENGTH env too)
    // the DEFAULT (no contextTokens) is never the advertised maximum either —
    // advertised = the true /api/show model max (e.g. qwen3:4b reports 262144)
    const advertised = await adapter.refineContext(chatModel);
    await adapter.chat.generate({
      modelId: `ollama:${chatModel}`,
      messages: [{ role: 'user', content: 'Say: ctx2' }],
      maxTokens: 8,
    } as never);
    const def = chatBodies.at(-1)!.options!.num_ctx!;
    expect(def).toBeGreaterThan(0); // ALWAYS sent, never missing (undefined vanished in JSON.stringify before)
    if (advertised > def) expect(def).not.toBe(advertised); // big-context models must land on the bounded default
    console.log(`[live] default-path num_ctx: ${def} (model-advertised max: ${advertised}, informational only)`);
  }, 180_000);

  it('health check reports reachable with real model count and latency', async () => {
    const h = await adapter.healthCheck();
    expect(h.state).toBe('OK');
    expect(h.modelCount).toBeGreaterThanOrEqual(1);
    expect(typeof h.latencyMs).toBe('number');
  });

  it('model discovery carries quantization, context and capability-gated selection', async () => {
    const models = await adapter.discoverModels();
    const model = models.find((m) => m.name === chatModel);
    expect(model, `selected chat model ${chatModel} must be discovered`).toBeDefined();
    expect(model!.capabilities).toContain('text_generation');
    expect(model!.capabilities, 'a chat-capable model must not be classified embedding-only').not.toContain('embeddings');
    // embedding-only models must never surface as chat candidates (Windows failure:
    // nomic-embed-text sorted alphabetically before the real chat models)
    for (const m of models.filter((x) => x.capabilities.includes('embeddings'))) {
      expect(m.capabilities, `${m.name} is embedding-only and must not advertise text_generation`).not.toContain('text_generation');
    }
    const ctx = await adapter.refineContext(model!.name);
    expect(ctx).toBeGreaterThanOrEqual(2048); // real value read from /api/show, not a guess
  });

  it('non-streaming generation returns real text with server-side usage counters', async () => {
    const res = await adapter.chat.generate({
      modelId: `ollama:${chatModel}`,
      messages: [{ role: 'user', content: 'Reply with exactly: LPONAMA-OK and nothing else.' }],
      maxTokens: 64,
      contextTokens: TEST_NUM_CTX,
    } as never);
    // Adapter behavior, not model obedience: exact-echo compliance is a MODEL
    // capability — the contract under test is real completion + real counters
    // through a bounded ctx.
    expect(res.text.trim().length).toBeGreaterThan(0);
    expect(res.finishReason).toBeTruthy(); // server reported a completion state
    expect(res.usage?.outputTokens).toBeGreaterThan(0); // eval_count from the actual run
    expect(res.usage?.inputTokens).toBeGreaterThan(0); // prompt_eval_count
    expect(res.usage!.inputTokens!).toBeLessThanOrEqual(TEST_NUM_CTX); // bounded context, not 262144
  }, 180_000);

  it('streaming yields progressive deltas', async () => {
    const chunks: string[] = [];
    for await (const c of adapter.chat.stream({
      modelId: `ollama:${chatModel}`,
      messages: [{ role: 'user', content: 'Count from 1 to 12, one number per line, nothing else.' }],
      maxTokens: 96,
      contextTokens: TEST_NUM_CTX,
    } as never)) {
      if (c.textDelta) chunks.push(c.textDelta);
    }
    const text = chunks.join('');
    // multiple deltas + real content — counting correctly is the model's job, not ours
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(text.trim().length).toBeGreaterThan(0);
  }, 180_000);

  it('cancellation stops generation mid-flight', async () => {
    const ctrl = new AbortController();
    let chunks = 0;
    let stopped = false;
    let tAbort = 0; // timestamp captured IMMEDIATELY BEFORE abort() — not after
    try {
      for await (const c of adapter.chat.stream({
        modelId: `ollama:${chatModel}`,
        messages: [{ role: 'user', content: 'Write a very long story about everything, at least 500 words.' }],
        maxTokens: 1024, // > 500-chunk runaway guard below, small enough to bound the negative case
        contextTokens: 4096, // room for the long story until abort lands mid-flight
        signal: ctrl.signal,
      } as never)) {
        if (c.textDelta && ++chunks === 2) {
          tAbort = Date.now();
          ctrl.abort();
        }
      }
    } catch {
      stopped = true; // abort surfaces as a stream error — must not hang or silently continue
    }
    if (tAbort > 0) {
      // The whole point: Stop takes effect IMMEDIATELY (regression: an abort bridge
      // removed at response-headers did nothing mid-stream and generation ran to the
      // num_predict cap). Measured from the pre-abort timestamp, only when an abort
      // actually happened (so a trivially-short completion can never read as epoch-ms).
      expect(stopped, 'abort must terminate the stream with an error, not fall through').toBe(true);
      expect(Date.now() - tAbort, 'stop must land well under the 15 s requirement').toBeLessThan(15_000);
    } else {
      expect(chunks, 'model finished before 2 deltas — must still not run away').toBeLessThan(500);
    }
  }, 300_000);

  it('idle unload really evicts the model (api/ps before vs after, §56)', async () => {
    // ensure something is loaded first
    await adapter.chat.generate({
      modelId: `ollama:${chatModel}`,
      messages: [{ role: 'user', content: 'Say: loaded' }],
      maxTokens: 8,
      contextTokens: TEST_NUM_CTX,
    } as never);
    let loaded = await ps(adapter);
    expect(loaded.length).toBeGreaterThanOrEqual(1);
    for (const m of loaded) expect(await adapter.unloadModel(`ollama:${m.name}`)).toBe(true);
    const deadline = Date.now() + 15_000;
    while ((loaded = await ps(adapter)).length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
    expect(loaded.length).toBe(0); // VRAM/RAM actually freed — not just a flag flipped
  }, 300_000);

  it('embeddings: real vectors with meaningful similarity (indexing seam)', async () => {
    expect(embedModel, 'no embedding-capable model installed — ollama pull nomic-embed-text').not.toBe('');
    const vecs = await adapter.embeddings.embed(`ollama:${embedModel}`, [
      'Der Hund läuft durch den Park.',
      'Ein Hund rennt über die Wiese.',
      'Quartalsbericht der Bank für 2025.',
    ]);
    expect(vecs.length).toBe(3);
    const [a, b, c] = vecs as [number[], number[], number[]];
    expect(a.length).toBeGreaterThan(100);
    const cos = (x: number[], y: number[]): number => {
      let d = 0,
        n1 = 0,
        n2 = 0;
      for (let i = 0; i < x.length; i++) {
        d += x[i]! * y[i]!;
        n1 += x[i]! * x[i]!;
        n2 += y[i]! * y[i]!;
      }
      return d / (Math.sqrt(n1) * Math.sqrt(n2));
    };
    expect(cos(a, b)).toBeGreaterThan(cos(a, c)); // paraphrase scores higher than unrelated text
  }, 180_000);

  it('wire invariant: EVERY captured /api/chat payload carried an explicit bounded num_ctx', () => {
    // generation traffic only — the unload eviction ping (messages: [], keep_alive:0)
    // carries no options at all, correctly (nothing is generated there)
    const gen = chatBodies.filter((b) => Array.isArray(b.messages) && (b.messages as unknown[]).length > 0);
    expect(gen.length).toBeGreaterThanOrEqual(4);
    for (const b of gen) {
      const n = b.options?.num_ctx;
      expect(n, `num_ctx must be explicit on every chat request (${b.model})`).toBeTypeOf('number');
      expect(n!).toBeGreaterThan(0);
      expect(n!, `${b.model} ran with model-max context (${n}) instead of a hardware-bounded window`).toBeLessThanOrEqual(32_768);
    }
    // the small explicit test context must actually appear on the wire, repeatedly
    expect(gen.filter((b) => b.options?.num_ctx === TEST_NUM_CTX).length).toBeGreaterThanOrEqual(4);
  });
});

/**
 * Activation rules — run in EVERY normal `npm test` (outside the live gate),
 * so the silent "9 skipped although the live env was set" class of failure
 * can never return unnoticed.
 */
describe('live-suite activation (regression)', () => {
  const T = ollamaLiveActivation;
  it('stays OFF by default — plain npm test must not need Ollama', () => {
    expect(T({}).on).toBe(false);
  });
  it('LPAI_LIVE_OLLAMA=1 activates with the default local endpoint (the Windows-box flow)', () => {
    const r = T({ LPAI_LIVE_OLLAMA: '1' });
    expect(r.on).toBe(true);
    expect(r.baseUrl).toBe(DEFAULT_OLLAMA_URL);
  });
  it('LPAI_OLLAMA_URL alone still activates and sets the endpoint (established flow)', () => {
    const r = T({ LPAI_OLLAMA_URL: 'http://10.0.0.5:11434' });
    expect(r.on).toBe(true);
    expect(r.baseUrl).toBe('http://10.0.0.5:11434');
  });
  it('flag + URL compose: flag enables, URL overrides endpoint — no competing semantics', () => {
    const r = T({ LPAI_LIVE_OLLAMA: 'true', LPAI_OLLAMA_URL: 'http://127.0.0.1:19999' });
    expect(r.on).toBe(true);
    expect(r.baseUrl).toBe('http://127.0.0.1:19999');
  });
  it('explicit 0/false/off force-disables and wins over a stray URL (deterministic kill switch)', () => {
    for (const off of ['0', 'false', 'off']) {
      expect(T({ LPAI_LIVE_OLLAMA: off, LPAI_OLLAMA_URL: 'http://x:1' }).on, off).toBe(false);
    }
  });
  it('empty-string flag counts as unset (Windows $env:X="" semantics)', () => {
    expect(T({ LPAI_LIVE_OLLAMA: '' }).on).toBe(false);
  });
});
