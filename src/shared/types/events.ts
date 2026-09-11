/** Typed application events (spec §3.5 event-driven design). Flows core -> UI. */

import type { ResourceMode } from './capabilities.js';
import type { ProviderHealth } from './models.js';
import type { PermissionDecision, PermissionRequest } from './permissions.js';
import type { TaskStatus } from './task.js';

export interface PromptSuggestion {
  id: string;
  kind: 'missing_requirement' | 'ambiguity' | 'contradiction' | 'add_detail' | 'format_hint' | 'related_files';
  text: string;
  /** Text the user can insert into their prompt on accept. */
  insertable?: string;
}

export interface ProactiveSuggestion {
  id: string;
  ruleId: string;
  text: string;
  reason: string;
  confidence: number;
  /** 'inline' shows in chat; 'notify' uses a system notification; 'silent' logs only. */
  action: 'inline' | 'notify' | 'silent';
}

export type AppEvent =
  | { type: 'task.updated'; taskId: string; status: TaskStatus; summary?: string }
  | { type: 'chat.stream'; conversationId: string; messageId: string; delta: string }
  | { type: 'chat.message_added'; conversationId: string }
  | { type: 'chat.cancelled'; conversationId: string }
  | { type: 'permission.requested'; request: PermissionRequest }
  | { type: 'permission.resolved'; requestId: string; decision: PermissionDecision }
  | { type: 'tool.run'; taskId?: string; tool: string; ok: boolean; summary: string }
  | { type: 'provider.status'; health: ProviderHealth }
  | { type: 'index.progress'; jobId: string; done: number; total: number; label: string }
  | { type: 'checkpoint.created'; checkpointId: string; taskId?: string; files: number }
  | { type: 'prompt.suggestions'; inputId: string; suggestions: PromptSuggestion[] }
  | { type: 'proactive.suggestion'; suggestion: ProactiveSuggestion }
  | { type: 'resource.mode'; mode: ResourceMode; reason: string }
  | { type: 'build.failed'; projectId?: string; command: string; detail: string }
  | { type: 'memory.candidate'; entryId: string; preview: string }
  | { type: 'log.entry'; level: 'debug' | 'info' | 'warn' | 'error'; subsystem: string; message: string };

/**
 * Structural contract services use (implemented by main/core/eventBus).
 * Keeps capability modules decoupled from the concrete bus class (§3.3).
 */
export interface AppBus {
  emit(event: AppEvent): void;
  onAny(fn: (e: AppEvent) => void): () => void;
  on<K extends AppEvent['type']>(type: K, fn: (e: Extract<AppEvent, { type: K }>) => void): () => void;
}
