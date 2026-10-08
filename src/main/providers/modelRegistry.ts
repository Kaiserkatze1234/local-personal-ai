/**
 * Role bindings — "which model performs which role" (spec §6).
 * User-configurable, persisted, with sane auto-assignment on refresh.
 */
import type { ModelRole } from '../../shared/types/capabilities.js';
import type { ModelInfo, RoleAssignment } from '../../shared/types/models.js';
import type { RoleAssignmentRepo } from '../storage/repositories.js';
import type { ProviderRegistry } from './registry.js';

export class ModelRoleService {
  constructor(
    private store: RoleAssignmentRepo,
    private providers: ProviderRegistry,
  ) {}

  list(): RoleAssignment[] {
    return this.store.list().map((r) => ({ role: r.role, modelId: r.model_id, providerId: r.provider_id, updatedAt: r.updated_at }));
  }

  get(role: ModelRole): RoleAssignment | null {
    const r = this.store.list().find((x) => x.role === role);
    return r ? { role: r.role, modelId: r.model_id, providerId: r.provider_id, updatedAt: r.updated_at } : null;
  }

  set(role: ModelRole, modelId: string | null): RoleAssignment[] {
    if (modelId === null) this.store.remove(role);
    else {
      const found = this.providers.findModel(modelId);
      if (!found) throw new Error(`Unknown model: ${modelId}`);
      this.store.set(role, modelId, found.provider.id);
    }
    return this.list();
  }

  /**
   * Auto-bind unbound roles after provider refresh: chat/coding/planning get
   * the largest capable model, lightweight roles get the smallest one.
   */
  autoAssign(): void {
    const all = this.providers.allModels().filter((m) => m.capabilities.includes('text_generation'));
    if (all.length === 0) return;
    const bySize = [...all].sort((a, b) => (b.parameterCountB ?? 0) - (a.parameterCountB ?? 0));
    const heavy = bySize[0] as ModelInfo | undefined;
    const light = bySize[bySize.length - 1] as ModelInfo | undefined;
    for (const role of ['chat', 'coding', 'planning', 'review'] as ModelRole[]) {
      if (!this.get(role) && heavy) this.store.set(role, heavy.id, heavy.providerId);
    }
    for (const role of ['compression', 'prompt_assistant', 'summarization'] as ModelRole[]) {
      if (!this.get(role) && light) this.store.set(role, light.id, light.providerId);
    }
    const emb = this.providers.allModels().find((m) => m.capabilities.includes('embeddings'));
    if (emb && !this.get('embeddings')) this.store.set('embeddings', emb.id, emb.providerId);
    const vis = all.find((m) => m.capabilities.includes('vision'));
    if (vis && !this.get('vision')) this.store.set('vision', vis.id, vis.providerId);
  }
}
