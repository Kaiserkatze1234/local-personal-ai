/**
 * §14/§56 measurement harness (spec: "measure, then optimize actual
 * bottlenecks" — the numbers were the stated deliverable of phase 14).
 * Boots the REAL CoreApp against the user's actual config (or a temp demo
 * core with --demo) and times the paths that matter on their machine:
 * provider health, raw generation latency + tokens/sec (real usage
 * counters from Ollama/OpenAI-compatible responses), end-to-end chat turn
 * + time-to-first-token, embeddings, memory/knowledge retrieval against the
 * live DB, SQLite insert throughput, a resource snapshot, and the §56 idle
 * unload round-trip with Ollama's /api/ps VRAM diff.
 *
 * Headless by design (no Electron) — run it on the target box while the app
 * is closed; report file lands next to the logs so Diagnostics can reveal it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { nowIso } from '../../shared/types/common.js';
import { Api } from '../api.js';
import { CoreApp } from '../app.js';

export interface BenchOptions {
  /** force the mock provider: validates the harness itself, touches nothing real */
  demo?: boolean;
  /** measured generation turns per benchmark (1..10) */
  turns?: number;
  /** prompt for E2E chat turns (kept short by default — costs real tokens on live runs) */
  prompt?: string;
  dataDir?: string;
}

export interface BenchRow {
  name: string;
  ms: number;
  detail: string;
}

export interface BenchReport {
  startedAt: string;
  rows: BenchRow[];
  markdown: string;
  reportFile?: string;
}

export function defaultDataDir(): string {
  const appData =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  return join(appData, 'lpai');
}

async function ollamaPs(baseUrl: string): Promise<string> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return 'n/a';
    const j = (await res.json()) as { models?: { size?: number; parameter_size?: number }[] };
    const miB = (j.models ?? []).reduce((a, m) => a + (m.size ?? 0), 0) / 1048576;
    return `${String(j.models?.length ?? 0)} model(s), ${Math.round(miB)} MiB resident`;
  } catch {
    return 'n/a';
  }
}

export async function runPerfBench(o: BenchOptions = {}): Promise<BenchReport> {
  const turns = Math.max(1, Math.min(10, o.turns ?? 3));
  const prompt = o.prompt ?? 'Reply with exactly: bench ok';
  const demo = Boolean(o.demo);
  const ownTemp = demo && !o.dataDir;
  const dataDir = o.dataDir ?? (ownTemp ? mkdtempSync(join(tmpdir(), 'lpai-bench-')) : defaultDataDir());

  const app = new CoreApp({ dataDir, adapters: demo ? 'mock-only' : 'default', timers: false });
  if (demo) app.config.patch({ indexing: { enabled: false } } as never);
  await app.boot();

  const rows: BenchRow[] = [];
  const row = async (name: string, fn: () => Promise<string>): Promise<void> => {
    const t0 = performance.now();
    let detail = '';
    try {
      detail = await fn();
    } catch (err) {
      detail = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
    }
    rows.push({ name, ms: Math.round((performance.now() - t0) * 10) / 10, detail });
  };

  try {
    // 1) provider health (adapters report their own latencyMs during refresh)
    for (const p of app.providers.list()) {
      await row(`provider health: ${p.id}`, async () => {
        await app.providers.refreshProvider(p.id);
        const found = app.providers.list().find((x) => x.id === p.id);
        return found
          ? `${found.enabled ? 'enabled' : 'disabled'} · ${found.health.state}${found.health.latencyMs !== undefined ? ` · ${String(Math.round(found.health.latencyMs))}ms` : ''}`
          : 'gone';
      });
    }

    // 2) raw generation on the bound chat model — real usage tokens -> tok/s
    const chatRole = app.roles.get('chat');
    if (!chatRole) {
      rows.push({ name: 'generation', ms: 0, detail: 'n/a — no chat role bound (run the wizard first)' });
    } else {
      const { provider, model } = app.providers.chatFor(chatRole.modelId);
      for (let i = 1; i <= turns; i++) {
        await row(`generation #${String(i)} (${model.name})`, async () => {
          const r = await provider.adapter.chat?.generate({
            modelId: model.id,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
          });
          if (!r) return 'provider has no chat interface';
          return `finish=${r.finishReason} · ${String(r.text.length)} chars${r.usage?.outputTokens !== undefined ? ` · ${String(r.usage.outputTokens)} out-tok` : ''}`;
        });
      }

      // 2b) tok/s with clean timing (measure around the call itself)
      await row(`generation throughput x${String(turns)} (${model.name})`, async () => {
        if (!provider.adapter.chat) return 'n/a';
        const t0 = performance.now();
        let outTok = 0;
        for (let i = 0; i < turns; i++) {
          const r = await provider.adapter.chat.generate({
            modelId: model.id,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
          });
          outTok += r.usage?.outputTokens ?? 0;
        }
        const sec = (performance.now() - t0) / 1000;
        return outTok > 0
          ? `${outTok} tokens in ${sec.toFixed(1)}s = ${(outTok / sec).toFixed(1)} tok/s`
          : `no usage counters (chars: ${(200 * turns).toFixed(0)}/call approx)`;
      });

      // 3) §56 idle unload round-trip with VRAM evidence (Ollama only)
      await row('idle unload (§56)', async () => {
        if (!provider.adapter.unloadModel) return 'n/a — provider has no unloadModel';
        const before = provider.baseUrl ? await ollamaPs(provider.baseUrl) : 'n/a';
        const ok = await app.providers.unloadModel(model.id);
        const after = provider.baseUrl ? await ollamaPs(provider.baseUrl) : 'n/a';
        return `unload returned ${String(ok)} · before: ${before} · after: ${after}`;
      });
    }

    // 4) end-to-end chat turn through the exact IPC entry + TTFT
    const api = new Api(app);
    await row('chat.send E2E (turn incl. context+router)', async () => {
      let ttft: number | null = null;
      const t0 = performance.now();
      const off = app.bus.on('chat.stream', () => {
        if (ttft === null) ttft = Math.round(performance.now() - t0);
      });
      try {
        const res = await api.handleRaw('chat.send', [{ text: prompt, mode: 'CHAT' }]);
        if (!res.ok) return `FAILED: ${res.error?.message ?? 'unknown'}`;
        return `completed${ttft !== null ? ` · time-to-first-token ${String(ttft)}ms` : ' (single-shot model, no stream deltas)'}`;
      } finally {
        off();
      }
    });

    // 5) embeddings on the bound role — an unbound/embedding-less provider is
    // a normal config state (retrieval falls back to LIKE), so report n/a.
    await row('embeddings (1 text)', async () => {
      const emb = app.roles.get('embeddings');
      if (!emb) return 'n/a — no embeddings role bound';
      let found: ReturnType<typeof app.providers.embeddingsFor>;
      try {
        found = app.providers.embeddingsFor(emb.modelId);
      } catch {
        return 'n/a — bound embeddings model has no embeddings provider';
      }
      if (!found.provider.adapter.embeddings) return 'n/a — bound provider has no embeddings interface';
      const vec = await found.provider.adapter.embeddings.embed(emb.modelId, ['the quick brown fox jumps over the lazy dog']);
      return `${String(vec[0]?.length ?? 0)} dims`;
    });

    // 6) retrieval against the LIVE database (what the agent pays per task)
    await row('memory.search', async () => {
      const hits = await app.memory.search('bench', { limit: 5 });
      return `${String(hits.length)} hit(s) over ${String(app.store.all<{ n: number }>('SELECT COUNT(*) AS n FROM memory_entries')[0]?.n ?? 0)} entries`;
    });
    await row('knowledge.search', async () => {
      const hits = app.knowledge.search('bench', 5);
      return `${String(hits.length)} hit(s) over ${String(app.store.all<{ n: number }>('SELECT COUNT(*) AS n FROM knowledge_chunks')[0]?.n ?? 0)} chunks`;
    });

    // 7) SQLite write throughput (temp file, WAL — same pragmas as the app)
    await row('sqlite insert x2000 (WAL, one tx)', async () => {
      const f = join(dataDir, `bench-micro-${String(Date.now())}.db`);
      const db = new Database(f);
      try {
        db.pragma('journal_mode = WAL');
        db.exec('CREATE TABLE t (i INTEGER, s TEXT)');
        const ins = db.prepare('INSERT INTO t VALUES (?, ?)');
        const run = db.transaction(() => {
          for (let i = 0; i < 2000; i++) ins.run(i, `row-${String(i)}`);
        });
        run();
        return '2000 rows committed+fsynced';
      } finally {
        db.close();
        rmSync(f, { force: true });
        rmSync(`${f}-wal`, { force: true });
        rmSync(`${f}-shm`, { force: true });
      }
    });

    // 8) system snapshot at the tail of the run
    await row('resource snapshot', async () => {
      const s = await app.resources.sample();
      return `cpu ${s.cpuPercent !== undefined ? `${Math.round(s.cpuPercent)}%` : 'n/a'} · rss ${Math.round(process.memoryUsage().rss / 1048576)} MiB`;
    });
  } finally {
    await app.dispose();
    if (ownTemp && o.dataDir === undefined) rmSync(dataDir, { recursive: true, force: true });
  }

  const startedAt = nowIso();
  const table = [
    '| measurement | ms | detail |',
    '|---|---|---|',
    ...rows.map((r) => `| ${r.name} | ${String(r.ms)} | ${r.detail || '—'} |`),
  ].join('\n');
  const markdown = `# Local Personal AI — performance bench (${demo ? 'DEMO/mock core' : 'live config'})\n\nstarted ${startedAt} · dataDir ${dataDir}\n\ntarget hardware matters: run on the machine the app will use, app closed.\n\n${table}\n`;
  const report: BenchReport = { startedAt, rows, markdown };

  if (!ownTemp) {
    try {
      mkdirSync(join(dataDir, 'bench'), { recursive: true });
      const stamp = startedAt.replace(/[:.]/g, '-');
      report.reportFile = join(dataDir, 'bench', `report-${stamp}.md`);
      writeFileSync(report.reportFile, markdown, 'utf8');
    } catch {
      /* reporting must never break the measurements */
    }
  }
  return report;
}
