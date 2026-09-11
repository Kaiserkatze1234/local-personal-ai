/**
 * Tool registry — spec §10. Tools are first-class modules; every call is
 * schema-validated, permission-gated, structured, logged, and interruptible.
 */
import type { JsonSchema } from '../../shared/types/common.js';
import { nowIso } from '../../shared/types/common.js';
import type { AppBus } from '../../shared/types/events.js';
import type { ToolDefinition } from '../../shared/types/models.js';
import type { ToolManifest, ToolResult } from '../../shared/types/tools.js';
import { validateJson } from '../../shared/util/jsonSchema.js';
import { AppError } from '../core/errors.js';
import type { SubLogger } from '../core/logger.js';
import type { PermissionService } from '../permissions/permissionService.js';
import type { ToolRunRepo } from '../storage/repositories.js';

export interface ToolRunContext {
  taskId?: string;
  signal?: AbortSignal;
  log: SubLogger;
  /** Resolved filesystem scope from config (set by the container). */
  fsRoots: () => { read: string[]; write: string[] };
  cwd: () => string | undefined;
}

export interface RegisteredTool {
  manifest: ToolManifest;
  run: (input: Record<string, unknown>, ctx: ToolRunContext) => Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  constructor(
    private permissions: PermissionService,
    private toolRuns: ToolRunRepo,
    private bus: AppBus,
    private log: SubLogger,
    /** Extra delay budget per tool call beyond model time (safety net). */
    private defaultTimeoutMs = 10 * 60_000,
    /** Optional risk assessor (e.g. dangerous-command scan) consulted before the permission check. */
    private assessRisk?: (name: string, input: Record<string, unknown>) => { dangerous?: boolean },
  ) {}

  register(manifest: ToolManifest, run: RegisteredTool['run']): void {
    if (this.tools.has(manifest.name)) throw new Error(`Tool already registered: ${manifest.name}`);
    this.tools.set(manifest.name, { manifest, run });
  }

  listManifests(): ToolManifest[] {
    return [...this.tools.values()].map((t) => t.manifest);
  }

  /** Definitions handed to the model when tool_calling is available. */
  definitions(): ToolDefinition[] {
    return this.listManifests().map((m) => ({
      name: m.name,
      description: m.description,
      parameters: (m.inputSchema ?? {}) as Record<string, unknown>,
    }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async call(name: string, input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        summary: `Unknown tool "${name}"`,
        error: { kind: 'tool', message: `Unknown tool "${name}"`, recovery: ['Check tools.list for available tools'] },
      };
    }
    const started = nowIso();
    const t0 = Date.now();

    const v = validateJson(tool.manifest.inputSchema as JsonSchema, input);
    if (!v.ok) {
      const msg = `Invalid input for ${name}: ${v.errors.join('; ')}`;
      this.toolRuns.record({
        tool: name,
        ok: false,
        input,
        startedAt: started,
        endedAt: nowIso(),
        taskId: ctx.taskId,
        durationMs: Date.now() - t0,
        result: { ok: false, summary: msg, error: { kind: 'user', message: msg, recovery: ['Fix the arguments and retry'] } },
      });
      return { ok: false, summary: msg, error: { kind: 'user', message: msg } };
    }

    if (tool.manifest.permission) {
      const risk = this.assessRisk?.(name, input) ?? {};
      // Never park a tool indefinitely: a task cancel/timeout must also
      // interrupt a pending permission wait (§9 "user must be able to stop").
      const permissionPromise = this.permissions.check({
        permission: tool.manifest.permission,
        action: `Use tool "${name}"`,
        detail: describeInput(input),
        taskId: ctx.taskId,
        dangerous: risk.dangerous,
      });
      const watcher: { unwatch: (() => void) | null } = { unwatch: null };
      const aborted = new Promise<'aborted'>((resolveAborted) => {
        if (ctx.signal?.aborted) return resolveAborted('aborted');
        const onAbort = (): void => resolveAborted('aborted');
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        watcher.unwatch = () => ctx.signal?.removeEventListener('abort', onAbort);
      });
      try {
        const outcome = await Promise.race([
          permissionPromise.then(
            () => 'granted' as const,
            (err: unknown) => ({ err }) as const,
          ),
          aborted,
        ]);
        if (outcome === 'aborted') {
          return {
            ok: false,
            summary: `Tool ${name} was cancelled while waiting for permission.`,
            error: { kind: 'invalid_state', message: 'cancelled while awaiting permission' },
          };
        }
        if (outcome !== 'granted') {
          const message = outcome.err instanceof AppError ? outcome.err.message : String(outcome.err);
          this.bus.emit({ type: 'tool.run', tool: name, ok: false, summary: `denied: ${message}` });
          return { ok: false, summary: `Permission denied for ${name}`, error: { kind: 'permission_denied', message } };
        }
      } finally {
        watcher.unwatch?.();
      }
    }

    // bounded execution: abort via task signal, hard timeout as backstop
    const ctrl = new AbortController();
    const abortFromTask = (): void => ctrl.abort(new Error('cancelled'));
    ctx.signal?.addEventListener('abort', abortFromTask, { once: true });
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), this.defaultTimeoutMs);
    timer.unref?.();

    let result: ToolResult;
    try {
      result = await Promise.race([
        tool.run(input, { ...ctx, signal: ctrl.signal }),
        new Promise<ToolResult>((resolve) => {
          ctrl.signal.addEventListener(
            'abort',
            () => {
              const isTimeout = !ctx.signal?.aborted;
              resolve({
                ok: false,
                summary: isTimeout
                  ? `Tool ${name} timed out after ${this.defaultTimeoutMs / 1000}s and was cancelled.`
                  : `Tool ${name} cancelled.`,
                error: { kind: isTimeout ? 'timeout' : 'invalid_state', message: isTimeout ? 'timeout' : 'cancelled by user' },
              });
            },
            { once: true },
          );
        }),
      ]);
    } catch (err) {
      if (err instanceof AppError && err.kind === 'permission_denied') throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`tool ${name} threw: ${message}`, ctx.taskId);
      result = { ok: false, summary: `Tool ${name} failed: ${message}`, error: { kind: 'tool', message } };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', abortFromTask);
    }

    this.toolRuns.record({
      tool: name,
      ok: result.ok,
      input,
      result,
      startedAt: started,
      endedAt: nowIso(),
      taskId: ctx.taskId,
      durationMs: Date.now() - t0,
    });
    this.bus.emit({ type: 'tool.run', taskId: ctx.taskId, tool: name, ok: result.ok, summary: result.summary });
    return result;
  }
}

function describeInput(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${s.length > 160 ? `${s.slice(0, 160)}…` : s}`);
  }
  return parts.join(', ').slice(0, 600);
}
