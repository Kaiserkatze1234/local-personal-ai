/**
 * LEVEL 4 — real provider/model tests (testing philosophy, spec §44). These
 * run the PRODUCTION OllamaAdapter against a real ollama server with real
 * models. They only run when LPAI_OLLAMA_URL is set (opt-in), so the normal
 * suite never depends on a local service. On the Windows target box:
 *
 *   $env:LPAI_OLLAMA_URL='http://127.0.0.1:11434'
 *   $env:LPAI_OLLAMA_MODEL='qwen2.5:0.5b'   # any chat model you have
 *   npx vitest run tests/ollama-live.test.ts
 *
 * Nothing here is mocked: usage tokens come from the server's own counters,
 * the unload check reads /api/ps.
 */
import { describe, expect, it } from 'vitest';
import { OllamaAdapter } from '../src/main/providers/adapters/ollama.js';

const BASE = process.env.LPAI_OLLAMA_URL;
const wantModel = process.env.LPAI_OLLAMA_MODEL;
const live = BASE ? describe : describe.skip;

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
  const chatBodies: { options?: { num_ctx?: number }; model?: string }[] = [];
  const adapter = new OllamaAdapter({
    baseUrl: BASE,
    fetchImpl: async (u, i) => {
      if (String(u).includes('/api/chat') && i?.body) {
        chatBodies.push(JSON.parse(String(i.body)) as { options?: { num_ctx?: number }; model?: string });
      }
      return fetch(u as Parameters<typeof fetch>[0], i);
    },
  });

  it('every /api/chat request carries an explicit, bounded num_ctx (context bug regression)', async () => {
    const modelName = wantModel ?? (await adapter.discoverModels()).find((m) => m.capabilities.includes('text_generation'))!.name;
    await adapter.chat.generate({
      modelId: `ollama:${modelName}`,
      messages: [{ role: 'user', content: 'Say: ctx' }],
      maxTokens: 8,
      contextTokens: TEST_NUM_CTX,
    } as never);
    expect(chatBodies.length).toBeGreaterThan(0);
    const sent = chatBodies.at(-1)!.options?.num_ctx;
    console.log(`[live] exact num_ctx sent to ${modelName}: ${sent}`);
    expect(sent).toBe(TEST_NUM_CTX); // explicit small context -> honored (beats OLLAMA_CONTEXT_LENGTH env too)
    // the DEFAULT (no contextTokens) is never the advertised maximum either —
    // advertised = the true /api/show model max (e.g. qwen3:4b reports 262144)
    const advertised = await adapter.refineContext(modelName);
    await adapter.chat.generate({
      modelId: `ollama:${modelName}`,
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

  it('model discovery carries quantization, context and inferred capabilities', async () => {
    const models = await adapter.discoverModels();
    const model = wantModel ? models.find((m) => m.name === wantModel) : models.find((m) => m.capabilities.includes('text_generation'));
    expect(model, `model ${wantModel ?? 'with text_generation'} must be installed`).toBeDefined();
    expect(model!.capabilities).toContain('text_generation');
    const ctx = await adapter.refineContext(model!.name);
    expect(ctx).toBeGreaterThanOrEqual(2048); // real value read from /api/show, not a guess
  });

  it('non-streaming generation returns real text with server-side usage counters', async () => {
    const res = await adapter.chat.generate({
      modelId: `ollama:${wantModel ?? 'x'}`,
      messages: [{ role: 'user', content: 'Reply with exactly: LPONAMA-OK and nothing else.' }],
      maxTokens: 64,
      contextTokens: TEST_NUM_CTX,
    } as never);
    expect(res.text.toLowerCase()).toContain('lponama-ok');
    expect(res.usage?.outputTokens).toBeGreaterThan(0); // eval_count from the actual run
    expect(res.usage?.inputTokens).toBeGreaterThan(0); // prompt_eval_count
  }, 180_000);

  it('streaming yields progressive deltas', async () => {
    const chunks: string[] = [];
    for await (const c of adapter.chat.stream({
      modelId: `ollama:${wantModel ?? 'x'}`,
      messages: [{ role: 'user', content: 'Count from 1 to 12, one number per line, nothing else.' }],
      maxTokens: 96,
      contextTokens: TEST_NUM_CTX,
    } as never)) {
      if (c.textDelta) chunks.push(c.textDelta);
    }
    const text = chunks.join('');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(text).toMatch(/1[\s.]*2[\s.]*3/); // progressive output actually arrives
  }, 180_000);

  it('cancellation stops generation mid-flight', async () => {
    const ctrl = new AbortController();
    let chunks = 0;
    let stopped = false;
    try {
      for await (const c of adapter.chat.stream({
        modelId: `ollama:${wantModel ?? 'x'}`,
        messages: [{ role: 'user', content: 'Write a very long story about everything, at least 500 words.' }],
        maxTokens: 2048,
        contextTokens: 4096, // room for the long story until abort lands mid-flight
        signal: ctrl.signal,
      } as never)) {
        if (c.textDelta && ++chunks === 2) ctrl.abort();
      }
    } catch {
      stopped = true; // abort surfaces as a stream error — must not hang or silently continue
    }
    expect(stopped || chunks < 500).toBe(true);
    if (!stopped) expect(chunks).toBeLessThan(500);
  }, 300_000);

  it('idle unload really evicts the model (api/ps before vs after, §56)', async () => {
    // ensure something is loaded first
    await adapter.chat.generate({
      modelId: `ollama:${wantModel ?? 'x'}`,
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
    const embedModel = (await adapter.discoverModels()).find((m) => m.capabilities.includes('embeddings'));
    expect(embedModel, 'install nomic-embed-text (ollama pull nomic-embed-text)').toBeDefined();
    const vecs = await adapter.embeddings.embed(`ollama:${embedModel!.name}`, [
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
});
