/** Tool system — spec §10. Tools are first-class modules returning structured results. */
import type { JsonSchema } from './common.js';
import type { PermissionId } from './permissions.js';

export type ErrorKind =
  | 'user'
  | 'model'
  | 'provider'
  | 'tool'
  | 'timeout'
  | 'permission_denied'
  | 'filesystem'
  | 'invalid_state'
  | 'resource_exhaustion'
  | 'not_implemented';

export interface ToolManifest {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Null = no permission required (pure read of app-internal state). */
  permission: PermissionId | null;
  mutating: boolean;
  /** Development phase that ships this tool (§70); info for the Tools panel. */
  phase?: number;
}

export interface ToolError {
  kind: ErrorKind;
  message: string;
  /** Suggested recovery actions for the UI (§39). */
  recovery?: string[];
}

export interface ToolResult {
  ok: boolean;
  /** Short operational summary shown to the user (transparency, §3.7). */
  summary: string;
  data?: unknown;
  error?: ToolError;
  exitCode?: number;
  /** Truncated raw output kept for inspection, not for context injection. */
  stdoutPreview?: string;
  stderrPreview?: string;
}

export interface ToolRunRecord {
  id?: number;
  taskId?: string;
  tool: string;
  ok: boolean;
  input: unknown;
  result?: ToolResult;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
}
