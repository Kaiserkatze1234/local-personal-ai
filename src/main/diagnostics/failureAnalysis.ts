/**
 * Failure analysis for the autonomous test loop (development/test
 * infrastructure — deliberately kept out of every product feature path).
 *
 * Two layers, in this order:
 *
 *   1. DETERMINISTIC classification: pattern rules over the failing stages'
 *      exit codes and trimmed error lines. This is what the fix prompt is
 *      built from, always — a plain `npm test` never touches a model, and an
 *      analysis is only ever requested when something actually failed.
 *   2. LOCAL MODEL (optional): only consulted when the deterministic pass is
 *      not decisive (unknown category or low confidence). It goes through the
 *      SAME ModelRouter/ModelRoleService/Capability path the product uses —
 *      role `review`, light task class, `preferSmall` — so an embedding-only
 *      model can never be picked (the router requires `text_generation`).
 *      The model gets a bounded digest (failing test, expected vs actual,
 *      stack excerpt, relevant files, small diff slice), never the repo.
 *
 * Honesty rules (the reason this file is full of small functions):
 *   - a red check is never presented as a code defect unless the evidence says
 *     so; infrastructure/provider problems keep their own category,
 *   - an AI answer that does not parse or invents a category is discarded,
 *   - every result carries where it came from (heuristics vs model) and a
 *     confidence, so the report can say "probably" where it means probably.
 */

import { readFileSync } from 'node:fs';
import type { ModelRole } from '../../shared/types/capabilities.js';
import { CoreApp } from '../app.js';

export type FailureCategory =
  | 'code_defect'
  | 'regression'
  | 'test_defect'
  | 'build_defect'
  | 'ui_defect'
  | 'infrastructure'
  | 'runtime_provider'
  | 'preexisting_unrelated'
  | 'unknown';

export const ALL_FAILURE_CATEGORIES: FailureCategory[] = [
  'code_defect',
  'regression',
  'test_defect',
  'build_defect',
  'ui_defect',
  'infrastructure',
  'runtime_provider',
  'preexisting_unrelated',
  'unknown',
];

/** Subset of test-reports/latest.json this module needs. */
export interface ReportStage {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP' | 'INFRASTRUCTURE_ERROR';
  exitCode?: number | null;
  durationMs?: number;
  errors?: string[];
  failedTests?: string[];
  artifacts?: string[];
  note?: string;
}

export interface ReportLike {
  verdict: 'PASS' | 'FAIL' | 'SKIP' | 'INFRASTRUCTURE_ERROR';
  commit?: string;
  branch?: string;
  stages?: ReportStage[];
}

export interface HeuristicVerdict {
  category: FailureCategory;
  probableCause: string;
  component: string;
  file?: string;
  observation: string;
  recommendedFix: string;
  confidence: number;
  evidence: string[];
}

export interface AiVerdict extends HeuristicVerdict {
  modelId: string;
  providerId: string;
  role: string;
}

export interface AnalysisResult {
  analyzedAt: string;
  commit?: string;
  branch?: string;
  heuristic: HeuristicVerdict;
  ai: AiVerdict | null;
  final: HeuristicVerdict & { source: 'heuristic' | 'heuristic+ai' };
  aiRequested: boolean;
  aiSkipReason?: string;
  aiError?: string;
  promptChars: number;
}

export interface DiffInfo {
  /** `git diff --stat` (short, capped by the caller). */
  stat?: string;
  /** changed file paths (capped by the caller) */
  files?: string[];
  /** small unified diff excerpt for the files that look related */
  excerpt?: string;
  /** previous tested commit, when known */
  base?: string;
}

export interface AnalysisOptions {
  reportPath: string;
  /** real data dir with the user's providers/models; the loop passes it through */
  dataDir?: string;
  diff?: DiffInfo;
  /** failing tests from a previous cycle — used to recognize pre-existing failures */
  baselineFailures?: string[];
  /** use the local model when the heuristic pass is not decisive */
  useAi?: boolean;
  /** abort the model call after this long */
  aiTimeoutMs?: number;
  /** hard cap for the prompt sent to the model */
  maxPromptChars?: number;
}

const INFRA_PATTERNS: RegExp[] = [
  /\bENOENT\b/,
  /\bEACCES\b/,
  /\bEPERM\b/,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /socket hang up/i,
  /Client network socket disconnected/i,
  /unable to verify the first certificate/i,
  /no prebuilt|prebuild-install/i,
  /NODE_MODULE_VERSION/,
  /rebuild:native/,
  /cannot find module|ERR_MODULE_NOT_FOUND|module not found/i,
  /Timed out|timeout of \d+ms exceeded|Test timed out/i,
  /ETXTBSY|spawn .* ENOENT/i,
  /no space left|disk full/i,
];

const PROVIDER_PATTERNS: RegExp[] = [
  /11434/,
  /ollama/i,
  /api\/chat/i,
  /No text-generation model is available/i,
  /provider .*unhealthy/i,
  /No installed model supports/i,
];

const UI_PATTERNS: RegExp[] = [
  /locator\(|getByRole|getByTestId|waiting for/i,
  /Target (page|closed)|browser has been closed/i,
  /Electron failed to (launch|install)/i,
  /page crashed|renderer process/i,
  /did-fail-load/i,
  /SMOKE_FAIL/,
];

const BUILD_PATTERNS: RegExp[] = [
  /error TS\d+/,
  /failed to resolve|vite build/i,
  /esbuild/i,
  /\brolldown\b/i,
  /Cannot find name/i,
  /TS\d{4}:/,
];

const ASSERT_PATTERNS: RegExp[] = [
  /AssertionError/i,
  /expected .* to (be|equal|contain|match|throw)/i,
  /\bAssertionError\b/,
  /Received:/,
  /toEqual|toBe\(|toMatch|toContain/,
];

function firstMatch(patterns: readonly RegExp[], text: string): string | null {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** ANSI colour codes (built at runtime: raw ESC in source trips the linter and reads terribly). */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Keep only what a human needs to understand the failure — never whole logs. */
export function trimError(line: string, max = 500): string {
  const one = line.replace(ANSI_ESCAPE, '').replace(/\s+$/g, '');
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** The most informative error lines of a stage: first, last, and TS/stack lines. */
export function stageEvidence(stage: ReportStage, max = 6): string[] {
  const all = (stage.errors ?? []).map((e) => trimError(e)).filter((e) => e.length > 0);
  if (all.length <= max) return all;
  const interesting = all.filter((l) => /error|fail|expected|received|throw|denied|refused|timeout|ENOENT|TS\d{4}/i.test(l));
  const last = all.at(-1);
  const picked = [...all.slice(0, 2), ...interesting.slice(0, Math.max(0, max - 3)), ...(last ? [last] : [])];
  return [...new Set(picked)].slice(0, max);
}

/** Files worth showing the model: whatever the errors mention, else the diff. */
export function relevantFiles(stage: ReportStage, diffFiles: readonly string[] = [], max = 8): string[] {
  const mentioned = new Set<string>();
  for (const e of stage.errors ?? []) {
    for (const m of e.matchAll(/([\w./@-]+\.(?:ts|tsx|mjs|cjs|js|json|yml|yaml|ps1|md))(?::\d+)?/g)) {
      const hit = m[1];
      if (hit) mentioned.add(hit.replace(/\\/g, '/'));
    }
  }
  const hits = [...mentioned].filter((f) => !f.includes('node_modules'));
  const rest = diffFiles.filter((f) => !hits.includes(f));
  return [...hits, ...rest].slice(0, max);
}

/**
 * Deterministic classification. Ordered from "definitely not the app's logic"
 * to "probably the app's logic" — an environment problem must never be
 * reported as a code defect (that is exactly the class of mis-reporting the
 * loop must not produce).
 */
export function classifyStage(stage: ReportStage, ctx: { baselineFailures?: string[]; diff?: DiffInfo } = {}): HeuristicVerdict {
  const text = [...(stage.errors ?? []), stage.note ?? '', ...(stage.failedTests ?? [])].join('\n');
  const failed = stage.failedTests ?? [];
  const base = ctx.baselineFailures ?? [];
  const inherited = failed.filter((t) => base.includes(t));

  if (inherited.length > 0 && inherited.length === failed.length && failed.length > 0) {
    return {
      category: 'preexisting_unrelated',
      probableCause: 'These tests already failed before the current change — the change did not introduce them.',
      component: stage.name,
      observation: `Failing tests unchanged from the previous cycle: ${inherited.slice(0, 5).join(', ')}`,
      recommendedFix: 'Leave them to the responsible change; do not paper over them inside this cycle.',
      confidence: 0.75,
      evidence: inherited.slice(0, 5),
    };
  }

  if (stage.status === 'INFRASTRUCTURE_ERROR') {
    const hit = firstMatch(INFRA_PATTERNS, text);
    return {
      category: hit && /ollama|11434|api\/chat/i.test(hit) ? 'runtime_provider' : 'infrastructure',
      probableCause: `The stage could not run to completion: ${hit ?? 'environment/tooling precondition failed'}`,
      component: stage.name,
      observation: stage.note ?? stage.errors?.[0] ?? 'stage reported INFRASTRUCTURE_ERROR',
      recommendedFix:
        'Fix the environment (runtime installed? model pulled? native binding built? disk space?), then re-run — this is not a code fix.',
      confidence: 0.8,
      evidence: stageEvidence(stage),
    };
  }

  const providerHit = firstMatch(PROVIDER_PATTERNS, text);
  if (providerHit && !firstMatch(BUILD_PATTERNS, text)) {
    return {
      category: 'runtime_provider',
      probableCause: `Runtime/provider problem ("${providerHit}") — the app logic was not reached.`,
      component: stage.name,
      observation: providerHit,
      recommendedFix: 'Start the provider (e.g. Ollama) and pull a chat-capable model; do not "fix" application code for this.',
      confidence: 0.7,
      evidence: stageEvidence(stage),
    };
  }

  if (stage.name === 'typecheck' || (firstMatch(BUILD_PATTERNS, text) && stage.name !== 'e2e')) {
    const file = relevantFiles(stage, ctx.diff?.files)[0];
    return {
      category: 'build_defect',
      probableCause: 'Compilation/bundling error — the sources do not build.',
      component: stage.name,
      file,
      observation:
        (stage.errors ?? [])
          .map((e) => trimError(e, 240))
          .slice(0, 2)
          .join(' | ') || 'build failed',
      recommendedFix:
        'Fix the reported compile/bundle error in the named file; add a regression test only if behavior was wrong, not for a pure type error.',
      confidence: 0.8,
      evidence: stageEvidence(stage),
      ...(file ? { file } : {}),
    };
  }

  const infraHit = firstMatch(INFRA_PATTERNS, text);
  if (infraHit) {
    return {
      category: 'infrastructure',
      probableCause: `Environment/tooling failure: "${infraHit}"`,
      component: stage.name,
      observation: infraHit,
      recommendedFix: 'Repair the environment precondition; a code change cannot fix this — a repeated occurrence must stop the loop.',
      confidence: 0.7,
      evidence: stageEvidence(stage),
    };
  }

  const uiHit = firstMatch(UI_PATTERNS, text);
  if (uiHit) {
    return {
      category: 'ui_defect',
      probableCause: `UI/Electron behavior mismatch: "${uiHit}"`,
      component: stage.name,
      file: relevantFiles(stage, ctx.diff?.files)[0],
      observation: uiHit,
      recommendedFix:
        'Reproduce with the saved trace/screenshot, fix the UI or the IPC contract it depends on, and keep the failing scenario as a regression test.',
      confidence: 0.6,
      evidence: stageEvidence(stage),
    };
  }

  if (firstMatch(ASSERT_PATTERNS, text) || failed.length > 0) {
    const file = relevantFiles(stage, ctx.diff?.files)[0];
    const knownBase = base.length > 0;
    return {
      category: knownBase ? 'regression' : 'code_defect',
      probableCause: 'A test that exercises real behavior failed — most likely a behavior regression introduced by the recent change.',
      component: stage.name,
      file,
      observation: failed.slice(0, 5).join(', ') || trimError(stage.errors?.[0] ?? 'assertion failed', 300),
      recommendedFix:
        'Find the behavior the test asserts, restore it at the source (not in the test), and keep the failing scenario as a regression test.',
      confidence: 0.6,
      evidence: stageEvidence(stage),
      ...(file ? { file } : {}),
    };
  }

  return {
    category: 'unknown',
    probableCause: 'Not enough structured evidence to classify this failure.',
    component: stage.name,
    observation: trimError(stage.errors?.[0] ?? 'no captured error line', 300),
    recommendedFix: 'Inspect the artifact bundle (traces, logs) for this stage; the local model analysis may narrow it down.',
    confidence: 0.2,
    evidence: stageEvidence(stage),
  };
}

/** The first failing stage is the one worth fixing first (stages run in order). */
export function pickFailingStage(report: ReportLike): ReportStage | null {
  const stages = report.stages ?? [];
  return stages.find((s) => s.status === 'FAIL') ?? stages.find((s) => s.status === 'INFRASTRUCTURE_ERROR') ?? null;
}

export function classifyReport(report: ReportLike, ctx: { baselineFailures?: string[]; diff?: DiffInfo } = {}): HeuristicVerdict {
  const stage = pickFailingStage(report);
  if (!stage) {
    return {
      category: 'unknown',
      probableCause: 'No failing stage found in the report.',
      component: 'report',
      observation: `verdict=${report.verdict}`,
      recommendedFix: 'Nothing to fix.',
      confidence: 0,
      evidence: [],
    };
  }
  return classifyStage(stage, ctx);
}

export interface AnalysisPrompt {
  system: string;
  user: string;
  chars: number;
}

/**
 * Bounded digest prompt. Everything is capped: the loop must stay cheap on a
 * 16 GB machine and the model must not be handed the repository.
 */
export function buildAnalysisPrompt(
  report: ReportLike,
  stage: ReportStage,
  ctx: { diff?: DiffInfo; baselineFailures?: string[]; maxChars?: number } = {},
): AnalysisPrompt {
  const maxChars = ctx.maxChars ?? 6000;
  const files = relevantFiles(stage, ctx.diff?.files ?? []);
  const evidence = stageEvidence(stage, 6);
  const system = [
    'You are a senior engineer diagnosing one failing test stage of a local Electron/TypeScript project.',
    'You never guess silently: if the evidence is not enough, answer category "unknown" with low confidence.',
    'Distinguish clearly between: code_defect (app logic wrong), regression (worked before, broken now), test_defect (the test itself is wrong), build_defect (compile/bundle), ui_defect (Electron/renderer behavior), infrastructure (environment/tooling), runtime_provider (local model server unreachable/unusable), preexisting_unrelated (already broken before this change).',
    'Answer with ONE JSON object, no markdown fence, keys exactly:',
    '{"category":string,"probableCause":string,"component":string,"file":string,"observation":string,"recommendedFix":string,"confidence":number,"regressionTest":string}',
    'confidence is 0..1. regressionTest is the one test you would add (or "none needed"). Keep every string under 400 characters.',
  ].join(' ');

  const parts: string[] = [];
  parts.push(`Repo: local-personal-ai (branch ${report.branch ?? '?'} @ ${(report.commit ?? '?').slice(0, 10)})`);
  parts.push(
    `Failing stage: ${stage.name} (status ${stage.status}${stage.exitCode !== undefined && stage.exitCode !== null ? `, exit ${stage.exitCode}` : ''})`,
  );
  if (stage.failedTests && stage.failedTests.length > 0) parts.push(`Failing tests:\n- ${stage.failedTests.slice(0, 8).join('\n- ')}`);
  parts.push(`Captured error lines:\n${evidence.map((e) => `  ${e}`).join('\n')}`);
  if (files.length > 0) parts.push(`Files named in the errors / recent change:\n- ${files.join('\n- ')}`);
  if (ctx.diff?.base) parts.push(`Diff base (last green commit): ${ctx.diff.base}`);
  if (ctx.diff?.stat) parts.push(`git diff --stat (truncated):\n${ctx.diff.stat}`);
  if (ctx.diff?.excerpt) parts.push(`Diff excerpt:\n${ctx.diff.excerpt}`);
  if (ctx.baselineFailures && ctx.baselineFailures.length > 0) {
    parts.push(`Tests already failing in the previous cycle (NOT caused by this change): ${ctx.baselineFailures.slice(0, 8).join(', ')}`);
  }
  if (stage.artifacts && stage.artifacts.length > 0) parts.push(`Artifacts on disk: ${stage.artifacts.slice(0, 6).join(', ')}`);

  let user = parts.join('\n\n');
  if (user.length > maxChars) user = `${user.slice(0, maxChars)}\n…(truncated)`;
  return { system, user, chars: system.length + user.length };
}

/** Tolerant JSON extraction: the model may wrap it, chat around it, or use a fence. */
export function parseAnalysisResponse(text: string, modelId: string, providerId: string, role: string): AiVerdict | null {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const category = String(raw.category ?? '') as FailureCategory;
  if (!ALL_FAILURE_CATEGORIES.includes(category)) return null;
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.slice(0, 600) : fallback);
  const num = typeof raw.confidence === 'number' ? raw.confidence : Number.parseFloat(String(raw.confidence ?? ''));
  const confidence = Number.isFinite(num) ? Math.min(1, Math.max(0, num)) : 0.3;
  return {
    category,
    probableCause: str(raw.probableCause, 'model returned no cause'),
    component: str(raw.component, 'unknown'),
    file: str(raw.file) || undefined,
    observation: str(raw.observation),
    recommendedFix: str(raw.recommendedFix) || str(raw.regressionTest, 'inspect artifacts'),
    confidence,
    evidence: [],
    modelId,
    providerId,
    role,
  };
}

/** Load a report file defensively — a broken report must not break the loop. */
export function loadReport(path: string): ReportLike {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ReportLike;
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return { ...parsed, verdict: parsed.verdict ?? 'FAIL', stages: parsed.stages ?? [] };
  } catch (err) {
    return {
      verdict: 'FAIL',
      stages: [
        {
          name: 'report',
          status: 'INFRASTRUCTURE_ERROR',
          errors: [`could not read ${path}: ${(err as Error).message}`],
          note: 'the orchestrator report is missing or unreadable',
        },
      ],
    };
  }
}

/**
 * Ask the local model through the product's own routing stack. Role `review`
 * because the task IS a review; task class `classification` + preferSmall so a
 * 16 GB laptop answers with the smallest capable model instead of the biggest.
 */
export async function askLocalModel(opts: {
  dataDir: string;
  prompt: AnalysisPrompt;
  timeoutMs: number;
}): Promise<{ verdict: AiVerdict | null; reason?: string; error?: string }> {
  let app: CoreApp | null = null;
  try {
    app = new CoreApp({ dataDir: opts.dataDir, timers: false });
    await app.boot();
    await app.providers.refreshAll();
    const role: ModelRole = 'review';
    const decision = app.router.select(role, 'classification', { preferSmall: true });
    const { provider, model } = app.providers.chatFor(decision.modelId);
    if (!provider.adapter.chat) return { verdict: null, reason: `provider ${provider.id} has no chat interface` };
    const res = await provider.adapter.chat.generate({
      modelId: model.id,
      messages: [
        { role: 'system', content: opts.prompt.system },
        { role: 'user', content: opts.prompt.user },
      ],
      temperature: 0.1,
      maxTokens: 700,
      keepAliveSec: 0, // free RAM/VRAM right after the analysis (§56)
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const verdict = parseAnalysisResponse(res.text, model.id, provider.id, role);
    if (!verdict) return { verdict: null, reason: 'model answer was not usable JSON', error: trimError(res.text, 200) };
    return { verdict };
  } catch (err) {
    return { verdict: null, error: (err as Error).message };
  } finally {
    try {
      await app?.dispose();
    } catch {
      /* best effort — the analysis must never leave a process behind */
    }
  }
}

/** Full pass: heuristic always, model only when it adds information. */
export async function analyzeFailure(o: AnalysisOptions): Promise<AnalysisResult> {
  const report = loadReport(o.reportPath);
  const ctx = { baselineFailures: o.baselineFailures, diff: o.diff };
  const heuristic = classifyReport(report, ctx);
  const stage = pickFailingStage(report);
  const prompt = stage
    ? buildAnalysisPrompt(report, stage, { diff: o.diff, baselineFailures: o.baselineFailures, maxChars: o.maxPromptChars ?? 6000 })
    : { system: '', user: '', chars: 0 };

  const out: AnalysisResult = {
    analyzedAt: new Date().toISOString(),
    commit: report.commit,
    branch: report.branch,
    heuristic,
    ai: null,
    final: { ...heuristic, source: 'heuristic' },
    aiRequested: Boolean(o.useAi),
    promptChars: prompt.chars,
  };

  // only ask the model when the deterministic pass is not already decisive
  if (!o.useAi) {
    out.aiSkipReason = 'AI analysis not requested';
    return out;
  }
  if (!stage) {
    out.aiSkipReason = 'no failing stage';
    return out;
  }
  if (heuristic.category === 'infrastructure' || heuristic.category === 'runtime_provider') {
    out.aiSkipReason = `deterministic evidence is decisive (${heuristic.category}) — no model call needed`;
    return out;
  }
  if (!o.dataDir) {
    out.aiSkipReason = 'no data dir given';
    return out;
  }

  const answer = await askLocalModel({ dataDir: o.dataDir, prompt, timeoutMs: o.aiTimeoutMs ?? 120_000 });
  if (!answer.verdict) {
    out.aiError = answer.error ?? answer.reason ?? 'model gave no usable answer';
    return out;
  }
  out.ai = answer.verdict;
  // The model may sharpen the picture (or correct the heuristics). It cannot
  // downgrade a decisive environment verdict into a code defect: infrastructure
  // and runtime_provider never reach the model at all (early return above).
  const keepHeuristic = heuristic.confidence >= 0.75 && heuristic.category === out.ai.category;
  out.final = {
    ...(keepHeuristic
      ? heuristic
      : {
          ...heuristic,
          ...out.ai,
          confidence: Math.max(heuristic.confidence, out.ai.confidence),
          evidence: heuristic.evidence,
        }),
    source: 'heuristic+ai',
  };
  return out;
}
