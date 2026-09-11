/**
 * Typed IPC contract between renderer and main. Transport is two raw channels
 * ("lpai:invoke" for request/response, "lpai:event" for pushed AppEvents),
 * but every method below is validated and typed at both ends.
 */
import type { AppMode, PermissionMode, ResourceMode } from './capabilities.js';
import type { AppConfig, DeepPartial } from './config.js';
import type { HealthReport } from './diagnostics.js';
import type { PromptSuggestion } from './events.js';
import type { MemoryEntry, MemorySearchHit, MemoryType } from './memory.js';
import type { ChatMessage, ModelInfo, ProviderHealth, RoleAssignment } from './models.js';
import type { PermissionDecision, PermissionId, PermissionState } from './permissions.js';
import type { Skill } from './skills.js';
import type { TaskRecord } from './task.js';
import type { ToolManifest } from './tools.js';

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  mode: AppMode;
  projectId?: string;
  messageCount: number;
  summary?: string;
}

export interface SendChatInput {
  conversationId?: string;
  text: string;
  mode: AppMode;
  projectId?: string;
  /** base64 image attachments for vision mode (ephemeral). */
  images?: { mimeType: string; dataBase64: string }[];
}

export interface ProjectInfo {
  id: string;
  path: string;
  name: string;
  kind: string;
  languages: string[];
  frameworks: string[];
  entryPoints: string[];
  scripts: Record<string, string>;
  testCommands: string[];
  fileCount: number;
  lastIndexedAt?: string;
  isGit: boolean;
}

export interface CheckpointInfo {
  id: string;
  label: string;
  taskId?: string;
  createdAt: string;
  fileCount: number;
  gitBranch?: string;
  gitHead?: string;
}

export interface ProviderDescriptor {
  id: string;
  label: string;
  kind: string;
  baseUrl?: string;
  enabled: boolean;
  health: ProviderHealth;
  models: ModelInfo[];
}

export interface InvokeContract {
  'app.info': { args: []; res: { name: string; version: string; dataDir: string; platform: string } };
  'config.get': { args: []; res: AppConfig };
  'config.set': { args: [patch: DeepPartial<AppConfig>]; res: AppConfig };
  'providers.list': { args: []; res: ProviderDescriptor[] };
  'providers.refresh': { args: []; res: ProviderDescriptor[] };
  'providers.health': { args: [providerId: string]; res: ProviderHealth };
  'models.list': { args: []; res: ModelInfo[] };
  'roles.list': { args: []; res: RoleAssignment[] };
  'roles.set': { args: [role: string, modelId: string | null]; res: RoleAssignment[] };
  'chat.send': { args: [input: SendChatInput]; res: { conversationId: string; assistantMessageId: string; taskId?: string } };
  'chat.cancel': { args: [conversationId: string]; res: boolean };
  'conversations.list': { args: []; res: ConversationSummary[] };
  'conversations.messages': { args: [conversationId: string]; res: ChatMessage[] };
  'conversations.delete': { args: [conversationId: string]; res: boolean };
  'conversations.search': { args: [query: string]; res: { conversationId: string; title: string; snippet: string }[] };
  'tasks.list': { args: [statuses?: string[]]; res: TaskRecord[] };
  'tasks.get': { args: [taskId: string]; res: TaskRecord | null };
  'tasks.cancel': { args: [taskId: string]; res: boolean };
  'tasks.recover': { args: [taskId: string, mode: 'rerun' | 'discard']; res: boolean };
  'tools.list': { args: []; res: ToolManifest[] };
  'permissions.state': { args: []; res: PermissionState };
  'permissions.setMode': { args: [mode: PermissionMode]; res: PermissionState };
  'permissions.decide': { args: [requestId: string, decision: PermissionDecision]; res: boolean };
  'permissions.resetGrant': { args: [permission: PermissionId]; res: boolean };
  'memory.list': { args: [status?: string]; res: MemoryEntry[] };
  'memory.add': { args: [content: string, type: MemoryType]; res: MemoryEntry };
  'memory.confirm': { args: [id: string]; res: boolean };
  'memory.delete': { args: [id: string]; res: boolean };
  'memory.search': { args: [query: string]; res: MemorySearchHit[] };
  'knowledge.import': { args: [path?: string]; res: { ok: boolean; message: string } };
  'knowledge.list': { args: []; res: { id: string; name: string; kind: string; size: number; createdAt: string }[] };
  'skills.list': { args: []; res: Skill[] };
  'skills.add': { args: [name: string, description: string, instructions: string]; res: Skill };
  'skills.toggle': { args: [id: string, enabled: boolean]; res: boolean };
  'skills.delete': { args: [id: string]; res: boolean };
  'projects.list': { args: []; res: ProjectInfo[] };
  'projects.add': { args: [path: string]; res: ProjectInfo };
  'projects.remove': { args: [id: string]; res: boolean };
  'projects.reindex': { args: [id: string]; res: boolean };
  'checkpoints.list': { args: []; res: CheckpointInfo[] };
  'checkpoints.restore': { args: [id: string]; res: { ok: boolean; message: string } };
  'diagnostics.health': { args: []; res: HealthReport };
  'diagnostics.selfTest': { args: []; res: HealthReport };
  'diagnostics.export': { args: []; res: { path: string } };
  'prompt.analyze': { args: [inputId: string, text: string, projectId?: string]; res: PromptSuggestion[] };
  'prompt.analyzeDebounced': { args: [inputId: string, text: string, projectId?: string]; res: 'scheduled' };
  'screen.capture': { args: [rect?: CaptureRect]; res: { mimeType: string; dataBase64: string } };
  'screen.captureRegion': { args: []; res: { mimeType: string; dataBase64: string; cancelled?: boolean } };
  'region.submit': { args: [rect: CaptureRect | null]; res: string };
  'recording.status': { args: []; res: { state: 'OK' | 'UNAVAILABLE'; message: string } };
  'recording.analyze': { args: [path: string, question?: string]; res: { ok: boolean; summary?: string; error?: string } };
  'recording.pickAndAnalyze': { args: [question?: string]; res: { ok: boolean; summary?: string; error?: string; cancelled?: boolean } };
  'voice.transcribe': { args: [audioBase64: string, mimeType: string]; res: { text: string; confidence?: number } };
  'voice.speak': { args: [text: string]; res: { audioBase64: string; mimeType: string } };
  'extensions.list': {
    args: [];
    res: { id: string; name: string; version: string; description?: string; active: boolean; error?: string; contributedTools: string[] }[];
  };
  'extensions.uninstall': { args: [id: string]; res: boolean };
  'extensions.reload': { args: []; res: { loaded: string[]; skipped: string[]; errors: { id: string; error: string }[] } };
  'extensions.info': { args: []; res: { dir: string } };
  'overlay.show': { args: []; res: boolean };
  'overlay.hide': { args: []; res: boolean };
  'resource.mode': { args: [mode: ResourceMode | 'auto']; res: ResourceMode };
  'wizard.complete': { args: []; res: boolean };
}

export type IpcMethod = keyof InvokeContract;

export type InvokeResult<R> = { ok: true; data: R } | { ok: false; error: { kind: string; message: string; recovery?: string[] } };

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
