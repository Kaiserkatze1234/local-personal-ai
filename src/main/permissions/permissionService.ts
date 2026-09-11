/**
 * Permission service — spec §11/§26/§36.
 * Three modes (SAFE / BALANCED / ADVANCED), a per-permission default rule
 * matrix, user confirmations through the UI (event + decide), and persistent
 * grants that the user can revoke at any time.
 */

import type { PermissionMode } from '../../shared/types/capabilities.js';
import { newId, nowIso } from '../../shared/types/common.js';
import type { AppBus } from '../../shared/types/events.js';
import type { PermissionDecision, PermissionId, PermissionRequest, PermissionState, RuleDecision } from '../../shared/types/permissions.js';
import { ALL_PERMISSIONS } from '../../shared/types/permissions.js';
import type { ConfigService } from '../core/config.js';
import { AppError } from '../core/errors.js';
import type { SubLogger } from '../core/logger.js';
import type { PermissionGrantRepo } from '../storage/repositories.js';

type Matrix = Record<PermissionId, RuleDecision>;

/** Default rules per mode (§11). "ask" routes to the user; "deny" blocks. */
export const MODE_MATRIX: Record<PermissionMode, Matrix> = {
  SAFE: {
    'fs.read': 'allow',
    'fs.write': 'ask',
    'fs.delete': 'deny',
    'commands.execute': 'ask',
    'programs.launch': 'deny',
    'screen.inspect': 'ask',
    'screen.capture': 'ask',
    'mic.access': 'ask',
    'network.access': 'ask',
    'project.modify': 'ask',
    'software.install': 'deny',
  },
  BALANCED: {
    'fs.read': 'allow',
    'fs.write': 'ask',
    'fs.delete': 'ask',
    'commands.execute': 'ask',
    'programs.launch': 'ask',
    'screen.inspect': 'ask',
    'screen.capture': 'ask',
    'mic.access': 'ask',
    'network.access': 'ask',
    'project.modify': 'allow',
    'software.install': 'deny',
  },
  ADVANCED: {
    'fs.read': 'allow',
    'fs.write': 'allow',
    'fs.delete': 'ask',
    'commands.execute': 'allow',
    'programs.launch': 'allow',
    'screen.inspect': 'allow',
    'screen.capture': 'allow',
    'mic.access': 'allow',
    'network.access': 'allow',
    'project.modify': 'allow',
    'software.install': 'ask',
  },
};

export interface CheckInput {
  permission: PermissionId;
  action: string;
  detail: string;
  taskId?: string;
  /** Commands flagged by the danger scan always require confirmation. */
  forceAsk?: boolean;
  dangerous?: boolean;
}

export class PermissionService {
  private pending = new Map<string, { request: PermissionRequest; resolve: (d: PermissionDecision) => void }>();
  private sessionGrants = new Set<PermissionId>();

  constructor(
    private config: ConfigService,
    private grants: PermissionGrantRepo,
    private bus: AppBus,
    private log: SubLogger,
  ) {}

  private mode(): PermissionMode {
    return this.config.get().tools.permissionMode;
  }

  effectiveRules(): Record<string, RuleDecision> {
    const matrix = MODE_MATRIX[this.mode()];
    const out: Record<string, RuleDecision> = {};
    for (const p of ALL_PERMISSIONS) {
      const persistent = this.grants.get(p);
      out[p] = persistent === 'allow' ? 'allow' : persistent === 'deny' ? 'deny' : this.sessionGrants.has(p) ? 'allow' : matrix[p];
    }
    return out;
  }

  state(): PermissionState {
    return {
      mode: this.mode(),
      grants: this.grants.all().map((g) => ({
        permission: g.permission as PermissionId,
        decision: g.decision,
        scope: 'persistent' as const,
        updatedAt: g.updated_at,
      })),
      pending: [...this.pending.values()].map((p) => p.request),
      effective: this.effectiveRules(),
    };
  }

  setMode(mode: PermissionMode): PermissionState {
    this.config.patch({ tools: { permissionMode: mode } });
    return this.state();
  }

  resetGrant(permission: PermissionId): boolean {
    this.grants.clear(permission);
    this.sessionGrants.delete(permission);
    return true;
  }

  /** Returns 'allow' to proceed immediately; otherwise parks in ask() and resolves later. */
  async check(input: CheckInput): Promise<'allow'> {
    const rule = this.effectiveRules()[input.permission] ?? 'deny';

    if (input.dangerous) {
      // §11 ADVANCED: "still blocks clearly destructive operations unless
      // explicitly authorized" — a persistent user grant counts as explicit.
      if (this.grants.get(input.permission) === 'allow') return 'allow';
      if (rule === 'deny') {
        throw AppError.permission(
          `Dangerous operation blocked: ${input.action}. Allowed only after you grant "${input.permission}" permanently in Settings.`,
        );
      }
      return this.ask({ ...input, forceAsk: true, dangerous: true });
    }

    if (rule === 'allow') return 'allow';
    if (rule === 'deny') {
      throw AppError.permission(
        `Permission "${input.permission}" is denied in ${this.mode()} mode. Action: ${input.action}. Raise the mode or allow it explicitly in Settings → Tools.`,
      );
    }
    return this.ask(input);
  }

  private ask(input: CheckInput): Promise<'allow'> {
    const request: PermissionRequest = {
      id: newId('perm'),
      permission: input.permission,
      action: input.action,
      detail: input.detail,
      taskId: input.taskId,
      createdAt: nowIso(),
      flaggedDangerous: input.dangerous,
    };
    return new Promise<'allow'>((resolvePromise, rejectPromise) => {
      const resolve = (decision: PermissionDecision): void => {
        if (decision === 'deny') {
          rejectPromise(AppError.permission(`User denied: ${input.action}`));
        } else {
          if (decision === 'allow_session') this.sessionGrants.add(input.permission);
          if (decision === 'allow_persistent') this.grants.set(input.permission, 'allow');
          resolvePromise('allow');
        }
      };
      this.pending.set(request.id, { request, resolve });
      this.log.info(`permission requested: ${input.permission} — ${input.action}`);
      this.bus.emit({ type: 'permission.requested', request });
    });
  }

  /** Called from the UI (via api). Returns false for unknown request ids. */
  decide(requestId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    this.bus.emit({ type: 'permission.resolved', requestId, decision });
    entry.resolve(decision);
    return true;
  }

  /** When a task is cancelled, deny anything it was waiting on. */
  denyForTask(taskId: string, reason = 'task cancelled'): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.request.taskId === taskId) {
        this.pending.delete(id);
        entry.resolve('deny');
        void reason;
      }
    }
  }

  /** Drop session grants for a specific set (used when unloading extensions). */
  revokeSessionGrantsFor(perms: PermissionId[]): void {
    for (const p of perms) this.sessionGrants.delete(p);
  }

  /** Clear session-scoped grants (e.g. on app mode change). */
  clearSession(): void {
    this.sessionGrants.clear();
  }
}
