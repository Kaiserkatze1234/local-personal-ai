/**
 * Self-diagnostics — spec §50/§53. Aggregates component health into the
 * health screen with actionable hints; exportable for troubleshooting.
 */
import { existsSync, mkdirSync, statfs, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HealthState } from '../../shared/types/capabilities.js';
import { nowIso } from '../../shared/types/common.js';
import type { ComponentStatus, HealthReport } from '../../shared/types/diagnostics.js';
import type { ConfigService } from '../core/config.js';
import type { SubLogger } from '../core/logger.js';
import { ingestFile } from '../files/importers.js';
import type { PermissionService } from '../permissions/permissionService.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ResourceManager } from '../resources/resourceManager.js';
import type { SqlStore } from '../storage/db.js';

const SEVERITY: Record<HealthState, number> = { OK: 0, UNAVAILABLE: 1, WARNING: 2, ERROR: 3 };

export interface HealthDeps {
  providers: ProviderRegistry;
  resources: ResourceManager;
  config: ConfigService;
  permissions: PermissionService;
  store: SqlStore;
  dataDir: string;
  log: SubLogger;
  logger: { tail(n?: number): string[] };
  /** Extra components contributed by optional subsystems (voice/vision/overlay). */
  extraComponents?: () => ComponentStatus[];
}

function freeBytes(dir: string): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    statfs(dir, (err, s) => {
      if (err) rejectP(err);
      else resolveP((s?.bavail ?? 0) * (s?.bsize ?? 0));
    });
  });
}

export class HealthService {
  constructor(private deps: HealthDeps) {}

  async run(opts: { probeProviders?: boolean } = {}): Promise<HealthReport> {
    const d = this.deps;
    const components: ComponentStatus[] = [];
    const at = nowIso();
    const push = (id: string, label: string, state: HealthState, message: string, hints: string[] = []): void => {
      components.push({ id, label, state, message, hints, updatedAt: at });
      if (state !== 'OK') d.log.warn(`${id}: ${state} — ${message}`);
    };

    // ---- database ----
    try {
      d.store.get1(`SELECT COUNT(*) AS c FROM tasks`);
      const n = d.store.get1<{ c: number }>(`SELECT COUNT(*) AS c FROM messages`)?.c ?? 0;
      push('storage.db', 'Database', 'OK', `SQLite healthy, ${n} message(s) stored`);
    } catch (err) {
      push('storage.db', 'Database', 'ERROR', `Database error: ${(err as Error).message}`, [
        'Export diagnostics, then restart the app',
        'If corruption persists, move lpai.db aside and let it recreate',
      ]);
    }

    // ---- disk space ----
    try {
      const free = await freeBytes(d.dataDir);
      push(
        'storage.space',
        'Disk space',
        free > 1e9 ? 'OK' : 'WARNING',
        `${Math.round(free / 1e6)} MB free in data directory`,
        free > 1e9 ? [] : ['Free disk space — checkpoints and logs need room'],
      );
    } catch {
      push('storage.space', 'Disk space', 'WARNING', 'Could not measure free space on this volume');
    }

    // ---- providers + models ----
    if (opts.probeProviders) await d.providers.refreshAll().catch(() => undefined);
    const providers = d.providers.list().filter((p) => p.enabled);
    if (providers.length === 0) {
      push('providers', 'Model providers', 'UNAVAILABLE', 'No provider registered', [
        'Install Ollama or add a local OpenAI-compatible endpoint in Settings → AI',
      ]);
    } else {
      for (const p of providers) {
        push(
          `provider.${p.id}`,
          p.label,
          p.health.state,
          p.health.message ?? '',
          p.health.state === 'UNAVAILABLE'
            ? ['Start the service or check its port (Ollama: "ollama serve")', 'Re-run detection on the health screen']
            : [],
        );
      }
      const chatModels = d.providers.allModels().filter((m) => m.capabilities.includes('text_generation'));
      push(
        'models',
        'Runtime models',
        chatModels.length > 0 ? 'OK' : 'WARNING',
        chatModels.length > 0 ? `${chatModels.length} chat-capable model(s) available` : 'No text-generation model found',
        chatModels.length > 0 ? [] : ['Pull/install a model and refresh providers'],
      );
    }

    // ---- file scope ----
    const roots = d.config.get().tools.allowedRoots;
    push(
      'tools.scope',
      'File scope',
      roots.length === 0 ? 'WARNING' : 'OK',
      roots.length === 0
        ? 'No directories granted to file tools yet'
        : `${roots.length} granted director${roots.length === 1 ? 'y' : 'ies'}`,
      roots.length === 0 ? ['Add a project or workspace folder under Settings → Tools'] : [],
    );

    // ---- ingestion sanity (reads its own config through the real pipeline) ----
    try {
      const cfgPath = join(d.dataDir, 'config.json');
      if (existsSync(cfgPath)) {
        const res = ingestFile(cfgPath);
        push(
          'ingest',
          'File ingestion',
          res.ok ? 'OK' : 'WARNING',
          res.ok ? 'Text pipeline operational' : (res.unavailableReason ?? 'ingest problem'),
        );
      } else {
        push('ingest', 'File ingestion', 'OK', 'Idle (defaults in memory, no config file yet)');
      }
    } catch (err) {
      push('ingest', 'File ingestion', 'ERROR', (err as Error).message);
    }

    // ---- permissions ----
    const ps = d.permissions.state();
    push(
      'permissions',
      'Permission system',
      'OK',
      `Mode ${ps.mode}, ${ps.grants.length} persistent grant(s), ${ps.pending.length} pending request(s)`,
    );

    // ---- optional subsystems ----
    if (d.extraComponents) components.push(...d.extraComponents());

    // ---- resources ----
    const snap = d.resources.snapshot();
    const memPct = snap.memUsedMb / Math.max(1, snap.memTotalMb);
    push(
      'resources',
      'Resources',
      memPct > 0.92 ? 'WARNING' : 'OK',
      `mode ${snap.resourceMode}; RAM ${snap.memUsedMb}/${snap.memTotalMb} MB${snap.cpuPercent !== undefined ? `; CPU ${snap.cpuPercent}%` : ''}${snap.gpus && snap.gpus.length > 0 ? `; GPU reported by provider` : '; GPU stats not exposed by provider'}`,
      memPct > 0.92 ? ['Close unused apps or switch to LOW_RESOURCE mode'] : [],
    );

    const overall = components.reduce<HealthState>(
      (worst, c) => ((SEVERITY[c.state] ?? 0) > (SEVERITY[worst] ?? 0) ? c.state : worst),
      'OK',
    );
    const report: HealthReport = { overall, components, resources: snap, generatedAt: at };
    try {
      d.store.run(
        `INSERT INTO diagnostics (at, component, state, message) VALUES (?,?,?,?)`,
        at,
        '__overall__',
        overall,
        `components=${components.length}`,
      );
    } catch {
      /* diagnostics about diagnostics must not fail the app */
    }
    return report;
  }

  /** Micro self-tests (§50): round-trips through real subsystems. */
  async selfTest(): Promise<ComponentStatus[]> {
    const at = nowIso();
    const results: ComponentStatus[] = [];
    const check = (name: string, fn: () => Promise<void>) =>
      fn().then(
        () =>
          results.push({ id: `selftest.${name}`, label: `Self-test: ${name}`, state: 'OK', message: 'passed', hints: [], updatedAt: at }),
        (err: Error) =>
          results.push({
            id: `selftest.${name}`,
            label: `Self-test: ${name}`,
            state: 'ERROR',
            message: err.message,
            hints: ['See logs'],
            updatedAt: at,
          }),
      );
    await check('db-roundtrip', async () => {
      this.deps.store.run(`CREATE TABLE IF NOT EXISTS __selftest(x INTEGER)`);
      this.deps.store.run(`INSERT INTO __selftest VALUES (42)`);
      const v = this.deps.store.get1<{ x: number }>(`SELECT x FROM __selftest LIMIT 1`)?.x;
      this.deps.store.run(`DROP TABLE __selftest`);
      if (v !== 42) throw new Error('roundtrip mismatch');
    });
    await check('generation-path', async () => {
      const mock = this.deps.providers.get('mock');
      if (!mock?.adapter.chat) throw new Error('demo provider unavailable for self-test');
      const r = await mock.adapter.chat.generate({ modelId: 'mock:demo-local-1', messages: [{ role: 'user', content: 'ping' }] });
      if (typeof r.text !== 'string') throw new Error('bad result shape');
    });
    await check('registry', async () => {
      if (this.deps.providers.list().length === 0) throw new Error('no providers registered');
    });
    return results;
  }

  exportDiagnostics(): { path: string; write: () => Promise<void> } {
    const dir = join(this.deps.dataDir, 'diagnostics');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `diagnostics-${Date.now()}.json`);
    return {
      path,
      write: async () => {
        const report = await this.run({ probeProviders: false });
        writeFileSync(path, JSON.stringify({ report, logTail: this.deps.logger.tail(300) }, null, 2));
      },
    };
  }
}
