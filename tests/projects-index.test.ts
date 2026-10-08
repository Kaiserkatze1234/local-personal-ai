/** Project understanding + indexing + checkpoints + prompt assistant. */

import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

async function makeSampleProject(root: string): Promise<string> {
  const dir = join(root, 'sample-app');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'sample-app',
      scripts: { test: 'node --test', build: 'echo build' },
      dependencies: { react: '^19.0.0', express: '^5.0.0' },
    }),
  );
  writeFileSync(join(dir, 'index.html'), '<html>hi</html>');
  writeFileSync(join(dir, 'src', 'main.ts'), 'export function appBoot() { return 1; }\n');
  writeFileSync(join(dir, 'src', 'router.ts'), 'import express from "express";\nexport const r = express(); // handles /build route\n');
  writeFileSync(join(dir, 'src', 'main.test.ts'), 'test("boot", () => {});\n');
  writeFileSync(join(dir, 'README.md'), '# sample app\nEntry is src/main.ts\n');
  writeFileSync(join(dir, 'huge.bin'), 'x'.repeat(2 * 1024 * 1024)); // must be skipped by size cap
  return dir;
}

describe('project indexer (§13)', () => {
  it('detects kind/frameworks/scripts and indexes incrementally', async () => {
    const t = await makeTestApp();
    try {
      const dir = await makeSampleProject(t.dir);
      const info = await t.app.projects.addProject(dir);
      expect(info.kind).toBe('node');
      expect(info.frameworks).toEqual(expect.arrayContaining(['react', 'express']));
      expect(info.testCommands.join(' ')).toContain('npm test');
      expect(info.fileCount).toBeGreaterThanOrEqual(6);
      expect(info.fileCount).toBeLessThan(20); // huge.bin skipped
      const brief = t.app.projects.projectBrief(info.id);
      expect(brief?.overview).toContain('sample-app');
      expect(brief?.overview).toContain('verification commands');

      // incremental: second pass finds nothing changed (§13)
      const second = await t.app.projects.indexProject(info.id, false);
      expect(second.indexed).toBe(0);

      // touch one file -> only that file reindexed
      const now = new Date(Date.now() + 5000);
      utimesSync(join(dir, 'src', 'main.ts'), now, now);
      const third = await t.app.projects.indexProject(info.id, false);
      expect(third.indexed).toBe(1);
    } finally {
      await t.cleanup();
    }
  });

  it('ranks relevant files for a coding query (retrieve, not dump)', async () => {
    const t = await makeTestApp();
    try {
      const dir = await makeSampleProject(t.dir);
      const info = await t.app.projects.addProject(dir);
      const ranked = await t.app.projects.relevantFiles(info.id, 'express router build route', 3);
      expect(ranked.length).toBeGreaterThan(0);
      expect(ranked[0]?.rel).toContain('router');
    } finally {
      await t.cleanup();
    }
  });
});

describe('checkpoints (§37)', () => {
  it('snapshot -> modify -> restore -> content is back', async () => {
    const t = await makeTestApp();
    try {
      const f = join(t.dir, 'important.txt');
      writeFileSync(f, 'original contents');
      const ck = await t.app.checkpoints.createForFiles('before big change', [f]);
      expect(ck?.fileCount).toBe(1);
      writeFileSync(f, 'destroyed');
      const r = await t.app.checkpoints.restore(ck!.id);
      expect(r.ok).toBe(true);
      expect(readFileSync(f, 'utf8')).toBe('original contents');
      const status = t.app.checkpoints.status(ck!.id);
      expect(status?.intact).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });
});

describe('prompt assistant (§20)', () => {
  it('finds missing target and vague speed hints without touching a model', async () => {
    const t = await makeTestApp();
    try {
      const sugs = t.app.promptAssistant.analyze('p1', 'make my app faster', undefined, true);
      expect(sugs.length).toBeGreaterThanOrEqual(1);
      expect(sugs.some((s) => s.kind === 'add_detail')).toBe(true);
      // no model call happened:
      expect(t.mock.requests).toHaveLength(0);
      // disable switch honored (§20 "user should be able to disable")
      t.app.config.patch({ promptAssistant: { enabled: false } });
      expect(t.app.promptAssistant.analyze('p2', 'make my app faster', undefined, true)).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });
});

describe('task recovery (§51)', () => {
  it('interrupted tasks come back as paused with rerun/discard support', async () => {
    const t = await makeTestApp();
    try {
      const task = t.app.tasks.create({ title: 'unfinished', userRequest: 'do the thing', taskClass: 'file_ops' });
      t.app.tasks.transition(task.id, 'executing');
      const recovered = t.app.tasks.markInterruptedOnBoot();
      expect(recovered.map((r) => r.id)).toContain(task.id);
      expect(t.app.tasks.get(task.id)?.status).toBe('paused');
      // transition to cancelled is legal from paused
      t.app.tasks.transition(task.id, 'cancelled', { summary: 'discarded' });
      expect(t.app.tasks.get(task.id)?.status).toBe('cancelled');
    } finally {
      await t.cleanup();
    }
  });
});

describe('verification engine (§38)', () => {
  it('reports "not possible" honestly instead of fake success', async () => {
    const t = await makeTestApp();
    try {
      t.app.config.flush();
      const v = await t.app.verification.verify({ kind: 'code_change', cwd: t.dir, commands: [] });
      expect(v.attempted).toBe(false);
      expect(v.passed).toBe(false);
      expect(v.details).toContain('not possible');
      const good = await t.app.verification.verify({ kind: 'config_valid', path: join(t.dir, 'config.json'), format: 'json' });
      expect(good.passed).toBe(true);
    } finally {
      await t.cleanup();
    }
  });
});
