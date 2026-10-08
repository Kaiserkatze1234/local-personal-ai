#!/usr/bin/env node
/**
 * Feedback-Import: holt das Ergebnis des letzten Windows-Testlaufs von GitHub
 * in den Arbeitsbaum — der offizielle Rückkanal des Kreislaufs.
 *
 *   npm run feedback:pull                    # aktueller Branch, Repo aus dem Remote
 *   npm run feedback:pull -- --branch=main
 *   npm run feedback:pull -- --run=12345678  # bestimmter Workflow-Lauf
 *
 * Was es holt (alles über die offizielle GitHub-API, `gh` CLI):
 *   1. den frischsten Lauf des Workflows "Autonomous test (Windows runner)"
 *      für den Branch, samt Ergebnis und Run-URL,
 *   2. dessen Artefakte `lpai-test-reports` und `lpai-ai-handoff` (latest.json/.md,
 *      latest-chatgpt.json/.md, latest-arena-task.md, latest-fix-prompt.md,
 *      latest-analysis.json, cycle-state.json, Screenshots, Playwright-Traces)
 *      → test-reports/inbox/,
 *   3. den strukturierten Report-Kommentar am Pull Request (falls einer existiert),
 *   4. schreibt test-reports/inbox/BRIEF.md und -ARENA-TASK.md — den knappen Auftrag, mit dem eine
 *      Entwicklungsrunde fortgesetzt werden kann (Fehler, Kategorie, Stop-Grund,
 *      Pfade zu Artefakten) — und gibt ihn auf stdout aus.
 *
 * Es wird NICHTS verändert: der Import ist read-only gegenüber dem Repo. Der
 * Exitcode ist 0, wenn ein Report gefunden wurde, 3, wenn (noch) keiner vorliegt.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const a = argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};

const WORKFLOW_NAME = opt('workflow', 'Autonomous test (Windows runner)');
const inbox = join(ROOT, opt('out', join('test-reports', 'inbox')));

function gitOut(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`gh ${args.join(' ')} schlug fehl: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const repo = opt('repo', gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { allowFail: true }));
if (!repo) {
  console.error('[feedback] Repo nicht bestimmbar — `gh auth login` prüfen oder --repo=owner/name angeben.');
  process.exit(2);
}
// the branch is a git question, not a gh one — `gh rev-parse` silently fell
// back to 'main' and looked for runs of the wrong branch
const branch = opt('branch', gitOut(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'main');

let run = null;
const explicitRun = opt('run', null);
if (explicitRun) {
  const raw = gh(['api', `repos/${repo}/actions/runs/${explicitRun}`], { allowFail: true });
  if (raw) run = JSON.parse(raw);
} else {
  const list = gh(
    [
      'run',
      'list',
      '--repo',
      repo,
      '--branch',
      branch,
      '--limit',
      '20',
      '--json',
      'databaseId,conclusion,headSha,workflowName,createdAt,status,url',
    ],
    { allowFail: true },
  );
  if (list) {
    const runs = JSON.parse(list).filter((r) => r.workflowName === WORKFLOW_NAME && r.status === 'completed');
    run = runs[0] ?? null;
  }
}

if (!run) {
  console.log(`[feedback] kein abgeschlossener Lauf von "${WORKFLOW_NAME}" für ${repo}@${branch} gefunden.`);
  console.log('           (Workflow noch nie gelaufen oder Branch hat keinen Push getriggert.)');
  process.exit(3);
}

const runId = run.databaseId ?? run.id;
mkdirSync(inbox, { recursive: true });
const artifactDir = join(inbox, 'artifacts');
rmSync(artifactDir, { recursive: true, force: true });

let artifactsFetched = false;
const artifactList =
  JSON.parse(gh(['api', `repos/${repo}/actions/runs/${runId}/artifacts`], { allowFail: true }) ?? '{"artifacts":[]}').artifacts ?? [];
// both artefacts are flat file sets and merge into the same inbox folder
for (const name of ['lpai-test-reports', 'lpai-ai-handoff']) {
  if (!artifactList.some((a) => a.name === name)) continue;
  try {
    execFileSync('gh', ['run', 'download', String(runId), '--repo', repo, '--name', name, '--dir', artifactDir], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    artifactsFetched = true;
  } catch (err) {
    console.warn(`[feedback] Artefakt ${name} fehlgeschlagen: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

// PR + strukturierter Kommentar (der zweite, direkt lesbare Kanal)
const prRaw = gh(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--limit', '5', '--json', 'number,url,state,title'], {
  allowFail: true,
});
const prs = prRaw ? JSON.parse(prRaw) : [];
let comment = null;
if (prs.length > 0) {
  const cRaw = gh(['pr', 'view', String(prs[0].number), '--repo', repo, '--json', 'comments'], { allowFail: true });
  if (cRaw) {
    const comments = JSON.parse(cRaw).comments ?? [];
    comment = [...comments].reverse().find((c) => c.body?.includes('<!-- lpai-autonomous-report -->'))?.body ?? null;
  }
}

const reportFile = existsSync(join(artifactDir, 'latest.json')) ? join(artifactDir, 'latest.json') : null;
const report = reportFile ? JSON.parse(readFileSync(reportFile, 'utf8')) : null;
const arenaTaskFile = existsSync(join(artifactDir, 'latest-arena-task.md')) ? join(artifactDir, 'latest-arena-task.md') : null;
const digestFile = existsSync(join(artifactDir, 'latest-chatgpt.json')) ? join(artifactDir, 'latest-chatgpt.json') : null;
const fixPromptFile =
  arenaTaskFile ?? (existsSync(join(artifactDir, 'latest-fix-prompt.md')) ? join(artifactDir, 'latest-fix-prompt.md') : null);
const stateFile = existsSync(join(artifactDir, 'cycle-state.json')) ? join(artifactDir, 'cycle-state.json') : null;
const state = stateFile ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;

const brief = [];
brief.push(`# Testlauf-Ergebnis (importiert aus GitHub) — ${report?.verdict ?? run.conclusion ?? 'unbekannt'}`);
brief.push('');
brief.push(`- Repo/Branch: \`${repo}\` @ \`${branch}\``);
brief.push(
  `- Commit: \`${(report?.git?.commit ?? run.headSha ?? '?').slice(0, 10)}\`${report?.git?.subject ? ` — ${report.git.subject}` : ''}`,
);
brief.push(`- Lauf: ${run.url ?? `#${runId}`} (${run.createdAt ?? report?.startedAt ?? '?'})`);
brief.push(
  `- Runner: ${report?.runner?.name ?? '?'} · ${report?.runner?.os ?? '?'} · ${report?.runner?.durationS ?? ''}${report ? ` · ${(report.durationMs / 1000).toFixed(0)} s` : ''}`,
);
brief.push(`- Ollama: ${report ? (report.ollama?.reachable ? `erreichbar (${report.ollama.baseUrl})` : 'nicht erreichbar') : 'unbekannt'}`);
if (report?.stages) {
  brief.push('');
  brief.push('| Stufe | Status | Dauer |');
  brief.push('| --- | --- | --- |');
  for (const s of report.stages) brief.push(`| ${s.name} | ${s.status} | ${(s.durationMs / 1000).toFixed(1)} s |`);
}
if (report?.summary?.failedTests?.length) {
  brief.push('');
  brief.push(`Fehlgeschlagene Tests: ${report.summary.failedTests.map((t) => `\`${t}\``).join(', ')}`);
}
if (report?.analysis?.final) {
  brief.push('');
  brief.push(
    `Analyse: **${report.analysis.final.category}** (${report.analysis.final.confidence}) — ${report.analysis.final.probableCause}`,
  );
  brief.push(`Empfohlene Korrektur: ${report.analysis.final.recommendedFix}`);
}
if (state) {
  brief.push('');
  brief.push(
    `Zyklus: Runde ${state.attempts}/${state.maxAttempts} (cycle \`${state.cycleId ?? '—'}\`)${state.stopped ? ` — **gestoppt**: ${(state.stopReasons ?? []).join(', ')} (manuelle Entscheidung nötig)` : ''}`,
  );
}
if (fixPromptFile) {
  brief.push('');
  brief.push(`Reparaturauftrag: \`${fixPromptFile.replace(`${ROOT}/`, '')}\``);
}
if (digestFile) {
  brief.push(`Digest (maschinenlesbar): \`${digestFile.replace(`${ROOT}/`, '')}\``);
}
if (comment) {
  brief.push('');
  brief.push('Report-Kommentar am PR ist zusätzlich als `pr-comment.md` gespeichert.');
  writeFileSync(join(inbox, 'pr-comment.md'), comment);
}
if (!artifactsFetched) {
  brief.push('');
  brief.push('_Artefakte konnten nicht geladen werden — Verdict stammt aus den Run-Daten; Details über die Run-URL._');
}
brief.push('');
writeFileSync(join(inbox, 'BRIEF.md'), brief.join('\n'));
if (fixPromptFile) {
  try {
    writeFileSync(join(inbox, 'ARENA-TASK.md'), readFileSync(fixPromptFile, 'utf8'));
  } catch {
    /* best effort — the brief already names the path */
  }
}

console.log(brief.join('\n'));
if (artifactsFetched) console.log(`\nArtefakte: ${artifactDir}`);
process.exit(0);
