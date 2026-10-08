/**
 * Report building for the autonomous test loop.
 *
 * Pure functions only (no fs, no process spawning) so the whole contract —
 * verdict, fingerprints, markdown, fix prompt — is unit-testable without
 * running a single test. The orchestrator (scripts/autonomous-test.mjs) does
 * the I/O around it.
 *
 * Report contract (test-reports/latest.json, schema 1):
 *   verdict, commit/branch, runner+OS, timings, one entry per stage with
 *   status/exitCode/duration/errors/failedTests/artifacts, ollama state,
 *   guard state, artifact paths. Logs are NEVER copied in bulk — at most a
 *   handful of trimmed error lines per stage.
 */

export const REPORT_SCHEMA = 1;
export const REPORT_MARKER = '<!-- lpai-autonomous-report -->';

import { createHash } from 'node:crypto';

/** status vocabulary the whole loop uses (no green-on-grey, no fake passes) */
export const STATUS = ['PASS', 'FAIL', 'SKIP', 'INFRASTRUCTURE_ERROR'];

/**
 * @param {string} name
 * @param {object} [extra]
 * @returns {object} stage record
 */
export function makeStage(name, extra = {}) {
  return {
    name,
    status: 'SKIP',
    exitCode: null,
    durationMs: 0,
    command: null,
    errors: [],
    failedTests: [],
    artifacts: [],
    note: null,
    ...extra,
  };
}

/** Keep only informative error lines; cap count and length. */
/**
 * @param {string} text
 * @param {number} [max]
 * @param {number} [perLine]
 * @returns {string[]}
 */
/** ANSI colour codes (built at runtime: a raw ESC byte in source trips the linter). */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function extractErrorLines(text, max = 25, perLine = 500) {
  const clean = String(text ?? '')
    .replace(ANSI_ESCAPE, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.length > 0);
  const interesting = clean.filter((l) =>
    /\b(error|fail|failed|failure|exception|assert|expected|received|throw|denied|refused|timeout|timed out|ENOENT|EACCES|ENOTFOUND|TS\d{4}|npm ERR)/i.test(
      l,
    ),
  );
  const picked = (interesting.length > 0 ? interesting : clean).slice(-max);
  return picked.map((l) => (l.length > perLine ? `${l.slice(0, perLine)}…` : l));
}

/**
 * @param {object} report
 * @returns {string[]}
 */
export function fingerprintParts(report) {
  const failing = (report.stages ?? []).filter((s) => s.status === 'FAIL' || s.status === 'INFRASTRUCTURE_ERROR');
  const parts = [];
  for (const s of failing) {
    parts.push(`${s.name}:${s.status}`);
    for (const t of (s.failedTests ?? []).slice(0, 20)) parts.push(`t:${t}`);
    const firstError = (s.errors ?? []).find((e) => /error|fail|expected|refused|timeout|ENOENT|TS\d{4}/i.test(e));
    if (firstError) parts.push(`e:${firstError.replace(/\d+/g, 'N').slice(0, 160)}`);
  }
  if (parts.length === 0) parts.push(`verdict:${report.verdict ?? '?'}`);
  return parts;
}

/** Stable, boring hash (node's crypto is available in every runtime here). */
/**
 * @param {object} report
 * @returns {string}
 */
export function fingerprintOf(report) {
  return createHash('sha1').update(fingerprintParts(report).join('\u0001')).digest('hex').slice(0, 16);
}

/**
 * @param {object[]} stages
 * @returns {{screenshots:string[],traces:string[],logs:string[],other:string[]}}
 */
export function collectArtifacts(stages) {
  const out = { screenshots: [], traces: [], logs: [], other: [] };
  for (const s of stages ?? []) {
    for (const a of s.artifacts ?? []) {
      const lower = String(a).toLowerCase();
      if (/\.(png|jpe?g|webp)$/.test(lower)) out.screenshots.push(a);
      else if (/trace|\.zip$/.test(lower)) out.traces.push(a);
      else if (/\.(log|txt)$/.test(lower)) out.logs.push(a);
      else out.other.push(a);
    }
  }
  return out;
}

/**
 * @param {{meta:object, stages:object[], guards?:object|null, analysis?:object|null, startedAt:number, finishedAt:number}} input
 * @returns {object} the report contract written to test-reports/latest.json
 */
export function buildReport({ meta, stages, guards = null, analysis = null, startedAt, finishedAt }) {
  const verdict = stages.some((s) => s.status === 'FAIL')
    ? 'FAIL'
    : stages.some((s) => s.status === 'INFRASTRUCTURE_ERROR')
      ? 'INFRASTRUCTURE_ERROR'
      : 'PASS';
  const failedStages = stages.filter((s) => s.status === 'FAIL').map((s) => s.name);
  return {
    schema: REPORT_SCHEMA,
    reportId: `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}${meta.githubRunId ? `-run${meta.githubRunId}` : ''}`,
    verdict,
    exitCode: verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 2,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    git: meta.git,
    runner: meta.runner,
    ollama: meta.ollama,
    command: meta.command,
    stages,
    summary: {
      stages: stages.length,
      passed: stages.filter((s) => s.status === 'PASS').length,
      failed: stages.filter((s) => s.status === 'FAIL').length,
      skipped: stages.filter((s) => s.status === 'SKIP').length,
      infrastructureErrors: stages.filter((s) => s.status === 'INFRASTRUCTURE_ERROR').length,
      failedStages,
      failedTests: [...new Set(stages.flatMap((s) => s.failedTests ?? []))].slice(0, 50),
    },
    guards: guards ?? null,
    analysis,
    artifacts: collectArtifacts(stages),
  };
}

const badge = (status) =>
  status === 'PASS' ? '✅ PASS' : status === 'FAIL' ? '❌ FAIL' : status === 'SKIP' ? '⏭️ SKIP' : '🛠️ INFRASTRUCTURE_ERROR';

/**
 * @param {object} report
 * @returns {string}
 */
export function renderMarkdown(report) {
  const r = report;
  const lines = [];
  lines.push(`# Autonomous test report — ${r.verdict}`);
  lines.push('');
  lines.push(
    `**Verteilt auf** ${r.summary.passed} PASS · ${r.summary.failed} FAIL · ${r.summary.skipped} SKIP · ${r.summary.infrastructureErrors} INFRASTRUCTURE_ERROR`,
  );
  lines.push('');
  lines.push('| | |');
  lines.push('| --- | --- |');
  lines.push(`| Commit | \`${r.git.commit ?? '?'}\` (${r.git.branch ?? '?'})${r.git.dirty ? ' — dirty tree' : ''} |`);
  lines.push(`| Runner | ${r.runner.name ?? 'local'} · ${r.runner.os} · ${r.runner.arch} |`);
  lines.push(`| Node / npm | ${r.runner.node} / ${r.runner.npm} |`);
  lines.push(`| CPU / RAM | ${r.runner.cpu} · ${r.runner.cpuCount} cores · ${r.runner.totalMemGb} GB |`);
  lines.push(`| Start | ${r.startedAt} |`);
  lines.push(`| Dauer | ${(r.durationMs / 1000).toFixed(1)} s |`);
  lines.push(
    `| Ollama | ${r.ollama.reachable ? `erreichbar (${r.ollama.baseUrl}${r.ollama.version ? `, v${r.ollama.version}` : ''}${r.ollama.models !== undefined ? `, ${r.ollama.models} Modelle` : ''})` : `nicht erreichbar (${r.ollama.note ?? 'kein Server'})`} |`,
  );
  if (r.runner.githubRunId) lines.push(`| GitHub Run | [${r.runner.githubRunId}](${r.runner.githubRunUrl ?? '#'}) |`);
  lines.push('');
  lines.push('## Stufen');
  lines.push('');
  lines.push('| Stufe | Status | Dauer | Exit | Notiz |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const s of r.stages) {
    lines.push(
      `| ${s.name} | ${badge(s.status)} | ${(s.durationMs / 1000).toFixed(1)} s | ${s.exitCode ?? '—'} | ${(s.note ?? '').replace(/\|/g, '\\|').slice(0, 160)} |`,
    );
  }
  const sub = r.stages.find((s) => s.name === 'unit' || s.name === 'integration');
  if (sub) {
    lines.push('');
    lines.push('### Vitest-Aufteilung (ein Lauf, zwei Sichten)');
    lines.push('');
    for (const name of ['unit', 'integration']) {
      const s = r.stages.find((x) => x.name === name);
      if (!s) continue;
      const counts = s.counts ?? {};
      lines.push(`- **${name}**: ${counts.passed ?? 0} passed, ${counts.failed ?? 0} failed, ${counts.skipped ?? 0} skipped`);
    }
  }
  const failing = r.stages.filter((s) => s.status === 'FAIL' || s.status === 'INFRASTRUCTURE_ERROR');
  if (failing.length > 0) {
    lines.push('');
    lines.push('## Fehler (gekürzt — vollständige Logs siehe Artefakte)');
    for (const s of failing) {
      lines.push('');
      lines.push(`### ${s.name} — ${badge(s.status)}`);
      if (s.note) lines.push(`> ${s.note}`);
      if (s.failedTests?.length) {
        lines.push('');
        lines.push(`Fehlgeschlagene Tests: ${s.failedTests.map((t) => `\`${t}\``).join(', ')}`);
      }
      if (s.errors?.length) {
        lines.push('');
        lines.push('```text');
        lines.push(...s.errors.slice(0, 12));
        lines.push('```');
      }
      if (s.artifacts?.length) {
        lines.push('');
        lines.push(`Artefakte: ${s.artifacts.map((a) => `\`${a}\``).join(' · ')}`);
      }
    }
  }
  if (r.analysis) {
    lines.push('');
    lines.push('## Fehleranalyse');
    lines.push('');
    const f = r.analysis.final;
    lines.push(`- Kategorie: **${f.category}** (Konfidenz ${f.confidence})`);
    lines.push(`- Ursache: ${f.probableCause}`);
    lines.push(`- Komponente: ${f.component}${f.file ? ` · \`${f.file}\`` : ''}`);
    lines.push(`- Beobachtung: ${f.observation}`);
    lines.push(`- Empfohlene Korrektur: ${f.recommendedFix}`);
    lines.push(`- Quelle: ${f.source}${r.analysis.ai ? ` (${r.analysis.ai.modelId})` : ''}`);
    if (r.analysis.aiError) lines.push(`- KI-Analyse nicht verfügbar: ${r.analysis.aiError}`);
    else if (r.analysis.aiSkipReason) lines.push(`- KI-Analyse: nicht nötig (${r.analysis.aiSkipReason})`);
  }
  if (r.guards) {
    lines.push('');
    lines.push('## Reparaturzyklus');
    lines.push('');
    lines.push(`- Runde: ${r.guards.attempt} von ${r.guards.maxAttempts} (cycle \`${r.guards.cycleId ?? '—'}\`)`);
    lines.push(`- Fingerprint: \`${r.guards.fingerprint ?? '—'}\``);
    lines.push(`- Automatische Wiederholung: ${r.guards.stop ? `**gestoppt** — ${r.guards.reasons.join(', ')}` : 'erlaubt'}`);
  }
  const arts = r.artifacts;
  if (arts.screenshots.length + arts.traces.length + arts.other.length > 0) {
    lines.push('');
    lines.push('## Artefakte');
    lines.push('');
    for (const [kind, list] of Object.entries(arts)) {
      if (list.length > 0) lines.push(`- ${kind}: ${list.map((a) => `\`${a}\``).join(', ')}`);
    }
  }
  lines.push('');
  lines.push(`_Automatisch erzeugt von \`npm run test:autonomous\` in ${(r.durationMs / 1000).toFixed(1)} s._`);
  return lines.join('\n');
}

export function statusIcon(status) {
  return badge(status);
}

/**
 * The repair order. Written so it can be pasted straight into a coding agent
 * and still be unambiguous for a human: what broke, how to reproduce, what was
 * expected vs observed, which files and artifacts matter, what "fixed" means.
 */
/**
 * @param {object} report
 * @param {{baselineFailures?:string[], analysis?:object|null}} [opts]
 * @returns {string}
 */
export function renderFixPrompt(report, { baselineFailures = [], analysis = null } = {}) {
  const r = report;
  const failing = r.stages.filter((s) => s.status === 'FAIL' || s.status === 'INFRASTRUCTURE_ERROR');
  const l = [];
  l.push(`# Reparaturauftrag — ${r.verdict} auf \`${r.git.branch ?? '?'}\` @ \`${(r.git.commit ?? '?').slice(0, 10)}\``);
  l.push('');
  l.push(
    `_Automatisch erzeugt vom Windows-Testlauf (${r.reportId}). Ziel: den Fehler an der Wurzel beheben — kein Test-Anpassen, kein Schein-Grün._`,
  );
  l.push('');
  l.push('## Aufgabe');
  l.push('');
  if (r.verdict === 'INFRASTRUCTURE_ERROR') {
    l.push(
      'Eine Voraussetzung des Testlaufs fehlt. **Erst die Umgebung prüfen** — wenn die Ursache wirklich außerhalb des Codes liegt, ist hier *keine* Codeänderung fällig (siehe Abschnitt „Wahrscheinliche Ursache“).',
    );
  } else {
    l.push(
      `Die Stufe(n) ${failing.map((s) => `\`${s.name}\``).join(', ')} schlagen fehl. Ursache im Code beheben, das Verhalten aus dem Abschnitt „Tatsächliches Verhalten“ wiederherstellen und für den reproduzierten Fall einen Regressionstest ergänzen.`,
    );
  }
  l.push('');
  l.push('## Reproduzierbarer Fehler');
  l.push('');
  l.push('```text');
  l.push(`# Umgebung: ${r.runner.os} · ${r.runner.arch} · Node ${r.runner.node} · Run ${r.reportId}`);
  l.push(`# Commit: ${r.git.commit} (${r.git.branch})`);
  const cloneUrl = String(r.git?.remoteUrl ?? '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
  l.push(`git clone ${cloneUrl || 'https://github.com/<owner>/<repo>.git'} && cd ${cloneUrl.split('/').pop() || 'local-personal-ai'}`);
  l.push('npm ci');
  for (const s of failing) l.push(`${s.command ?? `npm run ${s.name}`}`);
  l.push('```');
  l.push('');
  l.push('## Erwartetes Verhalten');
  l.push('');
  l.push(
    `Alle Stufen des Laufs \`npm run test:autonomous\` enden mit PASS (bzw. SKIP nur dort, wo eine optionale Voraussetzung fehlt — z. B. Ollama). Konkret für diese Stufen: ${failing.map((s) => s.name).join(', ')}.`,
  );
  l.push('');
  l.push('## Tatsächliches Verhalten');
  l.push('');
  for (const s of failing) {
    l.push(`### Stufe \`${s.name}\` — ${s.status}${s.exitCode !== null && s.exitCode !== undefined ? ` (exit ${s.exitCode})` : ''}`);
    if (s.note) l.push(`> ${s.note}`);
    if (s.failedTests?.length) {
      l.push('');
      l.push('Fehlgeschlagene Tests:');
      for (const t of s.failedTests.slice(0, 20)) l.push(`- \`${t}\``);
    }
    if (s.errors?.length) {
      l.push('');
      l.push('```text');
      l.push(...s.errors.slice(0, 15));
      l.push('```');
    }
    l.push('');
  }
  l.push('## Relevante Dateien');
  l.push('');
  const files = [
    ...new Set(
      failing.flatMap((s) => [
        ...(s.errors ?? []).flatMap((e) =>
          [...e.matchAll(/([\w./@-]+\.(?:ts|tsx|mjs|cjs|js|json|yml|yaml|ps1))(?::\d+)?/g)]
            .map((m) => m[1])
            .filter((f) => !f.includes('node_modules')),
        ),
        ...(s.artifacts ?? []),
      ]),
    ),
  ].slice(0, 15);
  if (files.length === 0) l.push('- (keine aus den Fehlerzeilen ableitbar — siehe Analyse)');
  else for (const f of files) l.push(`- \`${f}\``);
  l.push('');
  if (!r.ollama.reachable) {
    l.push('## Ollama');
    l.push('');
    l.push(
      `Nicht erreichbar (${r.ollama.note ?? 'kein Server unter der konfigurierten Adresse'}): Runtime-/Live-Tests wurden übersprungen, nicht als bestanden gewertet. Wenn der Fehler in einer Runtime-Stufe liegt, gehört das hierher — nicht in den Code.`,
    );
    l.push('');
  }
  l.push('## Screenshots / Traces');
  l.push('');
  const shots = r.artifacts.screenshots;
  const traces = r.artifacts.traces;
  if (shots.length === 0 && traces.length === 0) l.push('- keine (keine UI-Stufe fehlgeschlagen oder Playwright-Trace nicht erzeugt)');
  if (shots.length) for (const s of shots.slice(0, 8)) l.push(`- Screenshot: \`${s}\``);
  if (traces.length) for (const t of traces.slice(0, 8)) l.push(`- Trace: \`${t}\` (öffnen mit \`npx playwright show-trace <pfad>\`)`);
  l.push('');
  l.push('## Wahrscheinliche Ursache');
  l.push('');
  if (analysis) {
    const a = analysis.final;
    l.push(
      `- **Kategorie**: ${a.category} (Konfidenz ${a.confidence}, Quelle: ${a.source}${analysis.ai ? `, Modell ${analysis.ai.modelId}` : ''})`,
    );
    l.push(`- **Ursache**: ${a.probableCause}`);
    l.push(`- **Betroffene Komponente**: ${a.component}${a.file ? ` (\`${a.file}\`)` : ''}`);
    l.push(`- **Beobachtung**: ${a.observation}`);
    l.push(`- **Empfohlene Korrektur**: ${a.recommendedFix}`);
    if (!analysis.ai && analysis.aiError)
      l.push(`- Lokale KI-Analyse nicht verfügbar: ${analysis.aiError} — Bewertung stammt aus den deterministischen Regeln.`);
    else if (!analysis.ai) l.push(`- Lokale KI: nicht nötig (${analysis.aiSkipReason})`);
  } else {
    l.push('- (keine Analyse eingebunden — Report lesen oder `npm run analyze:failure` ausführen)');
  }
  l.push('');
  if (baselineFailures.length > 0) {
    l.push('## Bereits vorher kaputt (nicht durch diese Änderung entstanden)');
    l.push('');
    for (const t of [...new Set(baselineFailures)].slice(0, 10)) l.push(`- \`${t}\``);
    l.push('');
  }
  l.push('## Einschränkungen');
  l.push('');
  l.push('- Kein Test entfernen, abschwächen oder umbenennen, um grün zu werden; keine Erwartung an das beobachtete Verhalten anpassen.');
  l.push('- Kein `sleep`, keine Retry-Schleife, kein Skip als Ersatz für eine echte Korrektur.');
  l.push(
    '- Bestehende Produktfunktionen nicht beschädigen: Chat/Streaming, Memory & Review-Flows, Context-Engine (Verlauf + relevante Memory), Proaktivität, Model-Routing/-Rollen, Agent-/Coding-Modus, Tasks & Checkpoints.',
  );
  l.push('- Keine neuen Abhängigkeiten ohne Not (Rechner: Ryzen 5 5600H, 16 GB RAM).');
  l.push(
    '- Änderungen an `scripts/autonomous*`, `scripts/windows/**` oder `.github/workflows/**` nur, wenn der Fehler genau dort liegt — sonst stoppt der Zyklus als „gefährliche Änderung“.',
  );
  l.push('');
  l.push('## Regressionstest-Anforderung');
  l.push('');
  l.push('- Der Fehler muss durch einen Test abgedeckt sein, der **vor** der Korrektur rot war und **nach** der Korrektur grün ist.');
  l.push('- Der Test prüft Verhalten (Eingabe → erwartete Ausgabe/DOM/Event), nicht die Existenz von Codezeilen.');
  l.push('- `npm run test:autonomous` muss danach vollständig grün sein — inklusive der zuvor grünen Stufen.');
  l.push('');
  l.push('## Loop-Status');
  l.push('');
  if (r.guards) {
    l.push(`- Runde ${r.guards.attempt}/${r.guards.maxAttempts} für cycle \`${r.guards.cycleId ?? '—'}\``);
    l.push(`- Fingerprint \`${r.guards.fingerprint ?? '—'}\``);
    if (r.guards.stop) l.push(`- **Automatik gestoppt**: ${r.guards.reasons.join(', ')} — hier ist eine bewusste Entscheidung nötig.`);
    else l.push('- Automatische Wiederholung nach dem nächsten Push ist möglich.');
  } else {
    l.push('- Kein Zykluszustand übergeben (lokaler Lauf).');
  }
  l.push('');
  return l.join('\n');
}

/** Compact one-comment summary used for the GitHub PR comment / step summary. */
/**
 * @param {object} report
 * @returns {string}
 */
export function renderComment(report) {
  const r = report;
  const lines = [
    REPORT_MARKER,
    `## ${r.verdict === 'PASS' ? '✅' : r.verdict === 'FAIL' ? '❌' : '🛠️'} Automatischer Windows-Test: ${r.verdict}`,
    '',
  ];
  lines.push(
    `Commit \`${(r.git.commit ?? '?').slice(0, 10)}\` · \`${r.git.branch ?? '?'}\` · ${(r.durationMs / 1000).toFixed(0)} s · Node ${r.runner.node}`,
  );
  lines.push('');
  lines.push('| Stufe | Status | Dauer |');
  lines.push('| --- | --- | --- |');
  for (const s of r.stages) lines.push(`| ${s.name} | ${badge(s.status)} | ${(s.durationMs / 1000).toFixed(1)} s |`);
  if (r.summary.failedTests.length > 0) {
    lines.push('');
    lines.push(`Fehlgeschlagene Tests: ${r.summary.failedTests.map((t) => `\`${t}\``).join(', ')}`);
  }
  if (r.analysis) {
    lines.push('');
    lines.push(`Analyse: **${r.analysis.final.category}** (${r.analysis.final.confidence}) — ${r.analysis.final.probableCause}`);
  }
  if (r.guards?.stop) {
    lines.push('');
    lines.push(`⚠️ Automatischer Reparaturzyklus gestoppt: ${r.guards.reasons.join(', ')}`);
  }
  lines.push('');
  lines.push(`Reparaturauftrag: \`test-reports/latest-fix-prompt.md\` (im Artefakt \`lpai-test-reports\`).`);
  return lines.join('\n');
}
