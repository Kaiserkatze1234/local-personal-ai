/**
 * Model routing — spec §7. Never "biggest model for everything":
 * role bindings first, then capability- and resource-aware choice.
 * Decisions carry a short human-readable reason (no hidden reasoning).
 */
import type { ModelCapability, ModelRole } from '../../shared/types/capabilities.js';
import type { ModelInfo } from '../../shared/types/models.js';
import type { TaskClass } from '../../shared/types/task.js';
import type { ConfigService } from '../core/config.js';
import { AppError } from '../core/errors.js';
import type { ModelRoleService } from './modelRegistry.js';
import type { ProviderRegistry } from './registry.js';

export interface RouteRequirements {
  needsVision?: boolean;
  needsToolCalling?: boolean;
  needsStructuredOutput?: boolean;
  minContextTokens?: number;
  /** Prefer the cheapest capable model (light tasks, §55). */
  preferSmall?: boolean;
}

export interface RouteDecision {
  modelId: string;
  providerId: string;
  model: ModelInfo;
  reason: string;
  role: ModelRole;
}

const LIGHTWEIGHT_TASKS = new Set<TaskClass>(['classification', 'prompt_assist', 'memory_compression', 'summarization', 'extraction']);

export class ModelRouter {
  constructor(
    private providers: ProviderRegistry,
    private roles: ModelRoleService,
    private config: ConfigService,
  ) {}

  select(role: ModelRole, taskClass: TaskClass, req: RouteRequirements = {}): RouteDecision {
    const cfg = this.config.get();
    const requiredCaps = new Set<ModelCapability>(['text_generation']);
    if (req.needsVision) requiredCaps.add('vision');
    if (req.needsToolCalling) requiredCaps.add('tool_calling');
    if (req.needsStructuredOutput) requiredCaps.add('structured_output');

    const providerUsable = (m: ModelInfo): boolean => {
      const found = this.providers.findModel(m.id);
      return !!found && found.provider.enabled && found.provider.health.state === 'OK' && !!found.provider.adapter.chat;
    };
    const usable = (m: ModelInfo): boolean =>
      [...requiredCaps].every((c) => m.capabilities.includes(c)) &&
      (req.minContextTokens === undefined || m.contextLength >= req.minContextTokens) &&
      providerUsable(m);

    // 1) explicit user override (Settings → AI → routing override)
    const override = cfg.ai.routingOverride[role];
    if (override) {
      const found = this.providers.findModel(override);
      if (found && usable(found.model)) {
        return {
          modelId: found.model.id,
          providerId: found.provider.id,
          model: found.model,
          role,
          reason: `User override for role "${role}".`,
        };
      }
    }

    // 2) persisted role binding
    const binding = this.roles.get(role);
    if (binding) {
      const found = this.providers.findModel(binding.modelId);
      if (found && usable(found.model)) {
        return {
          modelId: found.model.id,
          providerId: found.provider.id,
          model: found.model,
          role,
          reason: `Bound to role "${role}" by ${found.provider.label}.`,
        };
      }
      if (found && !usable(found.model)) {
        // fall through with a note — the bound model cannot do this task
      }
    }

    // 3) automatic selection: smallest capable for light tasks, largest for heavy
    const candidates = this.providers.allModels().filter(usable);
    if (candidates.length === 0) {
      throw AppError.provider(
        req.needsVision
          ? 'No installed model supports vision. Add a vision-capable model (e.g. a qwen2.5-VL or llava variant) to your provider, or run without images.'
          : req.needsToolCalling
            ? 'No installed model advertises tool calling. Bind a tool-capable model in Settings → AI, or the agent will answer without tools.'
            : 'No text-generation model is available. Start Ollama (or another provider) and install a model.',
      );
    }
    const preferSmall = req.preferSmall || LIGHTWEIGHT_TASKS.has(taskClass) || role === 'prompt_assistant' || role === 'compression';
    const lowRes = cfg.performance.mode === 'LOW_RESOURCE';
    const sorted = [...candidates].sort((a, b) => {
      const sa = (a.parameterCountB ?? 7) + (preferSmall || lowRes ? 0 : 0);
      const sb = b.parameterCountB ?? 7;
      return preferSmall || lowRes ? sa - sb : sb - sa;
    });
    const pick = sorted[0] as ModelInfo;
    return {
      modelId: pick.id,
      providerId: pick.providerId,
      model: pick,
      role,
      reason: `${preferSmall || lowRes ? 'Smallest' : 'Largest'} capable model for "${taskClass}" (${lowRes ? 'resource mode ' : ''}${preferSmall ? 'light task' : 'heavy task'}): ${pick.name}`,
    };
  }

  /** Which model *would* be chosen, for the settings preview. */
  preview(role: ModelRole, taskClass: TaskClass): { modelId: string; reason: string } | null {
    try {
      const d = this.select(role, taskClass);
      return { modelId: d.modelId, reason: d.reason };
    } catch {
      return null;
    }
  }
}
