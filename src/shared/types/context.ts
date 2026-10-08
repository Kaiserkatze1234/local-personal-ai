/** Context engine — spec §29/§30/§54. */
import type { TaskClass } from './task.js';

export type ContextSource = 'conversation' | 'task' | 'project' | 'file' | 'memory' | 'skill' | 'screen' | 'system' | 'provider';

export interface ContextItem {
  source: ContextSource;
  /** Reference to the origin (message id, file path, memory id…) for transparency. */
  ref: string;
  /** 0..1 combined ranking score. */
  relevance: number;
  estimatedTokens: number;
  label: string;
  content: string;
  /** Fresh = produced this session (last turn, live capture), stale = retrieved. */
  fresh: boolean;
  /** Pinned items (current task state, critical instructions) survive compression. */
  pinned?: boolean;
}

export interface ContextBudget {
  /** Total tokens available to prompt context. */
  maxTokens: number;
  reservedForOutput: number;
}

export interface ContextBuildRequest {
  conversationId?: string;
  userText: string;
  taskClass: TaskClass;
  projectId?: string;
  taskId?: string;
  includeScreen?: boolean;
  imageAttachments?: number;
}
