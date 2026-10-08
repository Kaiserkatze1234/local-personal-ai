/**
 * Tests for the autonomy infrastructure itself (not the app): report contract,
 * loop guards, the generated repair order, the failure-analysis rules and the
 * wiring of the whole loop (workflows, scripts, config).
 *
 * These are the deterministic parts of the loop, so they run in the normal
 * suite and in `test:autonomous` — a broken guard or a workflow that suddenly
 * exposes the self-hosted runner to fork PRs must fail here, cheaply, instead
 * of showing up as a strange run three hours later.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DANGEROUS_PATHS, dangerousChangedFiles, evaluateGuards, explainStop, normalizeState } from '../scripts/autonomous/guards.mjs';
import {
  buildAiDigest,
  buildReport,
  extractErrorLines,
  fingerprintOf,
  makeStage,
  REPORT_MARKER,
  renderAiDigestMarkdown,
  renderArenaTask,
  renderComment,
  renderFixPrompt,
  renderMarkdown,
} from '../scripts/autonomous/report.mjs';
import {
  buildAnalysisPrompt,
  classifyReport,
  classifyStage,
  parseAnalysisResponse,
  stageEvidence,
  trimError,
} from '../src/main/diagnostics/failureAnalysis.js';

const REPO = join(import.meta.dirname, '..');

/** The loop modules are plain .mjs (they run under plain node in CI); these
 * locals give the test file a typed handle on their contract. */
interface CycleState {
  schema: number;
  cycleId: string | null;
  attempts: number;
  maxAttempts: number;
  lastVerdict: string | null;
  lastTestedSha: string | null;
  lastGoodSha: string | null;
  baselineFailures: string[];
  fingerprints: { hash: string; count: number; failingStages?: string[] }[];
  history: { verdict: string; failingStages?: string[] }[];
  stopped: boolean;
  stopReasons: string[];
  dangerousFiles?: string[];
}
interface GuardResult {
  state: CycleState;
  stop: boolean;
  reasons: string[];
  attempt: number;
  resolved: boolean;
}
interface Report {
  schema: number;
  reportId: string;
  verdict: string;
  exitCode: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  git: GitInfo;
  runner: typeof runner;
  stages: {
    name: string;
    status: string;
    durationMs: number;
    errors?: string[];
    failedTests?: string[];
    artifacts?: string[];
    note?: string | null;
    counts?: Record<string, number>;
  }[];
  summary: {
    stages: number;
    passed: number;
    failed: number;
    skipped: number;
    infrastructureErrors: number;
    failedStages: string[];
    failedTests: string[];
    skippedTests: string[];
  };
  changedFiles?: string[];
  previousTestedSha?: string | null;
  likelyRootCause?: string | null;
  confidence?: number | null;
  analysis?: Record<string, unknown> | null;
  guards?: Record<string, unknown> | null;
  artifacts: { screenshots: string[]; traces: string[]; logs: string[]; other: string[] };
}
const build = buildReport as unknown as (input: {
  meta: { git: GitInfo; runner: typeof runner; ollama: object; changedFiles?: string[]; previousTestedSha?: string | null };
  stages: object[];
  guards?: object | null;
  analysis?: object | null;
  startedAt: number;
  finishedAt: number;
}) => Report;
const markdown = renderMarkdown as unknown as (report: Report) => string;
const fixPrompt = renderFixPrompt as unknown as (
  report: Report,
  opts?: { baselineFailures?: string[]; analysis?: Record<string, unknown> | null },
) => string;
const commentFor = renderComment as unknown as (report: Report) => string;
interface Digest {
  verdict: string;
  works: string[];
  broken: string[];
  failedTests: string[];
  skippedTests: string[];
  isCodeDefect: boolean;
  isInfrastructureError: boolean;
  recommendedFix: string;
  likelyRootCause: string | null;
  confidence: number | null;
  humanSummary: string;
  whatWasTested: { branch: string; commit: string; changedFiles: string[]; previousTestedSha: string | null; stages: { name: string }[] };
  infrastructureErrors: { stage: string; reason: string | null }[];
  classification: { category: string; categoryLabel: string; source: string };
  regression: {
    isRegression: boolean;
    repeatedFailure: boolean;
    progress: string;
    newFailures: string[];
    fixedSinceLastRun: string[];
    alreadyBrokenBefore: string[];
    previousVerdict: string | null;
    stopped: boolean;
  };
  reproduce: { clone: string | null; commit: string; steps: string[] };
  testsToRerun: { stages: string[]; failedTests: string[]; command: string; mustStayGreen: string[] };
  artifacts: { arenaTask: string | null; reportJson: string };
  failures: { stage: string; environmentProblem: boolean }[];
}
const aiDigest = buildAiDigest as unknown as (
  report: Report,
  opts?: {
    analysis?: Record<string, unknown> | null;
    baselineFailures?: string[];
    previousVerdict?: string | null;
    previousFingerprint?: string | null;
  },
) => Digest;
const aiDigestMd = renderAiDigestMarkdown as unknown as (digest: object) => string;
const arenaTask = renderArenaTask as unknown as (
  report: Report,
  opts?: { analysis?: Record<string, unknown> | null; baselineFailures?: string[] },
) => string;

const evaluate = evaluateGuards as unknown as (input: {
  previous?: CycleState | null;
  report: object;
  fingerprint: string;
  opts?: { maxAttempts?: number; requireOllama?: boolean; ollamaReachable?: boolean; changedFiles?: string[] };
}) => GuardResult;
const normalize = normalizeState as unknown as (raw: unknown) => CycleState;
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

const git = { commit: 'a'.repeat(40), branch: 'arena/test', subject: 'fix: x', dirty: false };
/** `remoteUrl` is optional: a checkout without a remote has none. */
type GitInfo = typeof git & { remoteUrl?: string | null };
const runner = {
  name: 'TEST-PC',
  os: 'win32 10.0.26100',
  platform: 'win32',
  arch: 'x64',
  node: '22.20.0',
  npm: '11.6.0',
  cpu: 'AMD Ryzen 5 5600H',
  cpuCount: 12,
  totalMemGb: 16,
  isGithubActions: true,
  githubRunId: '12345',
  githubRunUrl: 'https://github.com/x/y/actions/runs/12345',
};
const ollamaUp = {
  reachable: true,
  baseUrl: 'http://127.0.0.1:11434',
  version: '0.34.0',
  models: 4,
  chatCapable: ['qwen3:4b'],
  embeddingCapable: ['nomic-embed-text'],
  note: null,
};

function stage(name: string, status: string, extra: Record<string, unknown> = {}) {
  return { ...makeStage(name, {}), status, durationMs: 1000, exitCode: status === 'PASS' ? 0 : 1, ...extra };
}

describe('report contract', () => {
  it('derives verdict and exit code from the stages (INFRASTRUCTURE_ERROR is not PASS)', () => {
    const pass = build({
      meta: { git, runner, ollama: ollamaUp },
      stages: [stage('unit', 'PASS')],
      guards: null,
      startedAt: 0,
      finishedAt: 1000,
    });
    expect(pass.verdict).toBe('PASS');
    expect(pass.exitCode).toBe(0);

    const fail = build({
      meta: { git, runner, ollama: ollamaUp },
      stages: [stage('unit', 'FAIL')],
      guards: null,
      startedAt: 0,
      finishedAt: 1000,
    });
    expect(fail.verdict).toBe('FAIL');
    expect(fail.exitCode).toBe(1);

    const infra = build({
      meta: { git, runner, ollama: ollamaUp },
      stages: [stage('smoke', 'INFRASTRUCTURE_ERROR')],
      guards: null,
      startedAt: 0,
      finishedAt: 1000,
    });
    expect(infra.verdict).toBe('INFRASTRUCTURE_ERROR');
    expect(infra.exitCode).toBe(2);
    expect(infra.summary.infrastructureErrors).toBe(1);
  });

  it('keeps SKIP visible instead of turning it into a pass (ollama missing)', () => {
    const report = build({
      meta: { git, runner, ollama: { ...ollamaUp, reachable: false, note: 'kein Server' } },
      stages: [stage('unit', 'PASS'), stage('ollama', 'SKIP', { note: 'Ollama nicht erreichbar' })],
      guards: null,
      startedAt: 0,
      finishedAt: 1000,
    });
    expect(report.verdict).toBe('PASS');
    expect(report.summary.skipped).toBe(1);
    const md = markdown(report);
    expect(md).toContain('⏭️ SKIP');
    expect(md).toContain('nicht erreichbar');
  });

  it('trims error lines: filters noise, caps count and length', () => {
    const log = ['starting up', 'ok', `ERROR: boom ${'x'.repeat(900)}`, 'fine', 'FAIL something broke'].join('\n');
    const lines = extractErrorLines(log, 5, 60);
    expect(lines.join('\n')).toContain('boom');
    expect(lines.join('\n')).toContain('something broke');
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(61);
  });

  it('fingerprints the failure, not the run (same failure → same hash, new failure → new hash)', () => {
    const mk = (errors: string[], tests: string[]) =>
      ({ verdict: 'FAIL', stages: [stage('unit', 'FAIL', { errors, failedTests: tests })] }) as never;
    const a = fingerprintOf(mk(['AssertionError: expected 2 to be 3'], ['suite › test A']));
    const b = fingerprintOf(mk(['AssertionError: expected 2 to be 3'], ['suite › test A']));
    const c = fingerprintOf(mk(['AssertionError: expected 4 to be 5'], ['suite › test B']));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(16);
  });
});

describe('loop guards', () => {
  const reportOf = (verdict: string, stages: { name: string; status: string }[], failedTests: string[] = []) =>
    ({ git, verdict, stages, summary: { failedTests }, runner: { githubRunId: '12345' } }) as never;

  it('a PASS resets the cycle completely', () => {
    const previous = normalize({
      cycleId: 'cycle-x',
      attempts: 2,
      lastVerdict: 'FAIL',
      fingerprints: [{ hash: 'h', count: 2, failingStages: ['unit'] }],
      history: [{ verdict: 'FAIL' }],
    });
    const { state, resolved, stop } = evaluate({
      previous,
      report: reportOf('PASS', [{ name: 'unit', status: 'PASS' }]),
      fingerprint: 'h',
    });
    expect(resolved).toBe(true);
    expect(stop).toBe(false);
    expect(state.attempts).toBe(0);
    expect(state.cycleId).toBeNull();
    expect(state.fingerprints).toEqual([]);
    expect(state.lastGoodSha).toBe(git.commit);
  });

  it('counts rounds across failing pushes and stops at maxAttempts', () => {
    const stages = [{ name: 'unit', status: 'FAIL' }];
    let state: CycleState | null = null;
    let attempt = 0;
    // maxAttempts=3 allows three repair rounds; the fourth failing round stops the loop
    for (let i = 1; i <= 4; i++) {
      const res = evaluate({
        previous: state,
        report: reportOf('FAIL', stages, [`suite › one ${i}`]),
        fingerprint: `h${i}`,
        opts: { maxAttempts: 3 },
      });
      state = res.state;
      attempt = res.attempt;
      if (i < 4) expect(res.stop, `Runde ${i} läuft weiter`).toBe(false);
      if (i === 4) {
        expect(res.stop).toBe(true);
        expect(res.reasons).toContain('max_attempts_reached');
      }
    }
    expect(attempt).toBe(4);
  });

  it('stops when the identical failure comes back a third time', () => {
    let state: CycleState | null = null;
    const stages = [{ name: 'e2e', status: 'FAIL' }];
    for (let i = 1; i <= 3; i++) {
      const res = evaluate({
        previous: state,
        report: reportOf('FAIL', stages, ['e2e › chat']),
        fingerprint: 'same',
        opts: { maxAttempts: 10 },
      });
      state = res.state;
      if (i === 3) {
        expect(res.reasons).toContain('repeated_failure');
        expect(res.stop).toBe(true);
      }
    }
  });

  it('stops on infrastructure errors and on a required-but-missing Ollama', () => {
    const infra = evaluate({
      previous: null,
      report: reportOf('INFRASTRUCTURE_ERROR', [{ name: 'native', status: 'INFRASTRUCTURE_ERROR' }]),
      fingerprint: 'i1',
      opts: { maxAttempts: 3, requireOllama: true, ollamaReachable: false },
    });
    expect(infra.stop).toBe(true);
    expect(infra.reasons).toEqual(expect.arrayContaining(['infrastructure_error', 'ollama_unavailable']));
    expect(explainStop(infra.reasons).join(' ')).toMatch(/Umgebung|Ollama/);
  });

  it('stops when the failure set grows (regression) but not on the first failure', () => {
    const first = evaluate({
      previous: null,
      report: reportOf('FAIL', [{ name: 'unit', status: 'FAIL' }]),
      fingerprint: 'a',
      opts: { maxAttempts: 9 },
    });
    const worse = evaluate({
      previous: first.state,
      report: reportOf('FAIL', [
        { name: 'unit', status: 'FAIL' },
        { name: 'e2e', status: 'FAIL' },
      ]),
      fingerprint: 'b',
      opts: { maxAttempts: 9 },
    });
    expect(worse.reasons).toContain('tests_regressed');
    expect(worse.stop).toBe(true);
  });

  it('protects the loop from being edited by the thing it tests (dangerous change)', () => {
    expect(dangerousChangedFiles(['.github/workflows/autonomous-test.yml'])).toHaveLength(1);
    expect(dangerousChangedFiles(['scripts/autonomous/guards.mjs', 'scripts/windows/install-runner.ps1'])).toHaveLength(2);
    expect(dangerousChangedFiles(['src/main/app.ts', 'tests/e2e/chat.spec.ts'])).toHaveLength(0);

    // the very first round may introduce them (the automation PR itself)…
    const firstRound = evaluate({
      previous: null,
      report: reportOf('FAIL', [{ name: 'unit', status: 'FAIL' }]),
      fingerprint: 'x',
      opts: { maxAttempts: 9, changedFiles: ['.github/workflows/autonomous-test.yml'] },
    });
    expect(firstRound.reasons).not.toContain('dangerous_change');
    // …but a later fix round must not silently rewrite them
    const laterRound = evaluate({
      previous: firstRound.state,
      report: reportOf('FAIL', [{ name: 'unit', status: 'FAIL' }]),
      fingerprint: 'y',
      opts: { maxAttempts: 9, changedFiles: ['.github/workflows/autonomous-test.yml'] },
    });
    expect(laterRound.reasons).toContain('dangerous_change');
    expect(laterRound.state.dangerousFiles).toContain('.github/workflows/autonomous-test.yml');
  });

  it('keeps the state bounded (fingerprints and history cannot grow forever)', () => {
    let state: CycleState | null = null;
    for (let i = 0; i < 30; i++) {
      state = evaluate({
        previous: state,
        report: reportOf('FAIL', [{ name: 'unit', status: 'FAIL' }]),
        fingerprint: `h${i}`,
        opts: { maxAttempts: 999 },
      }).state;
    }
    const s = normalize(state);
    expect(s.fingerprints.length).toBeLessThanOrEqual(10);
    expect(s.history.length).toBeLessThanOrEqual(20);
    expect(DANGEROUS_PATHS.length).toBeGreaterThan(0);
  });
});

describe('repair order (latest-fix-prompt.md)', () => {
  const report = build({
    meta: { git, runner, ollama: ollamaUp },
    stages: [
      stage('typecheck', 'PASS'),
      stage('unit', 'FAIL', {
        failedTests: ['tests/app.test.ts › chat turn › streams the answer'],
        errors: ["AssertionError: expected 'Hallo' to be 'Hallo Welt'", 'at tests/app.test.ts:42:7'],
      }),
    ],
    guards: null,
    startedAt: 0,
    finishedAt: 12_000,
  });

  it('carries a cloneable repository URL — a placeholder only when nothing is known', () => {
    const withRemote = build({
      meta: { git: { ...git, remoteUrl: 'https://github.com/Kaiserkatze1234/local-personal-ai.git' }, runner: runner as never, ollama: {} },
      stages: [{ ...makeStage('unit'), status: 'FAIL', errors: ['boom'] }],
      startedAt: Date.now() - 500,
      finishedAt: Date.now(),
    });
    const prompt = fixPrompt(withRemote);
    expect(prompt).toContain('git clone https://github.com/Kaiserkatze1234/local-personal-ai && cd local-personal-ai');
    expect(prompt, 'kein Platzhalter, wenn das Remote bekannt ist').not.toContain('<owner>/<repo>');
    expect(fixPrompt(report), 'ohne Remote bleibt ein erkennbarer Platzhalter').toContain('<owner>/<repo>');
  });

  it('contains everything a coding agent needs, and no raw logs', () => {
    const prompt = fixPrompt(report, { baselineFailures: ['tests/old.test.ts › known'] });
    for (const section of [
      '## Aufgabe',
      '## Reproduzierbarer Fehler',
      '## Erwartetes Verhalten',
      '## Tatsächliches Verhalten',
      '## Relevante Dateien',
      '## Wahrscheinliche Ursache',
      '## Einschränkungen',
      '## Regressionstest-Anforderung',
      '## Loop-Status',
    ]) {
      expect(prompt, `Abschnitt ${section}`).toContain(section);
    }
    expect(prompt).toContain('tests/app.test.ts › chat turn › streams the answer');
    expect(prompt).toContain('npm run test:autonomous');
    expect(prompt).toContain('tests/old.test.ts › known');
    expect(prompt).toContain(git.commit);
    expect(prompt.length).toBeLessThan(12_000);
    expect(prompt).not.toContain('node_modules');
  });

  it('folds in the AI verdict when one exists, and says so when it does not', () => {
    const analysis: Record<string, unknown> = {
      analyzedAt: 'now',
      heuristic: null,
      ai: null,
      aiRequested: true,
      aiSkipReason: 'deterministic evidence is decisive (infrastructure)',
      promptChars: 900,
      final: {
        category: 'infrastructure',
        probableCause: 'Ollama nicht gestartet',
        component: 'ollama',
        file: undefined,
        observation: 'ECONNREFUSED 127.0.0.1:11434',
        recommendedFix: 'Ollama starten',
        confidence: 0.8,
        source: 'heuristic',
      },
    };
    const prompt = fixPrompt(report, { analysis });
    expect(prompt).toContain('infrastructure');
    expect(prompt).toContain('Ollama nicht gestartet');
    expect(prompt).toMatch(/Konfidenz 0\.8/);
  });

  it('renders a PR comment with the machine-readable marker', () => {
    const comment = commentFor(report);
    expect(comment.startsWith(REPORT_MARKER)).toBe(true);
    expect(comment).toContain('❌');
    expect(comment).toContain('latest-fix-prompt.md');
  });
});

describe('failure analysis rules', () => {
  it('never turns an environment problem into a code defect', () => {
    const infra = classifyStage(stage('unit', 'FAIL', { errors: ['Error: ENOENT: no such file or directory, open C:\\x\\y'] }) as never);
    expect(infra.category).toBe('infrastructure');

    const provider = classifyStage(
      stage('ollama', 'FAIL', { errors: ['FetchError: request to http://127.0.0.1:11434/api/chat failed, ECONNREFUSED'] }) as never,
    );
    expect(provider.category).toBe('runtime_provider');
  });

  it('recognizes build breaks, UI failures and regressions', () => {
    expect(
      classifyStage(stage('typecheck', 'FAIL', { errors: ['src/main/app.ts(12,3): error TS2322: Type string is not assignable'] }) as never)
        .category,
    ).toBe('build_defect');

    const ui = classifyStage(
      stage('e2e', 'FAIL', { errors: ['Timeout 30000ms exceeded waiting for locator .composer textarea'] }) as never,
    );
    expect(ui.category).toBe('ui_defect');

    const regression = classifyStage(
      stage('unit', 'FAIL', { failedTests: ['tests/app.test.ts › streams'], errors: ["AssertionError: expected 'a' to be 'b'"] }) as never,
      { baselineFailures: ['tests/other.test.ts › old'] },
    );
    expect(regression.category).toBe('regression');

    const testDefect = classifyStage(stage('unit', 'FAIL', { failedTests: ['tests/app.test.ts › streams'] }) as never);
    expect(testDefect.category).toBe('code_defect');
  });

  it('marks already-broken failures as pre-existing instead of blaming the change', () => {
    const verdict = classifyStage(stage('unit', 'FAIL', { failedTests: ['tests/legacy.test.ts › known break'] }) as never, {
      baselineFailures: ['tests/legacy.test.ts › known break'],
    });
    expect(verdict.category).toBe('preexisting_unrelated');
    expect(verdict.confidence).toBeGreaterThan(0.5);
  });

  it('picks the first failing stage and reports unknown when there is nothing useful', () => {
    const picked = classifyReport({
      verdict: 'FAIL',
      stages: [stage('typecheck', 'PASS'), stage('unit', 'FAIL', { errors: ['AssertionError: x'] })],
    } as never);
    expect(picked.component).toBe('unit');
    const nothing = classifyReport({ verdict: 'FAIL', stages: [stage('typecheck', 'PASS')] } as never);
    expect(nothing.category).toBe('unknown');
    expect(nothing.confidence).toBe(0);
  });

  it('builds a bounded prompt that never contains the repository', () => {
    const bigStage = stage('unit', 'FAIL', {
      errors: Array.from({ length: 50 }, (_, i) => `error line ${i} ${'x'.repeat(400)}`),
      failedTests: Array.from({ length: 30 }, (_, i) => `suite › test ${i}`),
    }) as never;
    const prompt = buildAnalysisPrompt({ verdict: 'FAIL', branch: 'b', commit: 'c' } as never, bigStage, {
      diff: { files: ['src/main/app.ts'], stat: '1 file changed', excerpt: 'diff --git a/x b/x' },
      maxChars: 2000,
    });
    expect(prompt.user.length).toBeLessThanOrEqual(2030);
    expect(prompt.system).toContain('code_defect');
    expect(prompt.system).toContain('infrastructure');
    expect(prompt.user).toContain('src/main/app.ts');
    expect(prompt.user).not.toContain('node_modules');
  });

  it('accepts only a well-formed answer from the model (and clamps confidence)', () => {
    const verdict = parseAnalysisResponse(
      'Hier ist das Ergebnis:\n```json\n{"category":"regression","probableCause":"clamp","component":"unit","observation":"x","recommendedFix":"y","confidence":4,"regressionTest":"z"}\n```',
      'm1',
      'p1',
      'review',
    );
    expect(verdict?.category).toBe('regression');
    expect(verdict?.confidence).toBe(1);

    expect(parseAnalysisResponse('kein json', 'm', 'p', 'review')).toBeNull();
    expect(parseAnalysisResponse('{"category":"nonsense","confidence":0.5}', 'm', 'p', 'review')).toBeNull();
    expect(parseAnalysisResponse('{"category":"infrastructure","confidence":"0.4"}', 'm', 'p', 'review')?.confidence).toBe(0.4);
  });

  it('keeps only the informative slices of an error list', () => {
    const evidence = stageEvidence(
      stage('unit', 'FAIL', {
        errors: Array.from({ length: 20 }, (_, i) => (i === 10 ? 'FAILED: expected 1 to be 2' : `noise ${i}`)),
      }) as never,
      4,
    );
    expect(evidence.length).toBeLessThanOrEqual(4);
    expect(evidence.join(' ')).toContain('expected 1 to be 2');
    expect(trimError(`\u001b[31m${'y'.repeat(600)}\u001b[0m`).length).toBeLessThanOrEqual(501);
  });
});

describe('AI handoff — digest for the analyzing instance', () => {
  const codeFailure = () =>
    build({
      meta: { git, runner, ollama: ollamaUp, changedFiles: ['src/main/app.ts', 'src/renderer/App.tsx'], previousTestedSha: 'b'.repeat(40) },
      stages: [
        stage('typecheck', 'PASS'),
        stage('unit', 'FAIL', {
          failedTests: ['chat turn › streams deltas'],
          errors: ['AssertionError: expected 2 to be 3 at src/main/app.ts:120'],
          counts: { passed: 180, failed: 1, skipped: 3 },
        }),
        stage('ollama', 'SKIP', { note: 'Ollama nicht erreichbar', skippedTests: ['live › chat'] }),
      ],
      guards: { attempt: 2, maxAttempts: 3, stop: false, reasons: [], cycleId: 'cycle-7', fingerprint: 'abc123', repeats: 1 },
      startedAt: 0,
      finishedAt: 30_000,
    });

  it('answers the questions a planning instance asks, without raw logs', () => {
    const d = aiDigest(codeFailure());
    expect(d.verdict).toBe('FAIL');
    expect(d.whatWasTested.branch).toBe('arena/test');
    expect(d.whatWasTested.commit).toBe(git.commit);
    expect(d.whatWasTested.changedFiles).toEqual(['src/main/app.ts', 'src/renderer/App.tsx']);
    expect(d.whatWasTested.previousTestedSha).toBe('b'.repeat(40));
    expect(d.works).toEqual(['typecheck']);
    expect(d.broken).toEqual(['unit']);
    expect(d.failedTests).toContain('chat turn › streams deltas');
    expect(d.skippedTests).toContain('live › chat');
    expect(d.isCodeDefect).toBe(true);
    expect(d.isInfrastructureError).toBe(false);
    expect(d.recommendedFix.length).toBeGreaterThan(10);
    expect(d.reproduce.clone).toBeNull(); // no remote configured in this fixture
    expect(d.reproduce.commit).toBe(git.commit);
    expect(d.testsToRerun.stages).toEqual(['unit']);
    expect(d.testsToRerun.failedTests).toContain('chat turn › streams deltas');
    expect(d.testsToRerun.mustStayGreen).toContain('typecheck');
    expect(d.artifacts.arenaTask).toBe('test-reports/latest-arena-task.md');
    // no repository dump, no full log: the digest stays a summary
    expect(JSON.stringify(d).length).toBeLessThan(20_000);
  });

  it('separates an environment problem from a code defect (and says so)', () => {
    const report = build({
      meta: { git, runner, ollama: { ...ollamaUp, reachable: false, note: 'fetch failed' } },
      stages: [
        stage('unit', 'PASS'),
        stage('e2e', 'INFRASTRUCTURE_ERROR', { errors: ['Electron-Dist fehlt — E2E kann die App nicht starten'] }),
      ],
      guards: {
        attempt: 1,
        maxAttempts: 3,
        stop: true,
        reasons: ['infrastructure_error'],
        cycleId: 'cycle-8',
        fingerprint: 'def456',
        repeats: 1,
      },
      startedAt: 0,
      finishedAt: 5000,
    });
    const d = aiDigest(report, {
      analysis: {
        final: {
          category: 'infrastructure',
          confidence: 0.8,
          component: 'e2e',
          observation: 'Electron-Dist fehlt',
          probableCause: 'Electron binary not installed',
          recommendedFix: 'Install the Electron runtime, then re-run',
          source: 'heuristic',
        },
        ai: null,
      },
    });
    expect(d.verdict).toBe('INFRASTRUCTURE_ERROR');
    expect(d.isInfrastructureError).toBe(true);
    expect(d.isCodeDefect).toBe(false);
    expect(d.infrastructureErrors[0]?.stage).toBe('e2e');
    expect(d.classification.category).toBe('infrastructure');
    expect(d.classification.categoryLabel).toBe('Infrastruktur/Umgebung');
    expect(d.confidence).toBe(0.8);
    expect(d.likelyRootCause).toBe('Electron binary not installed');
    expect(d.recommendedFix).toContain('Install the Electron runtime');
    expect(d.failures[0]?.environmentProblem).toBe(true);
    expect(d.humanSummary).toContain('e2e');
  });

  it('detects a regression: green before, red now, with the new failure named', () => {
    const d = aiDigest(codeFailure(), {
      previousVerdict: 'PASS',
      previousFingerprint: 'zzz999',
      baselineFailures: [],
    });
    expect(d.regression.isRegression).toBe(true);
    expect(d.regression.progress).toBe('worse');
    expect(d.regression.newFailures).toContain('chat turn › streams deltas');
    expect(d.regression.previousVerdict).toBe('PASS');
  });

  it('recognises progress and a repeated identical failure instead of calling everything a regression', () => {
    const d = aiDigest(codeFailure(), {
      previousVerdict: 'FAIL',
      previousFingerprint: 'abc123',
      baselineFailures: ['chat turn › streams deltas', 'chat turn › streams deltas', 'memory › persist'],
    });
    // the only failure is the pre-existing one, and nothing new broke
    expect(d.regression.isRegression).toBe(false);
    expect(d.regression.newFailures).toEqual([]);
    expect(d.regression.fixedSinceLastRun).toEqual(['memory › persist']);
    expect(d.regression.progress).toBe('improving');
    // same fingerprint as the previous run → the loop must be able to stop
    expect(d.regression.repeatedFailure).toBe(true);
    expect(d.regression.alreadyBrokenBefore).toEqual(['chat turn › streams deltas', 'memory › persist']);
  });

  it('renders a compact, readable digest instead of a wall of text', () => {
    const d = aiDigest(codeFailure(), { analysis: null, baselineFailures: [] });
    const md = aiDigestMd(d);
    expect(md).toContain('Was getestet wurde');
    expect(md).toContain('Was ist kaputt');
    expect(md).toContain('Was funktioniert');
    expect(md).toContain('chat turn › streams deltas');
    expect(md).toContain('test:autonomous');
    expect(md.length).toBeLessThan(8000);
    // a long skip list is summarised, never dumped
    const many = aiDigest(
      build({
        meta: { git, runner, ollama: ollamaUp },
        stages: [stage('ollama', 'SKIP', { skippedTests: Array.from({ length: 40 }, (_, i) => `live › test ${i}`) })],
        guards: null,
        startedAt: 0,
        finishedAt: 1000,
      }),
    );
    const mdMany = aiDigestMd(many);
    expect(mdMany).toContain('weitere');
    for (let i = 10; i < 40; i++) expect(mdMany).not.toContain(`live › test ${i}`);
  });
});

describe('Arena order — latest-arena-task.md', () => {
  const failing = () =>
    build({
      meta: {
        git,
        runner,
        ollama: { ...ollamaUp, reachable: false },
        changedFiles: ['src/main/app.ts'],
        previousTestedSha: 'b'.repeat(40),
      },
      stages: [
        stage('typecheck', 'PASS'),
        stage('unit', 'FAIL', {
          failedTests: ['chat turn › streams deltas'],
          errors: ['AssertionError: expected 2 to be 3 at src/main/app.ts:120'],
          artifacts: ['test-results/unit.png'],
        }),
        stage('e2e', 'FAIL', { errors: ['Timeout 30000ms exceeded'], artifacts: ['test-results/trace.zip'] }),
      ],
      guards: { attempt: 1, maxAttempts: 3, stop: false, reasons: [], cycleId: 'cycle-9', fingerprint: 'fff999', repeats: 1 },
      startedAt: 0,
      finishedAt: 60_000,
    });

  it('contains every section the coding agent is supposed to work from', () => {
    const md = arenaTask(failing(), {
      analysis: {
        final: {
          category: 'code_defect',
          confidence: 0.7,
          component: 'unit',
          file: 'src/main/app.ts',
          observation: 'unit stage red',
          probableCause: 'streaming assertion drifted',
          recommendedFix: 'fix the streaming assertion',
          source: 'heuristic',
        },
        ai: { modelId: 'ollama:qwen3', answer: 'x' },
      },
      baselineFailures: ['memory › persist'],
    });
    for (const section of [
      '## Problem',
      '## Reproduktion',
      '## Expected',
      '## Actual',
      '## Betroffene Tests',
      '## Relevante Dateien',
      '## Relevante Logs',
      '## Trace / Screenshot',
      '## Wahrscheinliche Ursache',
      '## Gewünschtes Verhalten',
      '## Einschränkungen',
      '## Regressionstest-Anforderung',
      '## Loop-Status',
    ]) {
      expect(md, `Abschnitt ${section} fehlt`).toContain(section);
    }
    expect(md).toContain('src/main/app.ts');
    expect(md).toContain('test-results/trace.zip');
    expect(md).toContain('chat turn › streams deltas');
    expect(md).toContain('code_defect');
    expect(md).toContain('Bereits vorher rot');
    expect(md).toContain('npm run test:autonomous');
    expect(md).toContain('git clone'); // a URL one can actually clone, never a placeholder
    expect(md).toContain('Regressionstest');
    // bounded: the order is a briefing, not a log dump
    expect(md.length).toBeLessThan(12_000);
  });

  it('is explicit when the cause is the environment, so nobody "fixes" working code', () => {
    const report = build({
      meta: { git, runner, ollama: { ...ollamaUp, reachable: false } },
      stages: [stage('smoke', 'INFRASTRUCTURE_ERROR', { errors: ['Electron-Dist fehlt'] })],
      guards: {
        attempt: 1,
        maxAttempts: 3,
        stop: true,
        reasons: ['infrastructure_error'],
        cycleId: 'cycle-10',
        fingerprint: 'iii111',
        repeats: 1,
      },
      startedAt: 0,
      finishedAt: 1000,
    });
    const md = arenaTask(report, { analysis: null });
    expect(md).toContain('Umgebungsvoraussetzung');
    expect(md).toContain('keine** Codeänderung');
    expect(md).toContain('**Automatik gestoppt**');
    expect(md).toContain('infrastructure_error');
    // without an analysis the order must say it is missing, not invent one
    expect(md).toContain('npm run analyze:failure');
  });
});

describe('loop wiring (single source of truth)', () => {
  it('exposes the loop through npm scripts and the Playwright dev dependency', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.scripts['test:autonomous']).toBe('node scripts/autonomous-test.mjs');
    expect(pkg.scripts['test:e2e']).toBe('playwright test');
    expect(pkg.scripts['analyze:failure']).toBe('node scripts/analyze-failure.mjs');
    expect(pkg.scripts['feedback:pull']).toBe('node scripts/feedback-pull.mjs');
    expect(pkg.devDependencies['@playwright/test']).toBeTruthy();
    // the loop must not replace the existing entry points
    expect(pkg.scripts.test).toBe('vitest run');
    expect(pkg.scripts.smoke).toContain('LPAI_SMOKE=1');
  });

  const onBlock = (yaml: string): string => /^on:\n((?:[ \t].*\n|\n)*)/m.exec(yaml)?.[1] ?? '';

  it('keeps the self-hosted runner unreachable from pull requests (security invariant)', () => {
    const wf = read('.github/workflows/autonomous-test.yml');
    const triggers = onBlock(wf);
    expect(wf).toContain('runs-on: [self-hosted, Windows, X64, lpai-test]');
    expect(wf).toContain("if: github.repository == 'Kaiserkatze1234/local-personal-ai'");
    expect(wf).toContain('npm run test:autonomous');
    expect(wf).toContain('actions/upload-artifact');
    expect(wf).toContain('lpai-test-reports');
    // the decisive invariant: no PR-triggered path onto the user's PC
    expect(triggers).toContain('push:');
    expect(triggers).not.toContain('pull_request');
    expect(triggers).not.toContain('repository_dispatch');
    // and no secrets handed to the test job
    expect(wf).not.toContain('secrets.');
  });

  it('keeps fork PRs on hosted runners with the fast checks', () => {
    const wf = read('.github/workflows/pull-request-ci.yml');
    expect(onBlock(wf)).toContain('pull_request:');
    expect(wf).toContain('runs-on: ubuntu-latest');
    // the jobs section must never ask for the self-hosted labels
    const jobs = wf.slice(wf.indexOf('jobs:'));
    expect(jobs).not.toContain('self-hosted');
    expect(jobs).not.toContain('lpai-test');
    expect(wf).toContain('npm test');
  });

  it('ships the Windows install/remove helpers with the labels the workflow expects', () => {
    const install = read('scripts/windows/install-runner.ps1');
    expect(install).toContain('--labels');
    expect(install).toContain('lpai-test');
    expect(install).toContain('registration-token');
    expect(install).toContain('New-ScheduledTaskAction');
    expect(read('scripts/windows/remove-runner.ps1')).toContain('remove-token');
  });

  it('runs E2E serially, retries nothing, and keeps artifacts in one place', () => {
    const cfg = read('playwright.config.ts');
    expect(cfg).toContain('workers: 1');
    expect(cfg).toContain('retries: 0');
    expect(cfg).toContain('fullyParallel: false');
    expect(cfg).toContain('test-reports/e2e-artifacts');
    expect(cfg).toContain('e2e-results.json');
  });

  it('keeps the generated reports out of git and the specs away from production data', () => {
    const ignore = read('.gitignore');
    expect(ignore).toContain('test-reports/*');
    expect(ignore).toContain('!test-reports/.gitkeep');
    for (const spec of [
      'tests/e2e/startup.spec.ts',
      'tests/e2e/chat.spec.ts',
      'tests/e2e/memory-context.spec.ts',
      'tests/e2e/tasks.spec.ts',
      'tests/e2e/real-ollama.spec.ts',
    ]) {
      const src = read(spec);
      expect(src, `${spec} darf den Produktionspfad nicht selbst anfassen`).not.toContain('process.env.APPDATA');
      expect(src, `${spec} darf sich keinen eigenen Datenordner bauen`).not.toContain('mkdtempSync');
      expect(src, `${spec} muss über die Harness isolieren`).toContain("from './harness.js'");
    }
    // isolation is switched by the documented env var, honoured by the Electron entry
    expect(read('src/main/index.ts')).toContain('process.env[DATA_DIR_ENV] ?? join(app.getPath');
    expect(read('tests/e2e/harness.ts')).toContain('LPAI_DATA_DIR: dataDir');
  });

  it('publishes both handoff artefacts and keeps the digest readable without an artifact download', () => {
    const wf = read('.github/workflows/autonomous-test.yml');
    // the two audiences must both be published
    expect(wf).toContain('name: lpai-ai-handoff');
    expect(wf).toContain('test-reports/latest-chatgpt.json');
    expect(wf).toContain('test-reports/latest-arena-task.md');
    // the PR comment carries the compact digest, so an analyzing instance that
    // can only read the pull request still sees the whole run
    expect(wf).toContain('latest-chatgpt.md');
    expect(wf).toContain('<details>');
    // and it stays bounded — a comment is not a log dump
    expect(wf).toContain("readFileSync('test-reports/latest-chatgpt.md', 'utf8')");
    expect(wf).toMatch(/digest\.slice\(0, \d{4}\)/);

    const orch = read('scripts/autonomous-test.mjs');
    expect(orch).toContain("writeFileSync(join(CFG.outDir, 'latest-chatgpt.json')");
    expect(orch).toContain("writeFileSync(join(CFG.outDir, 'latest-arena-task.md')");
    // a green run must not leave a repair order from an older run behind
    expect(orch).toContain("rmSync(join(CFG.outDir, 'latest-arena-task.md'), { force: true })");

    const analyzer = read('scripts/analyze-failure.mjs');
    expect(analyzer).toContain("'latest-chatgpt.json'");
    expect(analyzer).toContain("'latest-arena-task.md'");

    const pull = read('scripts/feedback-pull.mjs');
    expect(pull).toContain('lpai-ai-handoff');
    expect(pull).toContain("join(artifactDir, 'latest-arena-task.md')");
    expect(pull).toContain("writeFileSync(join(inbox, 'ARENA-TASK.md')");
  });

  it('wires the offline failure analysis into the orchestrator without a model dependency for normal runs', () => {
    const orch = read('scripts/autonomous-test.mjs');
    expect(orch).toContain('failureAnalysis.ts');
    expect(orch).toContain("report.verdict !== 'PASS'");
    expect(orch).toContain('prepareAnalysisDataDir');
    expect(orch).toContain('no-ai-analysis');
    // --ci must be strict about declared devDependencies (no silent SKIP in CI)
    expect(orch).toContain("CFG.ci ? 'INFRASTRUCTURE_ERROR'");
    expect(existsSync(join(REPO, 'src/main/diagnostics/failureAnalysis.ts'))).toBe(true);
    // the analysis runs against a COPY of the real data dir, never the original
    expect(orch).toContain('cpSync(f, join(dst, name))');
  });
});
