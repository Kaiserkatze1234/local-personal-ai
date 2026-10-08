/**
 * openaiCompat stream contract — regression for the part-3 fixes that were
 * only unit-pinned on the Ollama adapter: max_tokens must travel on the stream
 * path too, mid-stream abort must terminate (request-lifetime signal), and an
 * early consumer break must release the HTTP body.
 */
import { describe, expect, it } from 'vitest';
import { OpenAiCompatAdapter } from '../src/main/providers/adapters/openaiCompat.js';
import type { GenerationRequest } from '../src/shared/types/models.js';

interface Fake {
  bodies: Record<string, unknown>[];
  events: string[];
  fetchImpl: typeof fetch;
}

function fakeSse(opts: { honorAbort: boolean; trickle: boolean; endless?: boolean }): Fake {
  const bodies: Record<string, unknown>[] = [];
  const events: string[] = [];
  const enc = new TextEncoder();
  const fetchImpl = (async (u: unknown, init?: { body?: unknown; signal?: AbortSignal | null }) => {
    if (String(u).endsWith('/chat/completions')) {
      bodies.push(JSON.parse(String(init?.body)));
      events.push('open');
      let delivered = 0;
      let pending: { res: (v: unknown) => void; rej: (e: unknown) => void } | null = null;
      if (opts.honorAbort) {
        init?.signal?.addEventListener('abort', () => {
          events.push('transport-abort');
          pending?.rej(new DOMException('Aborted', 'AbortError'));
        });
      }
      const line = () => enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `tok${delivered}` } }] })}\n`);
      const read = (): Promise<unknown> => {
        if (delivered < 2) {
          delivered++;
          if (opts.trickle) return new Promise((r) => setTimeout(() => r({ done: false, value: line() }), 5));
          return Promise.resolve({ done: false, value: line() });
        }
        if (!opts.endless) return Promise.resolve({ done: true, value: undefined });
        return new Promise((res, rej) => {
          pending = { res, rej };
          if (opts.trickle) {
            setTimeout(() => {
              pending = null;
              delivered++;
              res({ done: false, value: line() });
            }, 30);
          }
        });
      };
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read,
            cancel: () => {
              events.push('body-cancel');
              pending?.res({ done: true, value: undefined });
              return Promise.resolve();
            },
          }),
        },
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '' } as unknown as Response;
  }) as unknown as typeof fetch;
  return { bodies, events, fetchImpl };
}

const req = (extra: Partial<GenerationRequest> = {}): GenerationRequest => ({
  modelId: 'openai_compat:dummy-model',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

describe('openaiCompat stream: bounded length, real abort, body release', () => {
  it('maxTokens reaches the stream body as max_tokens; unset stays absent', async () => {
    const f = fakeSse({ honorAbort: true, trickle: false, endless: false });
    const a = new OpenAiCompatAdapter({ baseUrl: 'http://test', fetchImpl: f.fetchImpl });
    for await (const _c of a.chat.stream(req({ maxTokens: 40 }))) {
      /* consume to stream end */
    }
    expect(f.bodies[0]).toMatchObject({ stream: true, max_tokens: 40 });
    for await (const _c of a.chat.stream(req())) {
      /* consume to stream end */
    }
    expect(f.bodies[1]).not.toHaveProperty('max_tokens');
  });

  it('abort AFTER response headers still terminates the stream (request-lifetime signal)', async () => {
    const f = fakeSse({ honorAbort: true, trickle: false });
    const a = new OpenAiCompatAdapter({ baseUrl: 'http://test', fetchImpl: f.fetchImpl });
    const ctrl = new AbortController();
    let n = 0;
    await expect(
      (async () => {
        for await (const _c of a.chat.stream(req({ signal: ctrl.signal }))) if (++n === 2) ctrl.abort();
      })(),
    ).rejects.toThrow(/Abort/i);
    expect(f.events).toContain('transport-abort');
    expect(n).toBe(2);
  });

  it('early break in the consumer releases the HTTP body', async () => {
    const f = fakeSse({ honorAbort: true, trickle: false });
    const a = new OpenAiCompatAdapter({ baseUrl: 'http://test', fetchImpl: f.fetchImpl });
    for await (const _c of a.chat.stream(req())) break;
    expect(f.events).toContain('body-cancel');
  });
});
