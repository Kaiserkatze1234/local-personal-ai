/**
 * Agent end-to-end against the real core with a scripted mock runtime:
 * multi-step task -> permission -> tool execution -> checkpoint ->
 * verification -> persisted summary (spec §8/§9/§38/§72 integration level).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/shared/util/text.js';
import { makeTestApp } from './helpers.js';

describe('agent core', () => {
  it('runs a scripted multi-step task: write file via tool call, verify, complete', async () => {
    const t = await makeTestApp({
      writeScope: true,
      config: { tools: { permissionMode: 'ADVANCED' } }, // no dialog interference for this test
      turns: [
        {
          text: 'I will create the notes file.',
          toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'notes.txt', content: 'hello from agent' } }],
        },
        { text: 'Created notes.txt with the requested content.' },
      ],
    });
    try {
      const outcome = await t.app.agent.run({ userText: 'create a notes file with hello from agent', mode: 'AGENT' });
      expect(existsSync(join(t.dir, 'notes.txt'))).toBe(true);
      expect(readFileSync(join(t.dir, 'notes.txt'), 'utf8')).toContain('hello from agent');
      const task = t.app.tasks.get(outcome.taskId);
      expect(task?.status).toBe('completed');
      expect(task?.toolsUsed).toContain('write_file');
      expect(task?.verification?.attempted).toBe(true);
      expect(task?.verification?.passed).toBe(true); // file_written check ran
      expect(task?.modelSelections.length).toBeGreaterThan(0);
      // request went through the mock provider exactly (no hard-coded model)
      expect(t.mock.requests.length).toBeGreaterThanOrEqual(2);
    } finally {
      await t.cleanup();
    }
  });

  it('checkpoints before a patch on an existing file, and restore works (§37)', async () => {
    const t = await makeTestApp({
      writeScope: true,
      config: { tools: { permissionMode: 'ADVANCED' } },
      turns: [
        {
          text: 'patching',
          toolCalls: [{ id: 'c1', name: 'patch_file', args: { path: 'cfg.json', ops: [{ find: 'old', replace: 'new' }] } }],
        },
        { text: 'done' },
      ],
    });
    try {
      writeFileSync(join(t.dir, 'cfg.json'), '{"v":"old"}');
      const out = await t.app.agent.run({ userText: 'change old to new in cfg.json', mode: 'AGENT' });
      expect(readFileSync(join(t.dir, 'cfg.json'), 'utf8')).toContain('new');
      const task = t.app.tasks.get(out.taskId);
      expect(task?.checkpointIds.length).toBe(1);
      const restored = await t.app.checkpoints.restore(task!.checkpointIds[0]!);
      expect(restored.ok).toBe(true);
      expect(readFileSync(join(t.dir, 'cfg.json'), 'utf8')).toContain('old'); // rollback verified
    } finally {
      await t.cleanup();
    }
  });

  it('stops for permission in BALANCED mode and proceeds after allow (§11 flow)', async () => {
    const t = await makeTestApp({
      writeScope: true,
      turns: [{ text: 'writing', toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'p.txt', content: 'x' } }] }, { text: 'ok' }],
    });
    try {
      const run = t.app.agent.run({ userText: 'write p.txt with x', mode: 'AGENT' });
      let requestId = '';
      t.app.bus.on('permission.requested', (e) => {
        requestId = e.request.id;
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(requestId).not.toBe('');
      t.app.permissions.decide(requestId, 'allow_session');
      const out = await run;
      expect(out.task.status).toBe('completed');
      expect(existsSync(join(t.dir, 'p.txt'))).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it('cancellation aborts a waiting task and marks it cancelled (§9)', async () => {
    const t = await makeTestApp({
      writeScope: true,
      turns: [{ text: 'w', toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'z.txt', content: 'z' } }] }],
    });
    try {
      const run = t.app.agent.run({ userText: 'write z.txt', mode: 'AGENT' });
      await new Promise((r) => setTimeout(r, 30));
      const pending = t.app.permissions.state().pending[0];
      expect(pending).toBeTruthy();
      const cancelled = t.app.tasks.cancel(pending!.taskId!);
      expect(cancelled).toBe(true);
      await expect(run).rejects.toThrow(/cancelled/i);
      expect(t.app.tasks.list(['cancelled']).length).toBe(1);
      expect(existsSync(join(t.dir, 'z.txt'))).toBe(false); // never executed
    } finally {
      await t.cleanup();
    }
  });

  it('bounded retries: provider failure ends as a failed task with error recorded (§15/§39)', async () => {
    const t = await makeTestApp({ config: { tools: { permissionMode: 'ADVANCED' } } });
    try {
      t.mock.healthState = 'ERROR';
      t.mock.chat = {
        generate: async () => {
          throw new Error('model exploded');
        },
        stream: () => (async function* () {})(),
      };
      await t.app.providers.refreshProvider('mock');
      const out = await t.app.agent.run({ userText: 'do a thing', mode: 'AGENT' });
      expect(out.task.status).toBe('failed');
      expect(out.task.errors.length).toBeGreaterThan(0);
      expect(out.finalText).toContain('could not complete');
    } finally {
      await t.cleanup();
    }
  });
});

describe('agent loop window guard (fourteenth pass)', () => {
  it('folds older tool rounds instead of silently overflowing the requested num_ctx', async () => {
    const t = await makeTestApp({
      writeScope: true,
      config: { tools: { permissionMode: 'ADVANCED' }, ai: { runtimeContextTokens: 2048 } },
      turns: [
        { text: 'reading part 1', toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'big.txt' } }] },
        { text: 'reading part 2', toolCalls: [{ id: 'r2', name: 'read_file', args: { path: 'big.txt' } }] },
        { text: 'done' },
      ],
    });
    try {
      writeFileSync(join(t.dir, 'big.txt'), 'lorem ipsum dolor '.repeat(300)); // ~5.4 KB -> ~1.4k tokens per tool result
      const run = await t.app.agent.run({ userText: 'read big.txt twice and tell me when done', mode: 'task', images: [] } as never);
      expect(run.finalText).toContain('done');
      const reqs = t.mock.requests.filter((r) => Array.isArray(r.messages) && r.messages.length > 0);
      expect(reqs.length).toBeGreaterThanOrEqual(3);
      const last = reqs.at(-1)!.messages!;
      expect(last[0]!.role).toBe('system'); // system instructions must survive every round
      const est = last.reduce((s, m) => s + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0);
      expect(est, `fitted prompt ${est} must be near the 1536-token cap, not the raw loop growth`).toBeLessThanOrEqual(1536 + 1400); // slack = one forced oversized newest group at most
      expect(
        last.some((m) => typeof m.content === 'string' && m.content.startsWith('[Earlier conversation folded')),
        'fold note must be present',
      ).toBe(true);
      expect(last.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('read big.txt twice'))).toBe(true); // the request itself is pinned
      // and without folding the array would have been much bigger — proof the guard actually fired
      expect(last.length).toBeLessThan(9);
    } finally {
      await t.cleanup();
    }
  });
});
