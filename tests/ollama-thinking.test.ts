/**
 * qwen3-class thinking responses (real Windows failure, ollama 0.34.0):
 * non-streaming /api/chat with a small num_predict returns
 *   message.content === ''   message.thinking === '<reasoning…>'   done_reason === 'length'
 * The adapter must (1) never discard `thinking` — it goes to the SEPARATE
 * `reasoning` field, never into visible text; (2) report the server's
 * `done_reason` (a truncated answer is 'length', not a clean 'stop'); and
 * (3) keep bounded SHORT requests to thinking-capable models from burning the
 * whole cap on reasoning — body.think:false, capability-gated via /api/show so
 * non-thinking models and large budgets are untouched.
 *
 * All fixtures below are the byte-for-byte shapes captured from the real
 * server (see docs/PHASE_MAP.md, fifteenth pass).
 */
import { describe, expect, it } from 'vitest';
import { OllamaAdapter } from '../src/main/providers/adapters/ollama.js';
import type { GenerationChunk } from '../src/shared/types/models.js';

const TRUNCATED_RAW = {
  model: 'qwen3:0.6b',
  created_at: '2026-09-12T15:43:52.324069355Z',
  message: {
    role: 'assistant',
    content: '',
    thinking:
      'Okay, the user wants me to reply with exactly "LPONAMA-OK" and nothing else. Let me make sure I understand their request correctly.',
  },
  done: true,
  done_reason: 'length',
  prompt_eval_count: 23,
  eval_count: 64,
};

function harness(opts: { showCapabilities?: string[]; showFails?: boolean; chatResponse?: unknown; streamLines?: string[] } = {}) {
  const chatBodies: Record<string, unknown>[] = [];
  let showCalls = 0;
  const fetchImpl = (async (u: unknown, init?: { body?: unknown }) => {
    const url = String(u);
    if (url.endsWith('/api/show')) {
      showCalls++;
      if (opts.showFails) return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as unknown as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 262144 },
          ...(opts.showCapabilities ? { capabilities: opts.showCapabilities } : {}),
        }),
      } as unknown as Response;
    }
    if (url.endsWith('/api/chat')) {
      chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (opts.streamLines) {
        const enc = new TextEncoder();
        const chunks = opts.streamLines.map((l) => enc.encode(`${l}\n`));
        let i = 0;
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
            }),
          },
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => opts.chatResponse ?? TRUNCATED_RAW } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  const adapter = new OllamaAdapter({ baseUrl: 'http://test', fetchImpl });
  return { adapter, chatBodies, showCalls: () => showCalls };
}

const req = (extra: Record<string, unknown> = {}) => ({
  modelId: 'ollama:qwen3:0.6b',
  messages: [{ role: 'user', content: 'Reply with exactly: LPONAMA-OK and nothing else.' }],
  ...extra,
});

describe('ollama thinking/reasoning normalization (raw response shapes)', () => {
  it('truncated thinking response: content stays EMPTY text, thinking is KEPT as reasoning, done_reason maps honestly', async () => {
    const h = harness({ showCapabilities: ['completion', 'tools', 'thinking'] });
    const r = await h.adapter.chat.generate(req({ maxTokens: 64 }) as never);
    expect(r.text).toBe(''); // never inflated with reasoning
    expect(r.reasoning, 'thinking field must not be discarded').toContain('Okay, the user wants me to reply');
    expect(r.finishReason, 'num_predict truncation must not masquerade as clean stop').toBe('length');
    expect(r.usage?.outputTokens).toBe(64);
    expect(r.usage?.inputTokens).toBe(23);
  });

  it('short bounded request to a thinking-capable model sends think:false — the fix that restores real answer text', async () => {
    const h = harness({
      showCapabilities: ['completion', 'tools', 'thinking'],
      chatResponse: { ...TRUNCATED_RAW, message: { role: 'assistant', content: 'LPONAMA-OK' }, done_reason: 'stop', eval_count: 6 },
    });
    const r = await h.adapter.chat.generate(req({ maxTokens: 64 }) as never);
    expect(h.chatBodies[0]).toMatchObject({ think: false }); // Ollama honors this -> visible answer fits the cap
    expect(r.text).toBe('LPONAMA-OK');
    expect(r.finishReason).toBe('stop');
    expect(r.reasoning, 'no thinking field -> no reasoning, never invented').toBeUndefined();
  });

  it('capability gate is precise: large budgets and non-thinking models never receive a think key', async () => {
    const h1 = harness({ showCapabilities: ['completion', 'tools', 'thinking'] });
    await h1.adapter.chat.generate(req({ maxTokens: 1024 }) as never);
    expect(h1.chatBodies[0]).not.toHaveProperty('think'); // thinking stays on at >= 1024
    await h1.adapter.chat.generate(req() as never);
    expect(h1.chatBodies[1]).not.toHaveProperty('think'); // unbounded -> untouched
    const h2 = harness({ showCapabilities: ['completion', 'tools'] });
    await h2.adapter.chat.generate(req({ maxTokens: 8 }) as never);
    expect(h2.chatBodies[0]).not.toHaveProperty('think'); // non-thinking model -> never sent
    const h3 = harness({ showFails: true });
    await h3.adapter.chat.generate(req({ maxTokens: 8 }) as never);
    expect(h3.chatBodies[0]).not.toHaveProperty('think'); // /api/show unreachable -> safe default
    expect(h3.showCalls(), 'capability probe cached per model').toBe(1);
  });

  it('stream: thinking lines surface as reasoningDelta with EMPTY textDelta; answer lines stay pure text — never mixed', async () => {
    const h = harness({
      showCapabilities: ['completion', 'tools', 'thinking'],
      streamLines: [
        '{"model":"qwen3:0.6b","created_at":"2026-09-12T15:43:52.817824133Z","message":{"role":"assistant","content":"","thinking":"Okay"},"done":false}',
        '{"model":"qwen3:0.6b","created_at":"2026-09-12T15:43:52.876481805Z","message":{"role":"assistant","content":"","thinking":","},"done":false}',
        '{"model":"qwen3:0.6b","created_at":"2026-09-12T15:43:53.500000000Z","message":{"role":"assistant","content":"LPONAMA-OK"},"done":false}',
        '{"model":"qwen3:0.6b","created_at":"2026-09-12T15:43:53.600000000Z","done":true,"done_reason":"stop","eval_count":12}',
      ],
    });
    const got: GenerationChunk[] = [];
    for await (const c of h.adapter.chat.stream(req({ maxTokens: 96 }) as never)) got.push(c);
    expect(got.length).toBe(3);
    expect(got[0]).toMatchObject({ textDelta: '', reasoningDelta: 'Okay' });
    expect(got[1]?.reasoningDelta).toBe(',');
    expect(got[2]).toEqual({ textDelta: 'LPONAMA-OK' }); // no reasoningDelta on answer lines
    for (const c of got) expect(c.textDelta.length === 0 || c.reasoningDelta === undefined, 'no mixing').toBe(true);
    expect(h.chatBodies[0]).toMatchObject({ think: false, stream: true }); // guard applies on the stream path too
  });

  it('legacy non-thinking stream shape (qwen2.5) is byte-identical in behavior', async () => {
    const h = harness({
      showCapabilities: ['completion', 'tools'],
      streamLines: ['{"message":{"role":"assistant","content":"Hello"},"done":false}', '{"done":true,"done_reason":"stop"}'],
    });
    const got: GenerationChunk[] = [];
    for await (const c of h.adapter.chat.stream(req({ maxTokens: 40 }) as never)) got.push(c);
    expect(got).toEqual([{ textDelta: 'Hello' }]);
    expect(h.chatBodies[0]).not.toHaveProperty('think');
  });
});
