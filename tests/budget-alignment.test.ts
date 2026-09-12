/**
 * Budget/wire alignment: the context engine must fit prompts to the window the
 * adapter actually sends as num_ctx (shared/util/limits is the single policy) —
 * otherwise Ollama silently prunes the difference and the §63 transparency
 * panel describes tokens the model never sees. Real-Windows bug class:
 * budget 8192 vs num_ctx 4096.
 */
import { describe, expect, it } from 'vitest';
import { clampRuntimeContext, effectivePromptBudget, hardwareContextCeiling, MIN_NUM_CTX } from '../src/shared/util/limits.js';
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
