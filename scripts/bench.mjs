#!/usr/bin/env node
/**
 * CLI for the §14/§56 perf bench (src/main/diagnostics/bench.ts). The bench
 * lives in TS so it is type-checked with the app; this runner bundles it with
 * the project's own esbuild and executes it on plain Node (headless core,
 * no Electron).
 *
 *   npm run bench                  # live config: your providers, your DB
 *   npm run bench -- --demo        # mock core, validates the harness itself
 *   npm run bench -- --turns=5 --prompt="Summarize this repo in one line"
 *
 * Live reports are written next to the logs (…/lpai/bench/report-*.md).
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'main', 'diagnostics', 'bench.ts');
const OUT = join(ROOT, 'dist', 'bench', 'bench.mjs');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};

async function ensureBundle() {
  if (existsSync(OUT) && statSync(OUT).mtimeMs >= statSync(SRC).mtimeMs) return;
  const { build } = await import('esbuild');
  await build({
    entryPoints: [SRC],
    outfile: OUT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['better-sqlite3'],
    logLevel: 'warning',
    define: { 'import.meta.dirname': '""' },
  });
  console.log('[bench] bundled diagnostics bench');
}

await ensureBundle();
const { runPerfBench } = await import(`file://${OUT.replace(/\\/g, '/')}`);
const started = Date.now();
const report = await runPerfBench({
  demo: flag('demo'),
  turns: Number.parseInt(opt('turns', '3'), 10) || 3,
  prompt: opt('prompt', undefined),
});
console.log(`\n${report.markdown}`);
console.log(`\nwall time: ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (report.reportFile) console.log(`report saved: ${report.reportFile}`);
const failed = report.rows.filter((r) => r.detail.startsWith('FAILED')).length;
if (failed > 0) {
  console.log(`note: ${String(failed)} measurement(s) reported FAILED — see details above`);
}
