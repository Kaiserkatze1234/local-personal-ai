/** Task system — spec §9. Every substantial agent operation is a TaskRecord. */
import type { ModelRole } from './capabilities.js';

export type TaskStatus =
  | 'queued'
  | 'analyzing'
  | 'waiting_for_permission'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused';

export const TERMINAL_TASK_STATUSES: TaskStatus[] = ['completed', 'failed', 'cancelled'];

/** Task classes drive model routing (§7) and context strategy (§54). */
export type TaskClass =
  | 'chat'
  | 'informational'
  | 'classification'
  | 'prompt_assist'
  | 'memory_compression'
  | 'planning'
  | 'coding'
  | 'code_review'
  | 'debugging'
  | 'vision'
  | 'summarization'
  | 'extraction'
  | 'file_ops';

export interface TaskPhaseStep {
  name: string;
  startedAt: string;
  endedAt?: string;
  note?: string;
}

export interface VerificationResult {
  attempted: boolean;
  passed: boolean;
  /** e.g. "project test command", "content check", "exit code", "none available" */
  method: string;
  details: string;
  at: string;
}

export interface TaskModelSelection {
  role: ModelRole;
  providerId: string;
  modelId: string;
  /** High-level, user-readable rationale (no hidden reasoning, §7). */
  reason: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  userRequest: string;
  status: TaskStatus;
  priority: number;
  taskClass: TaskClass;
  createdAt: string;
  updatedAt: string;
  currentPhase?: string;
  phases: TaskPhaseStep[];
  involvedFiles: string[];
  toolsUsed: string[];
  modelSelections: TaskModelSelection[];
  checkpointIds: string[];
  errors: { kind: string; message: string; at: string }[];
  verification?: VerificationResult;
  summary?: string;
  conversationId?: string;
  projectId?: string;
}

export interface TaskEvent {
  id?: number;
  taskId: string;
  at: string;
  type: string;
  payload?: unknown;
}
