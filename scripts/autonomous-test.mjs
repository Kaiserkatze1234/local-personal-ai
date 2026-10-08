#!/usr/bin/env node
/**
 * Autonomous test orchestrator — the single entry point the loop uses.
 *
 *   npm run test:autonomous              # full pipeline (what the runner executes)
 *   npm run test:autonomous -- --quick   # skip the three expensive stages
 *                                        # (smoke, E2E, Ollama)
 *   npm run test:autonomous -- --ci      # strict prerequisites (missing declared
 *                                        # devDependencies = INFRASTRUCTURE_ERROR,
 *                                        # never a silent SKIP)
 *   npm run test:autonomous -- --list    # print the stages and exit
 *
 * Stages, in order (each one is recorded with status, exit code, duration and
 * trimmed error lines — never a raw log dump):
 *
 *   prereqs  · node/npm/OS, node_modules, disk, Electron dist, Playwright,
 *              Ollama reachability (informational)
 *   native   · Electron-ABI SQLite binding via the project's own
 *              scripts/rebuild-native.mjs (cached; fails loudly with remediation)
 *   typecheck· tsc node + web
 *   build    · scripts/build.mjs + vite build
 *   unit / integration · ONE vitest run, viewed through two file sets
 *   smoke    · LPAI_SMOKE=1 in a THROWAWAY data dir (SMOKE_OK + screenshot)
 *   e2e      · Playwright driving the real Electron app
 *   ollama   · tests/ollama-live.test.ts against the real local server
 *
 * "unit" and "integration" deliberately come from ONE vitest run: the suite
 * boots the real CoreApp in its integration files, and running it twice to fill
 * a second box would double the wall time on a 16 GB laptop for no information.
 * The split is by file (files that boot the real core = integration).
 *
 * Verdicts: PASS / FAIL / SKIP / INFRASTRUCTURE_ERROR. A missing optional
 * precondition (no Ollama, Playwright not installed, E2E switched off) is SKIP
 * and never silently green: `--require-ollama` turns it into FAIL, and a missing
 * Electron binary is INFRASTRUCTURE_ERROR, not a skipped test.
 *
 * Outputs in test-reports/: latest.json, latest.md, timestamped copies,
 * latest-chatgpt.json/.md (digest for the analyzing instance — always),
 * latest-arena-task.md + latest-fix-prompt.md (on failure only, deleted on
 * PASS so no stale order can survive), latest-analysis.json, cycle-state.json.
 */

import { execSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { cpus, hostname, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGuards, explainStop, guardsForReport, normalizeState } from './autonomous/guards.mjs';
import {
  buildAiDigest,
  buildReport,
  extractErrorLines,
  fingerprintOf,
  makeStage,
  renderAiDigestMarkdown,
  renderArenaTask,
  renderComment,
  renderFixPrompt,
  renderMarkdown,
} from './autonomous/report.mjs';
import { ensureBundle } from './lib/ensure-bundle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};

const CFG = {
  ci: flag('ci') || process.env.CI === 'true',
  quick: flag('quick'),
  // --quick = the fast developer loop: every stage that needs Electron or a
  // local model is off. Never silently green — the stages report SKIP.
  noE2e: flag('no-e2e') || flag('quick'),
  noSmoke: flag('no-smoke') || flag('quick'),
  noOllama: flag('no-ollama') || flag('quick'),
  requireOllama: flag('require-ollama'),
  noAnalyze: flag('no-analyze'),
  noAiAnalysis: flag('no-ai-analysis'),
  maxAttempts: Number.parseInt(opt('max-attempts', process.env.LPAI_MAX_FIX_ATTEMPTS ?? '3'), 10) || 3,
  outDir: join(ROOT, opt('out', 'test-reports')),
  stateFile: join(ROOT, opt('state', join('test-reports', 'cycle-state.json'))),
  timeoutScale: Number.parseFloat(opt('timeout-scale', '1')) || 1,
  json: flag('json'),
};

if (flag('list')) {
  for (const s of ['prereqs', 'native', 'typecheck', 'build', 'unit', 'integration', 'smoke', 'e2e', 'ollama']) console.log(s);
  process.exit(0);
}

const stages = [];
const START = Date.now();
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- utilities

function stage(name, extra = {}) {
  const s = makeStage(name, extra);
  stages.push(s);
  return s;
}

function run(command, { cwd = ROOT, env = {}, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, ...env, FORCE_COLOR: process.env.FORCE_COLOR ?? '0' },
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let output = '';
    const cap = 400_000; // keep the tail; the report only uses trimmed lines anyway
    const push = (buf) => {
      output += String(buf);
      if (output.length > cap) output = output.slice(output.length - cap);
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output, timedOut, durationMs: Date.now() - t0 });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, output: `${output}\n${String(err)}`, timedOut: false, durationMs: Date.now() - t0 });
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * A leftover Electron holds the single-instance lock (`app.requestSingleInstanceLock`
 * uses the userData path, not our temp data dir), so every Electron stage starts
 * from a clean slate. Only OUR dev binary is matched — never a foreign app that
 * happens to be called electron.exe.
 */
async function killStaleElectron() {
  if (process.platform !== 'win32') return; // Playwright reaps its own children elsewhere
  await run(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='electron.exe'\\" | Where-Object { $_.ExecutablePath -like '*node_modules*electron*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
    { timeoutMs: 30_000 },
  );
}

function markStage(s, result, { infra = [] } = {}) {
  s.exitCode = result.code;
  s.durationMs = result.durationMs;
  const out = result.output ?? '';
  s.errors = extractErrorLines(out);
  if (result.timedOut) {
    s.status = 'FAIL';
    s.note = `timeout nach ${Math.round(result.durationMs / 1000)}s`;
  } else if (result.code === 0) {
    s.status = 'PASS';
  } else if (infra.some((re) => re.test(out))) {
    s.status = 'INFRASTRUCTURE_ERROR';
    s.note = s.note ?? 'Umgebungs-/Werkzeugvoraussetzung verletzt — kein Codefehler';
  } else {
    s.status = 'FAIL';
  }
  return s;
}

function defaultAppDataDir() {
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming'), 'lpai');
  if (platform() === 'darwin') return join(process.env.HOME ?? '.', 'Library', 'Application Support', 'lpai');
  return join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '.', '.config'), 'lpai');
}

function gitOut(args) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Ollama detection — the app's own default endpoint, overridable like everywhere else. */
async function detectOllama() {
  const baseUrl = (process.env.LPAI_OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const info = { reachable: false, baseUrl, version: null, models: undefined, chatCapable: [], embeddingCapable: [], note: null };
  try {
    const tags = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!tags.ok) {
      info.note = `HTTP ${tags.status} von ${baseUrl}`;
      return info;
    }
    const j = await tags.json();
    info.reachable = true;
    const names = (j.models ?? []).map((m) => m.name).filter(Boolean);
    info.models = names.length;
    const isEmbed = (n) => /(embed|bge[-_]|jina|e5[-_]|gte[-_]|snowflake-arctic|bert)/i.test(n);
    info.chatCapable = names.filter((n) => !isEmbed(n));
    info.embeddingCapable = names.filter(isEmbed);
    try {
      const v = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(4000) });
      if (v.ok) info.version = (await v.json()).version ?? null;
    } catch {
      /* version is informational */
    }
  } catch (err) {
    info.note = (err instanceof Error ? err.message : String(err)).slice(0, 160);
  }
  return info;
}

// ---------------------------------------------------------------- stages

async function stagePrereqs() {
  const s = stage('prereqs', { command: 'Umgebungsprüfungen' });
  const t0 = Date.now();
  const problems = [];
  const notes = [];
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 22)
    problems.push(`Node ${process.versions.node} ist älter als 22 (package.json engines) — npm ci / rebuild:native brauchen 22+`);
  if (!existsSync(join(ROOT, 'node_modules'))) problems.push('node_modules fehlt — `npm ci` ausführen');

  const probe = await run(
    `node -e "const D=require('better-sqlite3');const d=new D(':memory:');d.prepare('select 1 as x').get();console.log('sqlite-node-abi-ok')"`,
    { timeoutMs: 60_000 },
  );
  if (probe.code !== 0) problems.push('better-sqlite3 (Node-ABI) lädt nicht — `npm run rebuild:native` ausführen');

  const electronPathFile = join(ROOT, 'node_modules', 'electron', 'path.txt');
  const electronBin = existsSync(electronPathFile)
    ? join(ROOT, 'node_modules', 'electron', 'dist', readFileSync(electronPathFile, 'utf8').trim())
    : null;
  const electronOk = Boolean(electronBin && existsSync(electronBin));
  if (!electronOk) notes.push('Electron-Dist fehlt — Smoke/E2E werden als INFRASTRUCTURE_ERROR gemeldet (kein Skip)');

  const playwrightOk = existsSync(join(ROOT, 'node_modules', '@playwright', 'test'));
  if (!playwrightOk) {
    // locally a missing devDependency is a choice (E2E is then SKIP); in CI it
    // means `npm ci` did not deliver what package.json declares -> environment bug
    if (CFG.ci) problems.push('@playwright/test fehlt, obwohl package.json es deklariert — `npm ci` prüfen');
    else notes.push('@playwright/test nicht installiert — E2E wird als SKIP gemeldet');
  }

  let freeGb = null;
  try {
    const st = statfsSync(ROOT);
    freeGb = Math.round((Number(st.bavail) * Number(st.bsize)) / 1024 ** 3);
    if (freeGb < 3) problems.push(`nur ${freeGb} GB frei — Build + Tests brauchen Platz`);
  } catch {
    /* statfs is best-effort */
  }

  s.durationMs = Date.now() - t0;
  s.exitCode = problems.length === 0 ? 0 : 1;
  s.status = problems.length === 0 ? 'PASS' : 'INFRASTRUCTURE_ERROR';
  s.errors = problems;
  s.note = [notes.join('; '), `${cpus().length} Kerne, ${Math.round(totalmem() / 1024 ** 3)} GB RAM, ${freeGb ?? '?'} GB frei`]
    .filter(Boolean)
    .join(' · ');
  s.facts = { electronOk, playwrightOk, freeGb, nodeMajor };
  return s;
}

async function stageSimple(name, command, opts = {}) {
  const s = stage(name, { command });
  const result = await run(command, { timeoutMs: (opts.timeoutMs ?? 600_000) * CFG.timeoutScale, env: opts.env });
  markStage(s, result, { infra: opts.infra });
  return s;
}

async function stageNative() {
  const s = await stageSimple('native', 'node scripts/rebuild-native.mjs --quiet', {
    timeoutMs: 900_000,
    infra: [/FAILED/, /NODE_MODULE_VERSION/],
  });
  if (s.status === 'PASS') s.note = 'Electron-ABI-Binding vorhanden (native/electron/<triple>)';
  return s;
}

/** One vitest run, two views. */
async function stageTests() {
  const unitStage = stage('unit', { command: 'npx vitest run — Einheitstests (Dateien ohne CoreApp-Boot)' });
  const intStage = stage('integration', { command: 'dieselbe vitest-Ausführung — Integrationsdateien (booten die echte CoreApp)' });
  const jsonFile = join(tmpdir(), `lpai-vitest-${Date.now()}.json`);
  const result = await run(`npx vitest run --reporter=default --reporter=json --outputFile="${jsonFile}"`, {
    timeoutMs: 1_800_000 * CFG.timeoutScale,
  });
  const errors = extractErrorLines(result.output);

  let perFile = [];
  try {
    const parsed = JSON.parse(readFileSync(jsonFile, 'utf8'));
    perFile = (parsed.testResults ?? []).map((f) => ({
      name: String(f.name ?? '').replace(/\\/g, '/'),
      status: f.status,
      assertions: f.assertionResults ?? [],
    }));
  } catch {
    /* no json report: exit code is authoritative */
  } finally {
    try {
      rmSync(jsonFile, { force: true });
    } catch {
      /* ignore */
    }
  }

  // vitest reports ABSOLUTE file names; join() would double the prefix and the
  // read would fail silently, which is exactly how this split once reported
  // "no files in this view" while 13 integration files were sitting right there.
  const isIntegration = (file) => {
    try {
      const abs = isAbsolute(file.name) ? file.name : join(ROOT, file.name);
      const src = readFileSync(abs, 'utf8');
      return /from '\.\/helpers|from '\.\/e2e\/|\.integration\.test|makeTestApp|new CoreApp\(/.test(src);
    } catch {
      return false;
    }
  };

  const crashed = result.code !== 0 && perFile.length === 0;
  for (const [target, predicate] of [
    [unitStage, (f) => !isIntegration(f)],
    [intStage, (f) => isIntegration(f)],
  ]) {
    const files = perFile.filter(predicate);
    const assertions = files.flatMap((f) => f.assertions);
    const failed = files.filter((f) => f.status === 'failed');
    const counts = {
      files: files.length,
      passed: assertions.filter((a) => a.status === 'passed').length,
      failed: assertions.filter((a) => a.status === 'failed').length,
      skipped: assertions.filter((a) => a.status === 'skipped' || a.status === 'pending').length,
    };
    target.durationMs = result.durationMs;
    target.exitCode = result.code;
    target.counts = counts;
    target.failedTests = failed
      .flatMap((f) => f.assertions.filter((a) => a.status === 'failed').map((a) => String(a.fullName ?? a.title ?? '?')))
      .slice(0, 50);
    target.skippedTests = files
      .flatMap((f) =>
        f.assertions.filter((a) => a.status === 'skipped' || a.status === 'pending').map((a) => String(a.fullName ?? a.title ?? '?')),
      )
      .slice(0, 50);
    if (crashed) {
      target.status = /Cannot find|ERR_MODULE_NOT_FOUND|NODE_MODULE_VERSION/.test(result.output) ? 'INFRASTRUCTURE_ERROR' : 'FAIL';
      target.errors = errors;
      target.note = 'vitest konnte nicht ausgeführt werden bzw. lieferte keinen Report';
    } else if (failed.length > 0) {
      target.status = 'FAIL';
      target.errors = errors;
      target.note = `${failed.length} Datei(en) rot: ${failed
        .map((f) => relative(ROOT, f.name))
        .slice(0, 4)
        .join(', ')}`;
    } else if (files.length === 0) {
      target.status = 'SKIP';
      target.note = 'keine Dateien in dieser Sicht';
    } else {
      target.status = 'PASS';
      target.note = `${counts.files} Dateien · ${counts.passed} passed / ${counts.failed} failed / ${counts.skipped} skipped`;
    }
  }
  return { unitStage, intStage };
}

async function stageSmoke(prereqs) {
  const s = stage('smoke', { command: 'LPAI_SMOKE=1 electron . (eigener temp-Datenordner)' });
  if (CFG.noSmoke) {
    s.status = 'SKIP';
    s.note = 'durch --quick/--no-smoke deaktiviert';
    return s;
  }
  if (!prereqs.facts?.electronOk) {
    s.status = 'INFRASTRUCTURE_ERROR';
    s.note = 'Electron-Dist fehlt — die App kann hier nicht gestartet werden';
    s.errors = ['node_modules/electron/dist fehlt (npm ci unvollständig oder electron-Postinstall blockiert)'];
    return s;
  }
  await killStaleElectron();
  const dataDir = mkdtempSync(join(tmpdir(), 'lpai-smoke-'));
  try {
    const result = await run('npx electron .', {
      timeoutMs: 300_000 * CFG.timeoutScale,
      env: { LPAI_SMOKE: '1', LPAI_DATA_DIR: dataDir },
    });
    markStage(s, result, { infra: [/NODE_MODULE_VERSION/, /Cannot find module/] });
    const resultFile = join(dataDir, 'smoke-result.txt');
    const text = existsSync(resultFile) ? readFileSync(resultFile, 'utf8').trim() : '';
    const shot = join(dataDir, 'smoke-window.png');
    if (existsSync(shot)) {
      const dest = join(CFG.outDir, 'artifacts', 'smoke-window.png');
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(shot, dest);
      s.artifacts.push(relative(ROOT, dest).replace(/\\/g, '/'));
    }
    if (s.status === 'PASS' && !/^SMOKE_OK/.test(text)) {
      s.status = 'FAIL';
      s.note = 'Exitcode 0, aber smoke-result.txt meldet keinen Erfolg';
      s.errors = [text || '(smoke-result.txt leer)'];
    } else if (s.status === 'PASS') {
      s.note = text.slice(0, 200);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  return s;
}

async function stageE2e(prereqs) {
  const s = stage('e2e', { command: 'npx playwright test (echtes Electron: Fenster, Preload-Bridge, IPC, Chat, Streaming)' });
  if (CFG.noE2e) {
    s.status = 'SKIP';
    s.note = 'durch --quick/--no-e2e deaktiviert';
    return s;
  }
  if (!prereqs.facts?.electronOk) {
    s.status = 'INFRASTRUCTURE_ERROR';
    s.errors = ['Electron-Dist fehlt — E2E kann die App nicht starten'];
    s.note = 'Electron-Dist fehlt (npm ci unvollständig oder electron-Postinstall blockiert) — Umgebung, kein Codefehler';
    return s;
  }
  if (!prereqs.facts?.playwrightOk) {
    s.status = CFG.ci ? 'INFRASTRUCTURE_ERROR' : 'SKIP';
    s.note = CFG.ci
      ? '@playwright/test fehlt in CI — npm ci unvollständig (Umgebungsfehler, kein Skip)'
      : '@playwright/test nicht installiert — E2E übersprungen (NICHT als bestanden gewertet)';
    return s;
  }
  await killStaleElectron();
  mkdirSync(CFG.outDir, { recursive: true });
  const result = await run('npx playwright test', { timeoutMs: 1_800_000 * CFG.timeoutScale });
  markStage(s, result, { infra: [/Executable doesn't exist/, /Electron failed to install/, /Cannot find module/] });

  try {
    const parsed = JSON.parse(readFileSync(join(CFG.outDir, 'e2e-results.json'), 'utf8'));
    const specs = (parsed.suites ?? []).flatMap(function walk(suite, prefix = '') {
      const title = prefix ? `${prefix} › ${suite.title}` : suite.title;
      const own = (suite.specs ?? []).map((spec) => ({
        title: `${title} › ${spec.title}`,
        ok: Boolean(spec.ok),
        tests: (spec.tests ?? []).map((t) => ({ status: t.status })),
        results: (spec.tests ?? []).flatMap((t) => t.results ?? []),
      }));
      return [...own, ...(suite.suites ?? []).flatMap((c) => walk(c, title))];
    });
    s.failedTests = specs
      .filter((x) => !x.ok)
      .map((x) => x.title)
      .slice(0, 30);
    s.skippedTests = specs
      .filter((x) => x.tests.length > 0 && x.tests.every((t) => t.status === 'skipped'))
      .map((x) => x.title)
      .slice(0, 30);
    s.artifacts = [
      ...new Set(
        specs
          .flatMap((x) => x.results)
          .flatMap((r) => (r.attachments ?? []).filter((a) => a.path).map((a) => relative(ROOT, a.path).replace(/\\/g, '/'))),
      ),
    ].slice(0, 80);
    const counts = specs.reduce((acc, x) => {
      const status = x.tests[0]?.status ?? (x.ok ? 'passed' : 'failed');
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, {});
    s.counts = { scenarios: specs.length, ...counts };
    if (specs.length === 0 && s.status === 'PASS') {
      s.status = 'SKIP';
      s.note = 'keine E2E-Spezifikation ausgeführt';
    } else if (s.status === 'PASS') {
      s.note = `${specs.length} Szenarien: ${Object.entries(counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ')}`;
    }
  } catch {
    if (s.status === 'PASS') s.note = 'kein JSON-Report (Exitcode ausgewertet)';
  }
  return s;
}

async function stageOllama(ollama) {
  const s = stage('ollama', { command: 'npx vitest run tests/ollama-live.test.ts (echter lokaler Server)' });
  if (CFG.noOllama) {
    s.status = 'SKIP';
    s.note = 'durch --quick/--no-ollama deaktiviert';
    return s;
  }
  if (!ollama.reachable) {
    s.status = CFG.requireOllama ? 'FAIL' : 'SKIP';
    s.note = `Ollama nicht erreichbar unter ${ollama.baseUrl}${ollama.note ? ` (${ollama.note})` : ''} — Runtime-Tests NICHT als bestanden gewertet`;
    if (CFG.requireOllama) s.errors = ['--require-ollama gesetzt, aber kein Server erreichbar'];
    return s;
  }
  const jsonFile = join(tmpdir(), `lpai-live-${Date.now()}.json`);
  const result = await run(`npx vitest run tests/ollama-live.test.ts --reporter=default --reporter=json --outputFile="${jsonFile}"`, {
    timeoutMs: 1_500_000 * CFG.timeoutScale,
    env: { LPAI_LIVE_OLLAMA: '1', ...(process.env.LPAI_OLLAMA_URL ? { LPAI_OLLAMA_URL: process.env.LPAI_OLLAMA_URL } : {}) },
  });
  markStage(s, result, { infra: [/ECONNREFUSED/, /11434/] });
  try {
    const parsed = JSON.parse(readFileSync(jsonFile, 'utf8'));
    const assertions = (parsed.testResults ?? []).flatMap((f) => f.assertionResults ?? []);
    s.counts = {
      passed: assertions.filter((a) => a.status === 'passed').length,
      failed: assertions.filter((a) => a.status === 'failed').length,
      skipped: assertions.filter((a) => a.status === 'skipped').length,
    };
    s.failedTests = assertions.filter((a) => a.status === 'failed').map((a) => String(a.fullName ?? a.title));
    s.skippedTests = assertions
      .filter((a) => a.status === 'skipped')
      .map((a) => String(a.fullName ?? a.title))
      .slice(0, 30);
    if (s.status === 'PASS' && s.counts.passed === 0) {
      s.status = 'FAIL';
      s.note = 'Live-Lauf beendet, aber kein einziger Test ausgeführt';
    } else if (s.status === 'PASS') {
      s.note = `echter Server ${ollama.baseUrl}${ollama.version ? ` (v${ollama.version})` : ''}: ${s.counts.passed} Tests grün`;
    }
  } catch {
    /* exit code is authoritative */
  } finally {
    try {
      rmSync(jsonFile, { force: true });
    } catch {
      /* ignore */
    }
  }
  return s;
}

// ---------------------------------------------------------------- analysis

function diffSince(baseSha) {
  const stat = (baseSha ? gitOut(`diff --stat ${baseSha}..HEAD`) : gitOut('show --stat --oneline -1')) ?? '';
  const filesRaw = (baseSha ? gitOut(`diff --name-only ${baseSha}..HEAD`) : gitOut('show --name-only --pretty=format: -1')) ?? '';
  const files = filesRaw
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter(Boolean);
  let excerpt = '';
  if (baseSha) {
    const relevant = files.filter((f) => /\.(ts|tsx|mjs|cjs|js)$/.test(f) && !f.startsWith('test-reports/'));
    if (relevant.length > 0) {
      excerpt = (
        gitOut(
          `diff -U2 ${baseSha}..HEAD -- ${relevant
            .slice(0, 4)
            .map((f) => `"${f}"`)
            .join(' ')}`,
        ) ?? ''
      ).slice(0, 4000);
    }
  }
  return { stat: stat.slice(0, 2000), files: files.slice(0, 60), excerpt, base: baseSha ?? undefined };
}

/** Copy of the real config/DB so the analyzer sees the user's models but mutates nothing. */
function prepareAnalysisDataDir() {
  const src = process.env.LPAI_ANALYSIS_DATA_DIR ?? defaultAppDataDir();
  const dst = mkdtempSync(join(tmpdir(), 'lpai-analyze-'));
  for (const name of ['config.json', 'lpai.db']) {
    const f = join(src, name);
    if (existsSync(f)) {
      try {
        cpSync(f, join(dst, name));
      } catch {
        /* a locked DB is fine — providers are rediscovered at boot */
      }
    }
  }
  return dst;
}

async function runAnalysis(previousState) {
  if (CFG.noAnalyze) return null;
  const dataDir = prepareAnalysisDataDir();
  try {
    await ensureBundle({
      entry: join(ROOT, 'src', 'main', 'diagnostics', 'failureAnalysis.ts'),
      out: join(ROOT, 'dist', 'autonomy', 'failureAnalysis.mjs'),
    });
    const mod = await import(`file://${join(ROOT, 'dist', 'autonomy', 'failureAnalysis.mjs').replace(/\\/g, '/')}`);
    const state = normalizeState(previousState);
    return await mod.analyzeFailure({
      reportPath: join(CFG.outDir, 'latest.json'),
      dataDir,
      diff: diffSince(state.lastGoodSha ?? state.lastTestedSha ?? null),
      baselineFailures: state.baselineFailures,
      useAi: !CFG.noAiAnalysis,
      aiTimeoutMs: 150_000,
      maxPromptChars: 6000,
    });
  } catch (err) {
    return {
      analyzedAt: new Date().toISOString(),
      heuristic: null,
      ai: null,
      aiRequested: !CFG.noAiAnalysis,
      aiError: `Analyse-Modul nicht verfügbar: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`,
      promptChars: 0,
      final: {
        category: 'unknown',
        probableCause: 'Analyse konnte nicht ausgeführt werden',
        component: 'analysis',
        observation: err instanceof Error ? err.message : String(err),
        recommendedFix: 'Report und Artefakte manuell prüfen',
        confidence: 0,
        source: 'heuristic',
      },
    };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- main

async function main() {
  mkdirSync(CFG.outDir, { recursive: true });

  const git = {
    commit: (gitOut('rev-parse HEAD') ?? '').trim() || null,
    branch: (gitOut('rev-parse --abbrev-ref HEAD') ?? '').trim() || null,
    // the repair prompt must contain a URL one can actually clone
    remoteUrl: (gitOut('config --get remote.origin.url') ?? '').trim() || null,
    subject: (gitOut('log -1 --pretty=%s') ?? '').trim().slice(0, 200) || null,
    dirty: (gitOut('status --porcelain') ?? '').trim().length > 0,
  };

  const previousState = existsSync(CFG.stateFile) ? JSON.parse(readFileSync(CFG.stateFile, 'utf8')) : null;
  const ollama = await detectOllama();
  const npmVersion = (await run('npm --version', { timeoutMs: 30_000 })).output.trim().split(/\r?\n/).pop() ?? '?';

  const meta = {
    git,
    command: `node scripts/autonomous-test.mjs ${argv.join(' ')}`.trim(),
    ollama,
    runner: {
      name: process.env.RUNNER_NAME ?? hostname(),
      os: `${platform()} ${release()}`,
      platform: platform(),
      arch: process.arch,
      node: process.versions.node,
      npm: npmVersion,
      cpu: cpus()[0]?.model?.trim() ?? '?',
      cpuCount: cpus().length,
      totalMemGb: Math.round(totalmem() / 1024 ** 3),
      isGithubActions: process.env.GITHUB_ACTIONS === 'true',
      githubRunId: process.env.GITHUB_RUN_ID ?? null,
      githubRunUrl: process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY ?? ''}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
    },
  };

  log(`▶ autonomer Testlauf — ${git.branch ?? '?'} @ ${(git.commit ?? '?').slice(0, 10)} auf ${meta.runner.os}`);
  log(
    `  Ollama: ${ollama.reachable ? `erreichbar (${ollama.baseUrl}${ollama.version ? `, v${ollama.version}` : ''}${ollama.models !== undefined ? `, ${ollama.models} Modelle` : ''})` : `nicht erreichbar (${ollama.note ?? 'kein Server'})`}`,
  );

  const announce = (s, label) =>
    log(
      `  ${s.status === 'PASS' ? '✔' : s.status === 'SKIP' ? '⏭' : s.status === 'FAIL' ? '✖' : '🛠'} ${label} (${(s.durationMs / 1000).toFixed(1)}s)${s.note ? ` — ${s.note}` : ''}`,
    );

  const prereqs = await stagePrereqs();
  announce(prereqs, 'prereqs');

  if (prereqs.status === 'PASS') {
    announce(await stageNative(), 'native');
    announce(await stageSimple('typecheck', 'npm run typecheck', { timeoutMs: 600_000 }), 'typecheck');
    announce(await stageSimple('build', 'npm run build', { timeoutMs: 900_000 }), 'build');
    const { unitStage, intStage } = await stageTests();
    announce(unitStage, 'unit');
    announce(intStage, 'integration');
    announce(await stageSmoke(prereqs), 'smoke');
    announce(await stageE2e(prereqs), 'e2e');
    announce(await stageOllama(ollama), 'ollama');
  } else {
    for (const name of ['native', 'typecheck', 'build', 'unit', 'integration', 'smoke', 'e2e', 'ollama']) {
      const s = stage(name, {});
      s.status = 'INFRASTRUCTURE_ERROR';
      s.note = 'übersprungen — Voraussetzungen nicht erfüllt';
    }
  }

  // ---- guards: may the loop continue automatically? ----
  const verdict = stages.some((s) => s.status === 'FAIL')
    ? 'FAIL'
    : stages.some((s) => s.status === 'INFRASTRUCTURE_ERROR')
      ? 'INFRASTRUCTURE_ERROR'
      : 'PASS';
  // what actually changed since the last TESTED commit (not since the last commit):
  // committed work plus whatever is sitting uncommitted in the worktree right now
  const changedFilesRaw = previousState?.lastTestedSha
    ? (gitOut(`diff --name-only ${previousState.lastTestedSha}..HEAD`) ?? '')
    : (gitOut('show --name-only --pretty=format: -1') ?? '');
  const worktreeRaw = git.dirty ? (gitOut('status --porcelain') ?? '') : '';
  const changedFiles = [
    ...new Set([
      ...changedFilesRaw.split(/\r?\n/),
      // porcelain columns are fixed-width; renames read "old -> new"
      ...worktreeRaw.split(/\r?\n/).map((line) => line.slice(3).split(' -> ').pop() ?? ''),
    ]),
  ]
    .map((f) => f.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  const evaluation = evaluateGuards({
    previous: previousState,
    report: {
      git,
      verdict,
      stages,
      summary: { failedTests: [...new Set(stages.flatMap((s) => s.failedTests ?? []))].slice(0, 50) },
      runner: { githubRunId: meta.runner.githubRunId },
    },
    fingerprint: fingerprintOf({ verdict, stages }),
    opts: { maxAttempts: CFG.maxAttempts, requireOllama: CFG.requireOllama, ollamaReachable: ollama.reachable, changedFiles },
  });

  const report = buildReport({
    meta: { ...meta, changedFiles, previousTestedSha: previousState?.lastTestedSha ?? null },
    stages,
    guards: guardsForReport(evaluation),
    startedAt: START,
    finishedAt: Date.now(),
  });

  // The analyzer reads the report from disk, so this run's report has to exist
  // before the analysis and is refreshed right after it.
  writeFileSync(join(CFG.outDir, 'latest.json'), JSON.stringify(report, null, 2));
  if (report.verdict !== 'PASS') {
    log('  ⚙ Fehleranalyse …');
    report.analysis = await runAnalysis(previousState);
    if (report.analysis?.final) {
      log(
        `    ${report.analysis.final.category} (${report.analysis.final.confidence}) — ${report.analysis.final.probableCause.slice(0, 120)}`,
      );
      // promote the analysis to the two fields an outside reader looks at first
      report.likelyRootCause = report.analysis.final.probableCause;
      report.confidence = report.analysis.final.confidence;
      // ... and let an unusable verdict stop the loop: without a plausible cause
      // an automatic change would be guesswork
      const a = report.analysis.final;
      if (a.category === 'unknown' && Number(a.confidence ?? 0) <= 0.1) {
        evaluation.stop = true;
        evaluation.reasons = [...new Set([...evaluation.reasons, 'unknown_cause'])];
        evaluation.state = { ...evaluation.state, stopped: true, stopReasons: evaluation.reasons };
        report.guards = guardsForReport(evaluation);
        log('    ⚠ keine belastbare Ursache — Automatik gestoppt (manuelle Prüfung)');
      }
    }
  }

  writeFileSync(join(CFG.outDir, 'latest.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(CFG.outDir, `${report.reportId}.json`), JSON.stringify(report, null, 2));
  const md = renderMarkdown(report);
  writeFileSync(join(CFG.outDir, 'latest.md'), md);
  writeFileSync(join(CFG.outDir, `${report.reportId}.md`), md);
  if (report.analysis) writeFileSync(join(CFG.outDir, 'latest-analysis.json'), JSON.stringify(report.analysis, null, 2));
  // a skipped analysis must not leave the previous run's verdict lying around
  else rmSync(join(CFG.outDir, 'latest-analysis.json'), { force: true });
  // Two audiences read the same run: an analyzing instance (ChatGPT) gets the
  // machine-readable digest, the coding agent (Arena) gets the repair order.
  // Both are derived from this one report — never from a second source.
  const digest = buildAiDigest(report, {
    analysis: report.analysis,
    baselineFailures: previousState?.baselineFailures ?? [],
    previousVerdict: previousState?.lastVerdict ?? null,
    previousFingerprint: previousState?.fingerprints?.at(-1)?.hash ?? null,
  });
  report.aiDigest = { file: 'test-reports/latest-chatgpt.json', isCodeDefect: digest.isCodeDefect, humanSummary: digest.humanSummary };
  writeFileSync(join(CFG.outDir, 'latest-chatgpt.json'), JSON.stringify(digest, null, 2));
  writeFileSync(join(CFG.outDir, 'latest-chatgpt.md'), renderAiDigestMarkdown(digest));
  // re-write the report so it carries the digest reference it just produced
  writeFileSync(join(CFG.outDir, 'latest.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(CFG.outDir, `${report.reportId}.json`), JSON.stringify(report, null, 2));
  if (report.verdict !== 'PASS') {
    const taskArgs = { baselineFailures: previousState?.baselineFailures ?? [], analysis: report.analysis };
    writeFileSync(join(CFG.outDir, 'latest-arena-task.md'), renderArenaTask(report, taskArgs));
    writeFileSync(join(CFG.outDir, 'latest-fix-prompt.md'), renderFixPrompt(report, taskArgs));
  } else {
    // a green run has no order to hand over and must not leave stale evidence behind
    rmSync(join(CFG.outDir, 'latest-arena-task.md'), { force: true });
    rmSync(join(CFG.outDir, 'latest-fix-prompt.md'), { force: true });
  }
  writeFileSync(
    CFG.stateFile,
    JSON.stringify({ ...evaluation.state, lastReportId: report.reportId, lastVerdict: report.verdict, lastCommit: git.commit }, null, 2),
  );

  // ---- CI plumbing ----
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(
      process.env.GITHUB_OUTPUT,
      `${[
        `verdict=${report.verdict}`,
        `exit_code=${report.exitCode}`,
        `stop=${evaluation.stop}`,
        `stop_reasons=${evaluation.reasons.join(',')}`,
        `report_id=${report.reportId}`,
        `ai_digest=test-reports/latest-chatgpt.json`,
        `is_code_defect=${digest.isCodeDefect}`,
        `ollama_reachable=${ollama.reachable}`,
        `duration_s=${Math.round(report.durationMs / 1000)}`,
      ].join('\n')}\n`,
      { flag: 'a' },
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${renderComment(report)}\n\n${md}\n`, { flag: 'a' });
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const s of stages.filter((x) => x.status === 'FAIL' || x.status === 'INFRASTRUCTURE_ERROR')) {
      const line = `${s.name}: ${String((s.errors ?? [])[0] ?? s.note ?? 'unbekannter Fehler')
        .replace(/\r?\n/g, ' ')
        .slice(0, 300)}`;
      console.log(
        s.status === 'FAIL'
          ? `::error title=Stufe ${s.name} fehlgeschlagen::${line}`
          : `::warning title=Stufe ${s.name} (Umgebung)::${line}`,
      );
    }
    if (evaluation.stop) console.log(`::warning title=Reparaturzyklus gestoppt::${explainStop(evaluation.reasons).join(' · ')}`);
  }

  log('');
  for (const s of stages) {
    const icon = s.status === 'PASS' ? '✔' : s.status === 'SKIP' ? '⏭' : s.status === 'FAIL' ? '✖' : '🛠';
    log(`  ${icon} ${s.name.padEnd(12)} ${s.status.padEnd(22)} ${(s.durationMs / 1000).toFixed(1)}s`);
  }
  log('');
  log(
    `  Ergebnis: ${report.verdict} (${(report.durationMs / 1000).toFixed(1)}s) — Reports in ${relative(process.cwd(), CFG.outDir) || CFG.outDir}`,
  );
  if (evaluation.stop) log(`  ⚠ Reparaturzyklus gestoppt: ${explainStop(evaluation.reasons).join(' · ')}`);
  if (CFG.json) console.log(JSON.stringify(report, null, 2));

  process.exit(report.exitCode);
}

main().catch((err) => {
  console.error('[autonomous-test] unerwarteter Fehler:', err);
  process.exit(2);
});
