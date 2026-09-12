/**
 * Budget/wire alignment: the context engine must fit prompts to the window the
 * adapter actually sends as num_ctx (shared/util/limits is the single policy) —
 * otherwise Ollama silently prunes the difference and the §63 transparency
 * panel describes tokens the model never sees. Real-Windows bug class:
 * budget 8192 vs num_ctx 4096.
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/shared/types/models.js';
import { clampRuntimeContext, effectivePromptBudget, hardwareContextCeiling, MIN_NUM_CTX } from '../src/shared/util/limits.js';
import { FOLD_PREFIX, fitMessagesToWindow } from '../src/shared/util/messageFit.js';
import { estimateTokens } from '../src/shared/util/text.js';
import { makeTestApp } from './helpers.js';

describe('shared context policy (limits.ts is the one source)', () => {
  it('clampRuntimeContext: invalid/0/negative fall back to the safe default; floor and ceiling hold', () => {
    expect(clampRuntimeContext(undefined, 32768)).toBe(4096);
    expect(clampRuntimeContext(0, 32768)).toBe(4096);
    expect(clampRuntimeContext(-5, 32768)).toBe(4096);
    expect(clampRuntimeContext(Number.NaN, 32768)).toBe(4096);
    expect(clampRuntimeContext(100, 32768)).toBe(MIN_NUM_CTX);
    expect(clampRuntimeContext(262144, 16384)).toBe(16384); // model-max can never pass through
    expect(clampRuntimeContext(8192, 16384)).toBe(8192);
  });

  it('effectivePromptBudget: never above the window, reserves completion room, keeps a smaller user budget', () => {
    expect(effectivePromptBudget(8192, 4096, 0.25, 32768)).toBe(3072); // 8k budget into a 4k window -> 3k prompt + 1k answer
    expect(effectivePromptBudget(2048, 4096, 0.25, 32768)).toBe(2048);
    expect(effectivePromptBudget(8192, 8192, 0.25, 32768)).toBe(6144);
    expect(effectivePromptBudget(16000, 32768, 0.25, 4096)).toBe(3072); // hardware ceiling beats the config value
    expect(effectivePromptBudget(Number.NaN, 4096, 0.25, 32768)).toBe(3072);
    for (const [b, rt] of [
      [8192, 4096],
      [1, 1],
      [999999, 32768],
      [6000, 2048],
      [4096, 1024],
    ] as [number, number][]) {
      expect(effectivePromptBudget(b, rt, 0.25, 32768), `budget ${b} @ window ${rt}`).toBeLessThanOrEqual(clampRuntimeContext(rt, 32768));
    }
  });

  it('hardware ceiling table: coarse, monotone, conservative when unknown', () => {
    const gib = (n: number) => n * 1024 ** 3;
    expect(hardwareContextCeiling(gib(6))).toBe(4096);
    expect(hardwareContextCeiling(gib(16))).toBe(16384);
    expect(hardwareContextCeiling(gib(64))).toBe(32768);
    expect(hardwareContextCeiling(0)).toBe(8192);
  });
});

describe('context engine fit == wire window (no silent server-side pruning)', () => {
  it('8192 assemble-budget against a 2048 num_ctx fits 1536 and reports THAT honestly', async () => {
    const t = await makeTestApp({ config: { ai: { contextTokenBudget: 8192, runtimeContextTokens: 2048 } } });
    try {
      const r = await t.app.contextEngine.build({ userText: 'was gestern passierte', taskClass: 'chat' });
      expect(r.budget).toBe(1536); // floor(2048 * 0.75) — same policy the adapter clamps with (ceil >= 4096 on every machine branch)
      expect(r.totalTokens).toBeLessThanOrEqual(r.budget);
    } finally {
      await t.cleanup();
    }
  });

  it('a smaller user budget is never inflated toward the window', async () => {
    const t = await makeTestApp({ config: { ai: { contextTokenBudget: 1024, runtimeContextTokens: 32768 } } });
    try {
      const r = await t.app.contextEngine.build({ userText: 'hi', taskClass: 'chat' });
      expect(r.budget).toBe(1024);
    } finally {
      await t.cleanup();
    }
  });
});

describe('fitMessagesToWindow (agent-loop send guard)', () => {
  const msg = (role: 'system' | 'user' | 'assistant' | 'tool', tokens: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    role,
    content: 'x'.repeat(tokens * 4),
    ...extra,
  });
  const estAll = (ms: ChatMessage[]): number =>
    ms.reduce((s, m) => s + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0);

  it('already-fitting arrays pass through untouched (idempotent)', () => {
    const ms = [msg('system', 10), msg('user', 20), msg('assistant', 15)];
    const r = fitMessagesToWindow(ms, 1000);
    expect(r.folded).toBe(0);
    expect(r.messages).toBe(ms); // same reference — zero copy when nothing to do
  });

  it('folds oldest groups, keeps system + pinned user request + newest groups; note carries FOLD_PREFIX + count', () => {
    const tool = msg('tool', 300, { toolCallId: 'c1', name: 'read_file' });
    const asst = msg('assistant', 5, { toolCalls: [{ id: 'c1', name: 'read_file', args: {} }] });
    const ms = [msg('system', 20), msg('user', 100), asst, tool, msg('assistant', 400)];
    const r = fitMessagesToWindow(ms, 500); // 837 tokens total -> must fold the middle group
    expect(r.folded).toBe(2);
    expect(r.messages[0]!.role).toBe('system');
    const note = r.messages.find((m) => typeof m.content === 'string' && m.content.startsWith(FOLD_PREFIX));
    expect(note, 'fold note present').toBeDefined();
    expect(
      r.messages.some((m) => m === ms[1]),
      'the current user request must stay PINNED',
    ).toBe(true);
    expect(r.messages.at(-1)).toBe(ms[4]); // newest group survives
  });

  it('assistant-with-toolCalls and its tool results are atomic — never split', () => {
    const mk = (id: string): ChatMessage[] => [
      msg('assistant', 400, { toolCalls: [{ id, name: 'read_file', args: {} }] }),
      msg('tool', 400, { toolCallId: id, name: 'read_file' }),
    ];
    const ms = [msg('system', 10), ...mk('g1'), ...mk('g2'), ...mk('g3')];
    const r = fitMessagesToWindow(ms, 900); // only one ~812-token group + overhead fits
    const kept = r.messages.filter((m) => m.role !== 'system' && !(typeof m.content === 'string' && m.content.startsWith(FOLD_PREFIX)));
    for (const a of kept.filter((m) => m.toolCalls?.length)) {
      const i = kept.indexOf(a);
      for (const call of a.toolCalls!) {
        expect(kept[i + 1]?.toolCallId, 'tool result must immediately follow its call').toBe(call.id);
      }
    }
    expect(r.folded).toBe(4); // two full groups dropped — no dangling toolCallId
    expect(kept.length).toBe(2);
  });

  it('a single oversized newest group is still kept (never dropped), foldable middles fold around it', () => {
    const ms = [msg('system', 10), msg('user', 10), msg('assistant', 200), msg('tool', 200, { toolCallId: 'x' }), msg('assistant', 5000)];
    const r = fitMessagesToWindow(ms, 1000);
    expect(r.messages.at(-1)).toBe(ms[4]); // oversized last group survives — it is what the model must act on
    expect(r.folded).toBe(2);
    expect(r.messages.some((m) => m === ms[1])).toBe(true); // pinned request survives
  });

  it('global invariant: fitted total <= cap unless a single pinned/last group is oversized', () => {
    for (const [cap, n] of [
      [2000, 6],
      [800, 10],
      [4000, 4],
    ]) {
      const ms: ChatMessage[] = [msg('system', 30), msg('user', 120)];
      for (let i = 0; i < n; i++)
        ms.push(msg('assistant', 200, { toolCalls: [{ id: `c${i}`, name: 't', args: {} }] }), msg('tool', 250, { toolCallId: `c${i}` }));
      const r = fitMessagesToWindow(ms, cap);
      const groups = r.messages.filter((m) => m.toolCalls?.length).length;
      const biggestGroup = Math.max(0, ...r.messages.map((m) => estAll([m])));
      expect(estAll(r.messages), `cap ${cap}`).toBeLessThanOrEqual(cap + biggestGroup); // slack only for a forced oversized group
      expect(groups).toBeLessThanOrEqual(n);
    }
  });
});
