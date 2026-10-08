import { describe, expect, it } from 'vitest';
import { AppError } from '../src/main/core/errors.js';
import { MockProvider } from '../src/main/providers/adapters/mock.js';
import { inferCapabilities, OllamaAdapter } from '../src/main/providers/adapters/ollama.js';
import { makeTestApp } from './helpers.js';

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } });
}

describe('ollama adapter (as adapter only, never core)', () => {
  it('infers capabilities by name heuristics', () => {
    expect(inferCapabilities('qwen2.5-coder:7b', 'qwen2')).toContain('tool_calling');
    expect(inferCapabilities('llava:13b', undefined)).toContain('vision');
    // embedding-only models never advertise chat (Windows failure: nomic sorted before chat models)
    for (const e of ['nomic-embed-text', 'bge-m3:latest', 'snowflake-arctic-embed:latest', 'all-minilm']) {
      const c = inferCapabilities(e, 'bert');
      expect(c, e).toContain('embeddings');
      expect(c, e).not.toContain('text_generation');
      expect(c, e).not.toContain('streaming');
    }
    expect(inferCapabilities('qwen2.5:0.5b', 'qwen2')).toContain('text_generation');
    expect(inferCapabilities('nomic-embed-text', undefined)).toContain('embeddings');
  });

  it('health + discovery + non-streaming chat + streaming parse via stub fetch', async () => {
    let lastBody: Record<string, unknown> = {};
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/tags'))
        return jsonResponse({
          models: [
            {
              name: 'qwen2.5-coder:7b',
              model: 'qwen2.5-coder:7b',
              size: 4_700_000_000,
              details: { family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' },
            },
          ],
        });
      if (u.endsWith('/api/chat')) {
        lastBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (lastBody.stream === true) {
          const ndjson = `${[
            { message: { content: 'Hello ' }, done: false },
            { message: { content: 'world' }, done: false },
            { message: { content: '' }, done: true, eval_count: 3 },
          ]
            .map((x) => JSON.stringify(x))
            .join('\n')}\n`;
          return new Response(ndjson, { headers: { 'content-type': 'application/x-ndjson' } });
        }
        return jsonResponse({
          message: { content: 'hi there', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }] },
          done: true,
          prompt_eval_count: 10,
          eval_count: 4,
        });
      }
      if (u.endsWith('/api/embed')) return jsonResponse({ embeddings: [[0.5, 0.5]] });
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const a = new OllamaAdapter({ fetchImpl });
    const health = await a.healthCheck();
    expect(health.state).toBe('OK');
    const models = await a.discoverModels();
    expect(models[0]?.parameterCountB).toBe(7.6);
    expect(models[0]?.capabilities).toContain('tool_calling');

    const res = await a.chat.generate({
      modelId: 'ollama:qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'read_file', description: '', parameters: {} }],
    });
    expect(res.text).toBe('hi there');
    expect(res.toolCalls[0]?.name).toBe('read_file');
    expect(res.finishReason).toBe('tool_calls');
    expect((lastBody.tools as unknown[]).length).toBe(1);

    let streamText = '';
    for await (const c of a.chat.stream({ modelId: 'ollama:qwen2.5-coder:7b', messages: [{ role: 'user', content: 'x' }] }))
      streamText += c.textDelta;
    expect(streamText).toBe('Hello world');

    const emb = await a.embeddings.embed('ollama:nomic-embed-text', ['a', 'b']);
    expect(emb.length).toBe(1);
  });

  it('reports UNAVAILABLE (not fake OK) when server is down', async () => {
    const a = new OllamaAdapter({
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });
    const h = await a.healthCheck();
    expect(h.state).toBe('UNAVAILABLE');
    expect(h.message).toContain('ollama.com');
  });
});

describe('mock provider', () => {
  it('streams scripted chunks and consumes script in order', async () => {
    const m = new MockProvider({ script: [{ text: 'first' }, { chunks: ['a', 'b'] }, 'third'] });
    const r1 = await m.chat.generate({ modelId: 'mock:x', messages: [{ role: 'user', content: 'q' }] });
    expect(r1.text).toBe('first');
    let acc = '';
    for await (const c of m.chat.stream({ modelId: 'mock:x', messages: [] })) acc += c.textDelta;
    expect(acc).toBe('ab');
    const r3 = await m.chat.generate({ modelId: 'mock:x', messages: [{ role: 'user', content: 'q' }] });
    expect(r3.text).toBe('third');
    // script exhausted -> echo mode, still never throws
    const echo = await m.chat.generate({ modelId: 'mock:x', messages: [{ role: 'user', content: 'hello?' }] });
    expect(echo.text).toContain('hello?');
    expect(echo.text).toContain('demo');
  });
});

describe('provider registry + role routing (§6/§7)', () => {
  it('auto-assigns roles after discovery and honors overrides', async () => {
    const t = await makeTestApp();
    try {
      const roles = t.app.roles.list();
      expect(roles.some((r) => r.role === 'chat')).toBe(true);
      // override
      t.app.config.patch({ ai: { routingOverride: { chat: 'mock:demo-local-1' } } });
      const decision = t.app.router.select('chat', 'chat');
      expect(decision.modelId).toBe('mock:demo-local-1');
      expect(decision.reason).toContain('User override');
    } finally {
      await t.cleanup();
    }
  });

  it('fails honestly when no vision-capable model exists (§3.8)', async () => {
    const t = await makeTestApp();
    try {
      // limited provider: only plain text; disable the full-capability demo model
      t.app.providers.register(
        new MockProvider({ id: 'limited', label: 'limited', modelName: 'tiny', capabilities: ['text_generation', 'streaming'] }),
        { kind: 'mock' },
      );
      await t.app.providers.refreshProvider('limited');
      t.app.providers.setEnabled('mock', false);
      await t.app.providers.refreshProvider('mock');
      expect(() => t.app.router.select('vision', 'vision', { needsVision: true })).toThrowError(AppError);
      try {
        t.app.router.select('vision', 'vision', { needsVision: true });
      } catch (err) {
        expect((err as AppError).message).toContain('vision');
      }
    } finally {
      await t.cleanup();
    }
  });
});
