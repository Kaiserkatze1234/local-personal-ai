#!/usr/bin/env node
/**
 * Standalone failure analysis for a finished report.
 *
 *   npm run analyze:failure                        # reads test-reports/latest.json
 *   npm run analyze:failure -- --no-ai             # deterministic rules only
 *   npm run analyze:failure -- --report=x.json --out=test-reports
 *
 * Normally the orchestrator calls this logic inline (only when a stage failed);
 * this CLI exists for re-running the analysis on an old report — e.g. after
 * installing a model — without repeating the test run.
 *
 * Writes: <out>/latest-analysis.json and, when the report is not PASS, regenerates
 * the handoff files with the analysis folded in: latest-chatgpt.json/.md (digest
 * for the analyzing instance), latest-arena-task.md (repair order) and
 * latest-fix-prompt.md (compatibility). On PASS those files are removed, so a
 * stale order can never be mistaken for the current state.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAiDigest, renderAiDigestMarkdown, renderArenaTask, renderFixPrompt } from './autonomous/report.mjs';
import { ensureBundle } from './lib/ensure-bundle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const a = argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};

const outDir = join(ROOT, opt('out', 'test-reports'));
const reportPath = join(ROOT, opt('report', join('test-reports', 'latest.json')));
const useAi = !flag('no-ai');
const dataDir = process.env.LPAI_ANALYSIS_DATA_DIR ?? undefined;

if (!existsSync(reportPath)) {
  console.error(`[analyze] kein Report unter ${reportPath} — zuerst "npm run test:autonomous" ausführen.`);
  process.exit(3);
}

const out = await ensureBundle({
  entry: join(ROOT, 'src', 'main', 'diagnostics', 'failureAnalysis.ts'),
  out: join(ROOT, 'dist', 'autonomy', 'failureAnalysis.mjs'),
});
const { analyzeFailure } = await import(`file://${out.replace(/\\/g, '/')}`);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));

const result = await analyzeFailure({
  reportPath,
  dataDir,
  useAi,
  baselineFailures: [],
  aiTimeoutMs: 150_000,
  maxPromptChars: 6000,
});

writeFileSync(join(outDir, 'latest-analysis.json'), JSON.stringify(result, null, 2));
// keep the two handoff files in step with the fresh analysis
const digest = buildAiDigest(report, { analysis: result, baselineFailures: report.guards?.baselineFailures ?? [] });
writeFileSync(join(outDir, 'latest-chatgpt.json'), JSON.stringify(digest, null, 2));
writeFileSync(join(outDir, 'latest-chatgpt.md'), renderAiDigestMarkdown(digest));
if (report.verdict !== 'PASS') {
  const args = { analysis: result };
  writeFileSync(join(outDir, 'latest-arena-task.md'), renderArenaTask(report, args));
  writeFileSync(join(outDir, 'latest-fix-prompt.md'), renderFixPrompt(report, args));
} else {
  rmSync(join(outDir, 'latest-arena-task.md'), { force: true });
  rmSync(join(outDir, 'latest-fix-prompt.md'), { force: true });
}

console.log(`\nKategorie: ${result.final.category} (Konfidenz ${result.final.confidence}, Quelle: ${result.final.source})`);
console.log(`Ursache:   ${result.final.probableCause}`);
console.log(`Komponente:${result.final.component}${result.final.file ? ` (${result.final.file})` : ''}`);
console.log(`Korrektur: ${result.final.recommendedFix}`);
if (result.ai) console.log(`Modell:    ${result.ai.modelId} (Rolle review)`);
else if (result.aiError) console.log(`Hinweis:   lokale KI nicht verfügbar — ${result.aiError}`);
else if (result.aiSkipReason) console.log(`Hinweis:   KI nicht nötig — ${result.aiSkipReason}`);
console.log(
  `\nGeschrieben: ${join(outDir, 'latest-analysis.json')}, ${join(outDir, 'latest-chatgpt.json')}` +
    (report.verdict === 'PASS'
      ? ' (PASS: kein Reparaturauftrag)'
      : `, ${join(outDir, 'latest-arena-task.md')}, ${join(outDir, 'latest-fix-prompt.md')}`),
);
if (flag('json')) console.log(JSON.stringify(result, null, 2));
