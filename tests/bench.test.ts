/**
 * The §14 measurement harness must itself be regression-covered: run it
 * against the temp demo core and assert every measurement slot produced a
 * result (ok or honest n/a) — no FAILED lines, no crashes, report well-formed.
 * (Live runs on real providers are inherently machine-specific; that's the
 * point of `npm run bench` on the target box.)
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPerfBench } from '../src/main/diagnostics/bench.js';

describe('perf bench harness', () => {
  it('demo run: all measurements complete without failures, report written to memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpai-benchtest-'));
    try {
      const report = await runPerfBench({ demo: true, turns: 2, dataDir: dir });
      const names = report.rows.map((r) => r.name);
      expect(names).toContain('provider health: mock');
      expect(names).toContain('chat.send E2E (turn incl. context+router)');
      expect(names).toContain('idle unload (§56)');
      expect(names).toContain('sqlite insert x2000 (WAL, one tx)');
      expect(names).toContain('resource snapshot');
      // every measurement resolved — the harness must not report failures on the demo core
      const failed = report.rows.filter((r) => r.detail.startsWith('FAILED'));
      expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
      expect(report.markdown).toContain('| measurement | ms | detail |');
      expect(report.markdown).toContain('DEMO/mock core');
      // a real (non-ephemeral) dataDir gets the saved report next to the logs
      expect(report.reportFile).toBeDefined();
      expect(existsSync(String(report.reportFile))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
