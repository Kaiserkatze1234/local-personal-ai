/**
 * Provider registry — the single place the app resolves a capability to an
 * adapter. Core code never imports a concrete provider (RULE 7/8).
 */
import type { ModelCapability } from '../../shared/types/capabilities.js';
import { nowIso } from '../../shared/types/common.js';
import type { ModelInfo, ModelProviderAdapter, ProviderHealth } from '../../shared/types/models.js';
import { AppError } from '../core/errors.js';
import type { SubLogger } from '../core/logger.js';
import type { SqlStore } from '../storage/db.js';

export interface RegisteredProvider {
  id: string;
  label: string;
  kind: string;
  baseUrl?: string;
  enabled: boolean;
  adapter: ModelProviderAdapter;
  models: ModelInfo[];
  health: ProviderHealth;
  lastDiscoveryAt?: string;
}

export function unhealth(providerId: string, message: string, state: ProviderHealth['state'] = 'UNAVAILABLE'): ProviderHealth {
  return { providerId, state, message, checkedAt: nowIso() };
}

export class ProviderRegistry {
  private providers = new Map<string, RegisteredProvider>();
  /** modelId -> last real use, for idle unloading (§56). */
  private lastUsed = new Map<string, number>();

  constructor(
    private store: SqlStore,
    private log: SubLogger,
  ) {}

  register(adapter: ModelProviderAdapter, meta: { kind?: string; baseUrl?: string; enabled?: boolean } = {}): void {
    this.providers.set(adapter.id, {
      id: adapter.id,
      label: adapter.label,
      kind: meta.kind ?? adapter.constructor.name,
      baseUrl: meta.baseUrl,
      enabled: meta.enabled ?? true,
      adapter,
      models: [],
      health: unhealth(adapter.id, 'Not checked yet', 'WARNING'),
    });
    this.store.run(
      `INSERT INTO providers (id,label,kind,base_url,enabled,updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET label=excluded.label, kind=excluded.kind, base_url=excluded.base_url, updated_at=excluded.updated_at`,
      adapter.id,
      adapter.label,
      meta.kind ?? 'unknown',
      meta.baseUrl ?? null,
      (meta.enabled ?? true) ? 1 : 0,
      nowIso(),
    );
  }

  setEnabled(id: string, enabled: boolean): void {
    const p = this.providers.get(id);
    if (p) p.enabled = enabled;
    this.store.run(`UPDATE providers SET enabled=? WHERE id=?`, enabled ? 1 : 0, id);
  }

  list(): RegisteredProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): RegisteredProvider | null {
    return this.providers.get(id) ?? null;
  }

  async refreshProvider(id: string): Promise<RegisteredProvider | null> {
    const p = this.providers.get(id);
    if (!p?.enabled) return p ?? null;
    p.health = await p.adapter.healthCheck().catch((err: Error) => unhealth(p.id, `Health check threw: ${err.message}`, 'ERROR'));
    if (p.health.state === 'OK') {
      try {
        p.models = await p.adapter.discoverModels();
        p.lastDiscoveryAt = nowIso();
        this.persistModels(p);
      } catch (err) {
        this.log.warn(`model discovery failed for ${p.id}: ${(err as Error).message}`);
        p.health = { ...p.health, state: 'WARNING', message: `Healthy, but discovery failed: ${(err as Error).message}` };
      }
    } else {
      p.models = [];
    }
    this.store.run(`UPDATE providers SET last_health_json=? WHERE id=?`, JSON.stringify(p.health), p.id);
    return p;
  }

  async refreshAll(): Promise<void> {
    await Promise.all([...this.providers.keys()].map((id) => this.refreshProvider(id)));
  }

  private persistModels(p: RegisteredProvider): void {
    this.store.tx(() => {
      this.store.run(`DELETE FROM models WHERE provider_id=?`, p.id);
      for (const m of p.models) {
        this.store.run(
          `INSERT INTO models (id,provider_id,name,json,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`,
          m.id,
          m.providerId,
          m.name,
          JSON.stringify(m),
          nowIso(),
        );
      }
    });
  }

  /** All models currently known to the registry (across providers). */
  allModels(): ModelInfo[] {
    return this.list().flatMap((p) => (p.enabled ? p.models : []));
  }

  findModel(modelId: string): { model: ModelInfo; provider: RegisteredProvider } | null {
    for (const p of this.providers.values()) {
      const m = p.models.find((x) => x.id === modelId);
      if (m) return { model: m, provider: p };
    }
    return null;
  }

  modelsWith(capability: ModelCapability): { model: ModelInfo; provider: RegisteredProvider }[] {
    const out: { model: ModelInfo; provider: RegisteredProvider }[] = [];
    for (const p of this.providers.values()) {
      if (!p.enabled || p.health.state !== 'OK') continue;
      for (const m of p.models) if (m.capabilities.includes(capability)) out.push({ model: m, provider: p });
    }
    return out;
  }

  /** Remove a provider (extension lifecycle). Models go with it. */
  unregisterProvider(providerId: string): boolean {
    const p = this.providers.get(providerId);
    if (!p) return false;
    this.store.run(`DELETE FROM models WHERE provider_id = ?`, providerId);
    this.store.run(`DELETE FROM providers WHERE id = ?`, providerId);
    this.providers.delete(providerId);
    return true;
  }

  /** Resolve the chat contract for a model id; throws honestly if absent (§3.8). */
  chatFor(modelId: string): { provider: RegisteredProvider; model: ModelInfo } {
    const found = this.findModel(modelId);
    if (!found) throw AppError.provider(`Model "${modelId}" is not available (provider offline or model not installed).`);
    if (!found.provider.adapter.chat) throw AppError.provider(`Provider "${found.provider.label}" has no chat capability.`);
    if (found.provider.health.state !== 'OK')
      throw AppError.provider(`Provider "${found.provider.label}" is unhealthy: ${found.provider.health.message}`);
    this.lastUsed.set(modelId, Date.now());
    return found;
  }

  embeddingsFor(modelId: string): { provider: RegisteredProvider; model: ModelInfo } {
    const found = this.findModel(modelId);
    if (!found) throw AppError.provider(`Embedding model "${modelId}" is not available.`);
    if (!found.provider.adapter.embeddings) throw AppError.provider(`Provider "${found.provider.label}" has no embeddings capability.`);
    this.lastUsed.set(modelId, Date.now());
    return found;
  }

  /** §56: ask providers to drop models idle for `idleMinutes`. */
  async unloadIdle(idleMinutes: number, keep = new Set<string>()): Promise<string[]> {
    if (idleMinutes <= 0) return [];
    const cutoff = Date.now() - idleMinutes * 60_000;
    const unloaded: string[] = [];
    for (const [modelId, at] of [...this.lastUsed]) {
      if (keep.has(modelId) || at > cutoff) continue;
      const ok = await this.unloadModel(modelId).catch(() => false);
      if (ok) unloaded.push(modelId);
      this.lastUsed.delete(modelId);
    }
    return unloaded;
  }

  async unloadModel(modelId: string): Promise<boolean> {
    const found = this.findModel(modelId);
    if (!found?.provider.adapter.unloadModel) return false;
    return found.provider.adapter.unloadModel(modelId);
  }
}
