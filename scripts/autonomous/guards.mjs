/**
 * Loop protection for the autonomous repair cycle.
 *
 * The cycle is: push → Windows runner tests → FAIL → analysis → fix prompt →
 * Arena fixes → push → … . Nothing in this file decides *how* to fix anything;
 * it only decides whether the loop is allowed to continue automatically, and
 * it must be able to say "stop" for every one of these reasons:
 *
 *   max_attempts_reached   more than `maxAttempts` rounds for the same change
 *   repeated_failure       the identical failure keeps coming back (same fingerprint)
 *   infrastructure_error   the environment is broken (no point looping on code)
 *   ollama_unavailable     a runtime test was required but no local runtime answered
 *   tests_regressed        the failure set grew — the change made things worse
 *   dangerous_change       the diff touches the loop's own machinery (workflows,
 *                          runner scripts, the orchestrator) — that needs a human
 *
 * State is a plain JSON file (`test-reports/cycle-state.json`), restored/saved
 * by the workflow, so a fresh checkout on the runner still knows what happened
 * in the previous round.
 */

import { createHash } from 'node:crypto';

export const CYCLE_STATE_SCHEMA = 1;

/** files whose modification stops the automatic loop (they *are* the loop) */
export const DANGEROUS_PATHS = [
  /^\.github\/workflows\//,
  /^scripts\/autonomous/,
  /^scripts\/windows\//,
  /^playwright\.config\./,
  /^scripts\/analyze-failure/,
  /^scripts\/feedback-pull/,
];

/**
 * @typedef {object} CycleState
 * @property {number} schema
 * @property {string|null} cycleId
 * @property {number} attempts
 * @property {number} maxAttempts
 * @property {string|null} lastVerdict
 * @property {string|null} lastTestedSha
 * @property {string|null} lastGoodSha
 * @property {string[]} baselineFailures
 * @property {{hash:string,count:number,firstSeen?:string,failingStages?:string[],lastCommit?:string}[]} fingerprints
 * @property {object[]} history
 * @property {boolean} stopped
 * @property {string[]} stopReasons
 */

/**
 * @returns {CycleState}
 */
export function emptyState() {
  return {
    schema: CYCLE_STATE_SCHEMA,
    cycleId: null,
    attempts: 0,
    maxAttempts: 3,
    lastVerdict: null,
    lastTestedSha: null,
    lastGoodSha: null,
    baselineFailures: [],
    fingerprints: [],
    history: [],
    stopped: false,
    stopReasons: [],
  };
}

/**
 * @param {string|null|undefined} sha
 * @returns {string|null}
 */
export function shortSha(sha) {
  return typeof sha === 'string' && sha.length >= 7 ? sha.slice(0, 7) : (sha ?? null);
}

/** A cycle is bound to one starting commit so "attempts" cannot leak across changes. */
/**
 * @param {string|null|undefined} commit
 * @returns {string}
 */
export function cycleIdFor(commit) {
  return `cycle-${createHash('sha1')
    .update(String(commit ?? 'unknown'))
    .digest('hex')
    .slice(0, 10)}`;
}

/**
 * @param {unknown} raw
 * @returns {CycleState}
 */
export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    fingerprints: Array.isArray(raw.fingerprints) ? raw.fingerprints : [],
    history: Array.isArray(raw.history) ? raw.history : [],
    baselineFailures: Array.isArray(raw.baselineFailures) ? raw.baselineFailures : [],
    stopReasons: Array.isArray(raw.stopReasons) ? raw.stopReasons : [],
  };
}

/**
 * @param {string[]|undefined} files
 * @returns {string[]}
 */
export function dangerousChangedFiles(files) {
  return (files ?? []).filter((f) => DANGEROUS_PATHS.some((re) => re.test(String(f).replace(/\\/g, '/'))));
}

/**
 * @param {object} p
 * @param {object} p.previous   state from the last round (or null)
 * @param {object} p.report     the report just produced (needs verdict, summary, git)
 * @param {string} p.fingerprint
 * @param {object} [p.opts]     { maxAttempts, requireOllama, ollamaReachable, changedFiles, environmentErrors }
 * @returns {{state:object, stop:boolean, reasons:string[], attempt:number, resolved:boolean}}
 */
/**
 * @param {{previous?:unknown, report:object, fingerprint:string, opts?:{maxAttempts?:number, requireOllama?:boolean, ollamaReachable?:boolean, changedFiles?:string[], environmentErrors?:number}}} input
 * @returns {{state:CycleState, stop:boolean, reasons:string[], attempt:number, resolved:boolean}}
 */
export function evaluateGuards({ previous, report, fingerprint, opts = {} }) {
  const maxAttempts = Number.isFinite(opts.maxAttempts) && opts.maxAttempts > 0 ? Math.floor(opts.maxAttempts) : 3;
  const prev = normalizeState(previous);
  const commit = report?.git?.commit ?? null;
  // A cycle spans consecutive failing rounds (each round usually brings a new
  // commit — that is the fix). It ends — and everything resets — on PASS.
  const continuing = prev.lastVerdict === 'FAIL' || prev.lastVerdict === 'INFRASTRUCTURE_ERROR';
  const cycleId = continuing && prev.cycleId ? prev.cycleId : cycleIdFor(commit);

  const failingStages = (report?.stages ?? []).filter((s) => s.status === 'FAIL').map((s) => s.name);
  const infraStages = (report?.stages ?? []).filter((s) => s.status === 'INFRASTRUCTURE_ERROR').map((s) => s.name);
  const failedTests = report?.summary?.failedTests ?? [];
  const verdict = report?.verdict ?? 'FAIL';

  const historyEntry = {
    at: new Date().toISOString(),
    runId: report?.runner?.githubRunId ?? null,
    commit,
    verdict,
    fingerprint: verdict === 'PASS' ? null : fingerprint,
    failingStages,
    infraStages,
    failedTests: failedTests.slice(0, 20),
  };

  // ---- PASS: the cycle ends here; everything is reset for the next change ----
  if (verdict === 'PASS') {
    const state = {
      ...emptyState(),
      maxAttempts,
      lastVerdict: 'PASS',
      lastCommit: commit,
      lastTestedSha: commit,
      lastGoodSha: commit,
      history: [...prev.history, historyEntry].slice(-20),
      cycleId: null,
      fingerprints: [],
      baselineFailures: [],
      stopped: false,
      stopReasons: [],
    };
    return { state, stop: false, reasons: [], attempt: 0, resolved: true };
  }

  // ---- FAIL / INFRASTRUCTURE_ERROR: count rounds and look for stop signals ----
  const attempts = (continuing && prev.cycleId ? prev.attempts : 0) + 1;
  const reasons = [];

  const fingerprintEntry = prev.fingerprints.find((f) => f.hash === fingerprint) ?? null;
  const repeats = (fingerprintEntry?.count ?? 0) + 1;

  if (attempts > maxAttempts) reasons.push('max_attempts_reached');
  if (repeats >= 3) reasons.push('repeated_failure');
  if (infraStages.length > 0 || (opts.environmentErrors ?? 0) > 0) reasons.push('infrastructure_error');
  if (opts.requireOllama === true && opts.ollamaReachable === false) reasons.push('ollama_unavailable');

  const prevFailing = new Set(prev.history.filter((h) => h.verdict !== 'PASS').slice(-1)[0]?.failingStages ?? []);
  const newStages = failingStages.filter((s) => !prevFailing.has(s));
  if (prevFailing.size > 0 && newStages.length > 0 && newStages.length < failingStages.length) reasons.push('tests_regressed');

  const risky = dangerousChangedFiles(opts.changedFiles ?? []);
  if (risky.length > 0 && attempts > 1) reasons.push('dangerous_change');

  const uniqueReasons = [...new Set(reasons)];
  const state = {
    ...prev,
    schema: CYCLE_STATE_SCHEMA,
    cycleId,
    attempts,
    maxAttempts,
    lastVerdict: verdict,
    lastCommit: commit,
    lastTestedSha: commit,
    baselineFailures: failedTests.slice(0, 30),
    fingerprints: [
      ...prev.fingerprints.filter((f) => f.hash !== fingerprint),
      {
        hash: fingerprint,
        count: repeats,
        firstSeen: fingerprintEntry?.firstSeen ?? new Date().toISOString(),
        failingStages,
        lastCommit: commit,
      },
    ].slice(-10),
    history: [...prev.history, historyEntry].slice(-20),
    stopped: uniqueReasons.length > 0,
    stopReasons: uniqueReasons,
    dangerousFiles: risky.slice(0, 10),
  };
  return { state, stop: uniqueReasons.length > 0, reasons: uniqueReasons, attempt: attempts, resolved: false };
}

/** Human-readable explanation used in the report, the comment and the prompt. */
/**
 * @param {string[]} reasons
 * @returns {string[]}
 */
export function explainStop(reasons) {
  const map = {
    max_attempts_reached: 'Maximale Reparaturversuche für diese Änderung erreicht',
    repeated_failure: 'Derselbe Fehler ist zum dritten Mal aufgetreten (keine neue Information)',
    infrastructure_error: 'Infrastrukturfehler — Umgebung reparieren, nicht den Code',
    ollama_unavailable: 'Ollama wurde für Runtime-Tests vorausgesetzt, antwortet aber nicht',
    tests_regressed: 'Die Testlage hat sich verschlechtert (zusätzliche Stufen rot)',
    dangerous_change: 'Die Änderung berührt die Automations-/Testinfrastruktur selbst — manuelle Prüfung nötig',
  };
  return (reasons ?? []).map((r) => map[r] ?? r);
}

/** Guard evaluation presented in the report shape the UI/report renderer expects. */
/**
 * @param {{state:CycleState, stop:boolean, reasons:string[], attempt:number, resolved:boolean}} evaluation
 * @returns {object}
 */
export function guardsForReport(evaluation) {
  return {
    stopped: evaluation.state.stopped,
    stop: evaluation.stop,
    reasons: evaluation.reasons,
    explanations: explainStop(evaluation.reasons),
    attempt: evaluation.attempt,
    maxAttempts: evaluation.state.maxAttempts,
    cycleId: evaluation.state.cycleId,
    fingerprint: evaluation.state.fingerprints.at(-1)?.hash ?? null,
    repeats: evaluation.state.fingerprints.at(-1)?.count ?? 0,
    lastGoodSha: evaluation.state.lastGoodSha,
    history: evaluation.state.history.slice(-5),
  };
}
