/**
 * App state store (zustand). The UI is a thin projection of main-process
 * state + events: panels read store slices; all mutations go through the
 * typed api. Keeps §43 "user always understands current state" tractable.
 */
import { create } from 'zustand';
import type { AppMode } from '../../shared/types/capabilities.js';
import type { AppConfig } from '../../shared/types/config.js';
import type { HealthReport } from '../../shared/types/diagnostics.js';
import type { AppEvent, ProactiveSuggestion, PromptSuggestion } from '../../shared/types/events.js';
import type { ConversationSummary, ProjectInfo, ProviderDescriptor, SendChatInput } from '../../shared/types/ipc.js';
import type { MemoryEntry, MemorySearchHit } from '../../shared/types/memory.js';
import type { ChatMessage, ModelInfo, ProviderHealth, RoleAssignment } from '../../shared/types/models.js';
import type { PermissionDecision, PermissionRequest, PermissionState } from '../../shared/types/permissions.js';
import type { Skill } from '../../shared/types/skills.js';
import type { TaskRecord } from '../../shared/types/task.js';
import * as api from '../lib/api.js';

export interface UiMessage extends ChatMessage {
  streaming?: boolean;
}

interface AppState {
  connected: boolean;
  info: { name: string; version: string; dataDir: string; platform: string } | null;
  config: AppConfig | null;
  mode: AppMode;
  activeProjectId: string | null;

  providers: ProviderDescriptor[];
  models: ModelInfo[];
  roles: RoleAssignment[];

  conversations: ConversationSummary[];
  activeConvId: string | null;
  messages: UiMessage[];
  sending: boolean;
  lastTaskId: string | null;

  promptSuggestions: PromptSuggestion[];

  tasks: TaskRecord[];
  permissions: PermissionState | null;
  permissionQueue: PermissionRequest[];
  memory: MemoryEntry[];
  memoryHits: MemorySearchHit[];
  skills: Skill[];
  projects: ProjectInfo[];
  health: HealthReport | null;
  notices: ProactiveSuggestion[];
  error: string | null;

  init(): Promise<void>;
  setMode(m: AppMode): void;
  setProject(id: string | null): void;
  send(text: string, images?: { mimeType: string; dataBase64: string }[]): Promise<void>;
  cancelChat(): Promise<void>;
  newChat(): void;
  openConversation(id: string): Promise<void>;
  analyzePrompt(text: string): void;
  refreshProviders(): Promise<void>;
  setRole(role: string, modelId: string | null): Promise<void>;
  patchConfig(patch: object): Promise<void>;
  loadSidePanels(): Promise<void>;
  decidePermission(id: string, decision: PermissionDecision): Promise<void>;
  cancelTask(id: string): Promise<void>;
  recoverTask(id: string, mode: 'rerun' | 'discard'): Promise<void>;
  confirmMemory(id: string): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  addMemory(content: string): Promise<void>;
  searchMemory(q: string): Promise<void>;
  importKnowledge(): Promise<void>;
  toggleSkill(id: string, enabled: boolean): Promise<void>;
  deleteSkill(id: string): Promise<void>;
  addProject(): Promise<void>;
  reindexProject(id: string): Promise<void>;
  removeProject(id: string): Promise<void>;
  refreshHealth(): Promise<void>;
  runSelfTest(): Promise<void>;
  exportDiagnostics(): Promise<void>;
  setResourceMode(mode: 'LOW_RESOURCE' | 'BALANCED' | 'PERFORMANCE' | 'auto'): Promise<void>;
  toggleOverlay(on: boolean): Promise<void>;
  completeWizard(): Promise<void>;
  dismissNotice(id: string): void;
  applyEvent(e: AppEvent): void;
}

let promptTimer: ReturnType<typeof setTimeout> | null = null;
let promptSeq = 0;

export const useStore = create<AppState>((set, get) => ({
  connected: false,
  info: null,
  config: null,
  mode: 'CHAT',
  activeProjectId: null,
  providers: [],
  models: [],
  roles: [],
  conversations: [],
  activeConvId: null,
  messages: [],
  sending: false,
  lastTaskId: null,
  promptSuggestions: [],
  tasks: [],
  permissions: null,
  permissionQueue: [],
  memory: [],
  memoryHits: [],
  skills: [],
  projects: [],
  health: null,
  notices: [],
  error: null,

  async init() {
    try {
      const info = await api.call('app.info');
      const [config, providers, models, roles, conversations, tasks] = await Promise.all([
        api.call('config.get'),
        api.call('providers.list'),
        api.call('models.list'),
        api.call('roles.list'),
        api.call('conversations.list'),
        api.call('tasks.list'),
      ]);
      set({ connected: true, info, config, providers, models, roles, conversations, tasks, error: null });
      api.onEvent((e) => get().applyEvent(e));
      const first = conversations[0];
      if (first) await get().openConversation(first.id);
      else set({ activeConvId: null, messages: [] });
      await get().refreshHealth();
    } catch (err) {
      set({ connected: false, error: err instanceof api.ApiError ? err.message : String(err) });
    }
  },

  setMode(m) {
    set({ mode: m });
  },

  setProject(id) {
    set({ activeProjectId: id });
  },

  async send(text, images) {
    const trimmed = text.trim();
    if (!trimmed || get().sending) return;
    set({ sending: true, promptSuggestions: [], error: null });
    const optimistic: UiMessage = { id: `local_${Date.now()}`, role: 'user', content: trimmed, createdAt: new Date().toISOString() };
    set((s) => ({ messages: [...s.messages, optimistic] }));
    try {
      const input: SendChatInput = {
        conversationId: get().activeConvId ?? undefined,
        text: trimmed,
        mode: get().mode,
        projectId: get().activeProjectId ?? undefined,
        images,
      };
      const res = await api.call('chat.send', input);
      if (res.conversationId !== get().activeConvId) {
        set({ activeConvId: res.conversationId });
        await get().openConversation(res.conversationId);
      }
      set({ lastTaskId: res.taskId ?? null });
      if (get().mode !== 'CHAT') {
        // agent mode resolves asynchronously; stream events + task updates arrive
        set({ sending: false });
        void get().loadSidePanels();
      } else {
        await get().openConversation(res.conversationId);
        set({ sending: false });
      }
    } catch (err) {
      set({ error: err instanceof api.ApiError ? err.message : String(err), sending: false });
      await get().openConversation(get().activeConvId ?? '');
    }
  },

  async cancelChat() {
    const cid = get().activeConvId;
    if (!cid) return;
    try {
      await api.call('chat.cancel', cid);
    } finally {
      set({ sending: false });
    }
  },

  newChat() {
    set({ activeConvId: null, messages: [], promptSuggestions: [] });
  },

  async openConversation(id) {
    if (!id) {
      set({ activeConvId: null, messages: [] });
      return;
    }
    try {
      const msgs = await api.call('conversations.messages', id);
      set({ activeConvId: id, messages: msgs.map((m) => ({ ...m })) });
    } catch {
      /* conversation may be gone; ignore */
    }
  },

  analyzePrompt(text) {
    if (!get().config?.promptAssistant.enabled) return;
    if (promptTimer) clearTimeout(promptTimer);
    const inputId = `p${++promptSeq}`;
    promptTimer = setTimeout(() => {
      if (text.trim().length < 4) {
        set({ promptSuggestions: [] });
        return;
      }
      void (async () => {
        try {
          const suggestions = await api.call('prompt.analyze', inputId, text, get().activeProjectId ?? undefined);
          set({ promptSuggestions: suggestions });
        } catch {
          /* suggestions are best-effort */
        }
      })();
    }, get().config?.promptAssistant.debounceMs ?? 450);
  },

  async refreshProviders() {
    const providers = await api.call('providers.refresh');
    const models = await api.call('models.list');
    const roles = await api.call('roles.list');
    set({ providers, models, roles });
  },

  async setRole(role, modelId) {
    const roles = await api.call('roles.set', role, modelId);
    set({ roles });
  },

  async patchConfig(patch) {
    const config = await api.call('config.set', patch as never);
    set({ config: config as AppConfig });
  },

  async loadSidePanels() {
    try {
      const [tasks, perms, memory, skills, projects] = await Promise.all([
        api.call('tasks.list'),
        api.call('permissions.state'),
        api.call('memory.list'),
        api.call('skills.list'),
        api.call('projects.list'),
      ]);
      set({ tasks, permissions: perms, memory, skills, projects });
    } catch (err) {
      set({ error: err instanceof api.ApiError ? err.message : String(err) });
    }
  },

  async decidePermission(id, decision) {
    await api.call('permissions.decide', id, decision);
    set((s) => ({ permissionQueue: s.permissionQueue.filter((r) => r.id !== id) }));
  },

  async cancelTask(id) {
    await api.call('tasks.cancel', id);
    void get().loadSidePanels();
  },

  async recoverTask(id, mode) {
    await api.call('tasks.recover', id, mode);
    void get().loadSidePanels();
  },

  async confirmMemory(id) {
    await api.call('memory.confirm', id);
    void get().loadSidePanels();
  },

  async deleteMemory(id) {
    await api.call('memory.delete', id);
    set((s) => ({ memory: s.memory.filter((m) => m.id !== id) }));
  },

  async addMemory(content) {
    await api.call('memory.add', content, 'preference');
    void get().loadSidePanels();
  },

  async searchMemory(q) {
    const hits = await api.call('memory.search', q);
    set({ memoryHits: hits });
  },

  async importKnowledge() {
    try {
      const r = await api.call('knowledge.import');
      set({ error: r.ok ? null : r.message });
    } catch (err) {
      set({ error: err instanceof api.ApiError ? err.message : String(err) });
    }
  },

  async toggleSkill(id, enabled) {
    await api.call('skills.toggle', id, enabled);
    void get().loadSidePanels();
  },

  async deleteSkill(id) {
    await api.call('skills.delete', id);
    set((s) => ({ skills: s.skills.filter((x) => x.id !== id) }));
  },

  async addProject() {
    try {
      const p = await api.call('projects.add', '__pick__');
      set((s) => ({ projects: [p, ...s.projects], activeProjectId: p.id }));
    } catch (err) {
      set({ error: err instanceof api.ApiError ? err.message : String(err) });
    }
  },

  async reindexProject(id) {
    await api.call('projects.reindex', id);
  },

  async removeProject(id) {
    await api.call('projects.remove', id);
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id), activeProjectId: s.activeProjectId === id ? null : s.activeProjectId }));
  },

  async refreshHealth() {
    try {
      const health = await api.call('diagnostics.health');
      set({ health });
    } catch {
      /* health is best-effort on boot */
    }
  },

  async runSelfTest() {
    const health = await api.call('diagnostics.selfTest');
    set({ health });
  },

  async exportDiagnostics() {
    const r = await api.call('diagnostics.export');
    set({ error: `Exported to ${r.path}` });
  },

  async setResourceMode(mode) {
    await api.call('resource.mode', mode);
    void get().refreshHealth();
  },

  async toggleOverlay(on) {
    await api.call(on ? 'overlay.show' : 'overlay.hide');
  },

  async completeWizard() {
    await api.call('wizard.complete');
    set((s) => ({ config: s.config ? { ...s.config, wizard: { ...s.config.wizard, completed: true } } : s.config }));
  },

  dismissNotice(id) {
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
  },

  applyEvent(e) {
    switch (e.type) {
      case 'chat.stream': {
        const cid = e.conversationId;
        if (get().activeConvId === cid) {
          set((s) => {
            const msgs = [...s.messages];
            const idx = msgs.findIndex((m) => m.id === e.messageId);
            if (idx >= 0 && msgs[idx]?.streaming) {
              msgs[idx] = { ...msgs[idx], content: String(msgs[idx]?.content ?? '') + e.delta } as UiMessage;
            } else {
              msgs.push({ id: e.messageId, role: 'assistant', content: e.delta, streaming: true });
            }
            return { messages: msgs };
          });
        }
        break;
      }
      case 'chat.message_added': {
        if (get().activeConvId === e.conversationId) {
          set((s) => ({ messages: s.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)) }));
          void get().openConversation(e.conversationId);
          set({ sending: false });
        }
        void get().loadSidePanels();
        break;
      }
      case 'chat.cancelled':
        set({ sending: false });
        break;
      case 'task.updated':
        void get().loadSidePanels();
        break;
      case 'permission.requested':
        set((s) => ({ permissionQueue: [...s.permissionQueue, e.request] }));
        break;
      case 'permission.resolved':
        set((s) => ({ permissionQueue: s.permissionQueue.filter((r) => r.id !== e.requestId) }));
        break;
      case 'prompt.suggestions':
        break; // handled synchronously by analyzePrompt
      case 'proactive.suggestion':
        set((s) => ({ notices: [...s.notices, e.suggestion].slice(-3) }));
        break;
      case 'provider.status': {
        set((s) => ({
          providers: s.providers.map((p) => (p.id === (e.health as ProviderHealth).providerId ? { ...p, health: e.health } : p)),
        }));
        break;
      }
      default:
        break;
    }
  },
}));
