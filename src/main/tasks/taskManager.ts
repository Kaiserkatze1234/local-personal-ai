/**
 * Task system — spec §9 + §51. Persists state transitions so interrupted
 * work is recoverable; exposes AbortControllers so the user can stop work;
 * long tasks run outside the UI thread (renderer only receives events).
 */
import { newId, nowIso } from '../../shared/types/common.js';
import type { AppBus } from '../../shared/types/events.js';
import type { TaskClass, TaskEvent, TaskRecord, TaskStatus } from '../../shared/types/task.js';
import { TERMINAL_TASK_STATUSES } from '../../shared/types/task.js';
import { AppError } from '../core/errors.js';
import type { SubLogger } from '../core/logger.js';
import type { TaskRepo } from '../storage/repositories.js';

const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  queued: ['analyzing', 'executing', 'cancelled', 'failed'],
  analyzing: ['executing', 'waiting_for_permission', 'completed', 'failed', 'cancelled'],
  waiting_for_permission: ['executing', 'cancelled', 'failed'],
  executing: ['verifying', 'completed', 'waiting_for_permission', 'paused', 'failed', 'cancelled'],
  verifying: ['completed', 'executing', 'failed', 'cancelled'],
  completed: [],
  failed: ['executing'], // retry
  cancelled: [],
  paused: ['executing', 'queued', 'cancelled', 'analyzing'],
};

export interface CreateTaskInput {
  title: string;
  userRequest: string;
  taskClass: TaskClass;
  priority?: number;
  conversationId?: string;
  projectId?: string;
}

export class TaskManager {
  private controllers = new Map<string, AbortController>();

  constructor(
    private repo: TaskRepo,
    private bus: AppBus,
    private log: SubLogger,
    /** Called on cancel so anything waiting on this task can unblock. */
    private onCancelled?: (taskId: string) => void,
  ) {}

  create(input: CreateTaskInput): TaskRecord {
    const at = nowIso();
    const t: TaskRecord = {
      id: newId('task'),
      title: input.title.slice(0, 80),
      userRequest: input.userRequest,
      status: 'queued',
      priority: input.priority ?? 0,
      taskClass: input.taskClass,
      createdAt: at,
      updatedAt: at,
      phases: [],
      involvedFiles: [],
      toolsUsed: [],
      modelSelections: [],
      checkpointIds: [],
      errors: [],
      conversationId: input.conversationId,
      projectId: input.projectId,
    };
    this.repo.upsert(t);
    this.repo.appendEvent({ taskId: t.id, at, type: 'created', payload: { taskClass: input.taskClass } });
    this.bus.emit({ type: 'task.updated', taskId: t.id, status: 'queued' });
    return t;
  }

  get(id: string): TaskRecord | null {
    return this.repo.get(id);
  }

  list(statuses?: TaskStatus[]): TaskRecord[] {
    return this.repo.list(statuses);
  }

  events(id: string): TaskEvent[] {
    return this.repo.events(id);
  }

  /** Transition + persist + broadcast. Invalid transitions are bugs — throw. */
  transition(id: string, to: TaskStatus, extra: Partial<TaskRecord> = {}, note?: string): TaskRecord {
    const t = this.repo.get(id);
    if (!t) throw AppError.invalidState(`Task ${id} not found`);
    if (t.status === to) return t;
    if (!ALLOWED[t.status]?.includes(to) && !TERMINAL_TASK_STATUSES.includes(to)) {
      throw AppError.invalidState(`Illegal task transition ${t.status} -> ${to} for ${id}`);
    }
    const at = nowIso();
    if (note) t.phases.push({ name: note, startedAt: at });
    else if (t.currentPhase) {
      const last = t.phases[t.phases.length - 1];
      if (last && !last.endedAt) last.endedAt = at;
    }
    Object.assign(t, extra, { status: to, updatedAt: at });
    this.repo.upsert(t);
    this.repo.appendEvent({ taskId: id, at, type: `status:${to}`, payload: note ? { note } : undefined });
    this.bus.emit({ type: 'task.updated', taskId: id, status: to, summary: t.summary });
    return t;
  }

  /** Register an execution controller so cancel() can abort live work. */
  begin(id: string): AbortSignal {
    const ctrl = new AbortController();
    this.controllers.set(id, ctrl);
    return ctrl.signal;
  }

  end(id: string): void {
    this.controllers.delete(id);
  }

  cancel(id: string): boolean {
    const t = this.repo.get(id);
    if (!t || TERMINAL_TASK_STATUSES.includes(t.status)) return false;
    this.onCancelled?.(id);
    this.controllers.get(id)?.abort(new Error('cancelled by user'));
    this.transition(id, 'cancelled', { summary: 'Cancelled by user.' }, 'cancelled');
    return true;
  }

  recordTool(id: string, tool: string): void {
    const t = this.repo.get(id);
    if (!t) return;
    if (!t.toolsUsed.includes(tool)) t.toolsUsed.push(tool);
    t.updatedAt = nowIso();
    this.repo.upsert(t);
  }

  recordCheckpoint(id: string, checkpointId: string): void {
    const t = this.repo.get(id);
    if (!t) return;
    if (!t.checkpointIds.includes(checkpointId)) t.checkpointIds.push(checkpointId);
    t.updatedAt = nowIso();
    this.repo.upsert(t);
  }

  recordFile(id: string, file: string): void {
    const t = this.repo.get(id);
    if (!t) return;
    if (!t.involvedFiles.includes(file)) t.involvedFiles.push(file);
    this.repo.upsert(t);
  }

  recordError(id: string, kind: string, message: string): void {
    const t = this.repo.get(id);
    if (!t) return;
    t.errors.push({ kind, message, at: nowIso() });
    t.updatedAt = nowIso();
    this.repo.upsert(t);
    this.repo.appendEvent({ taskId: id, at: t.updatedAt, type: 'error', payload: { kind, message } });
    this.log.error(`task ${id} error (${kind}): ${message}`, id);
  }

  finish(id: string, status: 'completed' | 'failed', summary: string, extra: Partial<TaskRecord> = {}): TaskRecord {
    return this.transition(id, status, { summary, ...extra }, status);
  }

  /** §51 crash recovery: anything that was mid-flight becomes paused+recoverable. */
  markInterruptedOnBoot(): TaskRecord[] {
    const active: TaskStatus[] = ['queued', 'analyzing', 'executing', 'verifying', 'waiting_for_permission'];
    const interrupted = this.repo
      .list(active)
      .map((t) => this.transition(t.id, 'paused', { summary: t.summary ?? 'Interrupted by app exit — recovery offered.' }, 'interrupted'));
    if (interrupted.length > 0) this.log.info(`recovery: ${interrupted.length} interrupted task(s) marked paused`);
    return interrupted;
  }

  activeCount(): number {
    return this.repo.list(['executing', 'analyzing', 'verifying', 'queued', 'waiting_for_permission']).length;
  }
}
