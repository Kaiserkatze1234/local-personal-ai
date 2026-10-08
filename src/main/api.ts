/**
 * Typed API facade — every renderer request lands here. Validation happens at
 * the boundary (RULE 6); results are wrapped so errors stay structured for
 * recovery-aware UI (§39). No Electron imports in this file.
 */

import type { ModelRole, PermissionMode, ResourceMode } from '../shared/types/capabilities.js';
import { newId, nowIso } from '../shared/types/common.js';
import type { DeepPartial } from '../shared/types/config.js';
import type { InvokeContract, InvokeResult, IpcMethod, SendChatInput } from '../shared/types/ipc.js';
import type { MemoryType } from '../shared/types/memory.js';
import type { PermissionDecision, PermissionId } from '../shared/types/permissions.js';
import type { TaskStatus } from '../shared/types/task.js';
import type { CoreApp } from './app.js';
import { AppError, toErrorInfo } from './core/errors.js';

type Args<M extends IpcMethod> = InvokeContract[M]['args'];
type Res<M extends IpcMethod> = InvokeContract[M]['res'];

export class Api {
  /** Abort controllers for plain-chat streams keyed by conversation. */
  private chatAborts = new Map<string, AbortController>();

  constructor(private app: CoreApp) {}

  async handle<M extends IpcMethod>(method: M, ...args: Args<M>): Promise<InvokeResult<Res<M>>> {
    try {
      const data = (await this.dispatch(method, args as unknown[])) as Res<M>;
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: toErrorInfo(err) };
    }
  }

  /** Raw entry for the IPC layer; unknown methods hit the switch default (§39). */
  async handleRaw(method: string, args: unknown[]): Promise<InvokeResult<unknown>> {
    try {
      return { ok: true, data: await this.dispatch(method as IpcMethod, args ?? []) };
    } catch (err) {
      return { ok: false, error: toErrorInfo(err) };
    }
  }

  private async dispatch(method: IpcMethod, args: unknown[]): Promise<unknown> {
    const app = this.app;
    switch (method) {
      case 'app.info':
        return { name: 'Local Personal AI', version: '0.1.0', dataDir: app.opts.dataDir, platform: process.platform };

      case 'config.get':
        return app.getConfig();
      case 'config.set':
        return app.patchConfig(args[0] as DeepPartial<object> as DeepPartial<import('../shared/types/config.js').AppConfig>);

      case 'providers.list':
        return app.providers.list().map((p) => ({
          id: p.id,
          label: p.label,
          kind: p.kind,
          baseUrl: p.baseUrl,
          enabled: p.enabled,
          health: p.health,
          models: p.models,
        }));
      case 'providers.refresh':
        await app.providers.refreshAll();
        app.roles.autoAssign();
        return app.providers.list().map((p) => ({
          id: p.id,
          label: p.label,
          kind: p.kind,
          baseUrl: p.baseUrl,
          enabled: p.enabled,
          health: p.health,
          models: p.models,
        }));
      case 'providers.health':
        return (await app.providers.refreshProvider(String(args[0])))?.health;

      case 'models.list':
        return app.providers.allModels();
      case 'roles.list':
        return app.roles.list();
      case 'roles.set': {
        const role = String(args[0]) as ModelRole;
        const modelId = args[1] === null ? null : String(args[1]);
        return app.roles.set(role, modelId);
      }

      case 'chat.send':
        return this.chatSend(args[0] as SendChatInput);
      case 'chat.cancel': {
        const convId = String(args[0]);
        const ctrl = this.chatAborts.get(convId);
        ctrl?.abort(new Error('user cancelled'));
        return ctrl !== undefined;
      }

      case 'conversations.list':
        return app.convos.list();
      case 'conversations.messages':
        return app.messages.list(String(args[0]));
      case 'conversations.delete':
        return app.convos.delete(String(args[0]));
      case 'conversations.search':
        return app.convos.search(String(args[0]));

      case 'tasks.list':
        return app.tasks.list(args[0] as TaskStatus[] | undefined);
      case 'tasks.get':
        return app.tasks.get(String(args[0]));
      case 'tasks.cancel': {
        const id = String(args[0]);
        app.permissions.denyForTask(id);
        return app.tasks.cancel(id);
      }
      case 'tasks.recover': {
        const id = String(args[0]);
        const mode = args[1] as 'rerun' | 'discard';
        const t = app.tasks.get(id);
        if (!t) return false;
        if (mode === 'discard') {
          app.tasks.transition(id, 'cancelled', { summary: 'Discarded by user during recovery.' }, 'discarded');
          return true;
        }
        // rerun: re-enter the queue with the original request
        const fresh = app.tasks.create({
          title: `${t.title} (retry)`,
          userRequest: t.userRequest,
          taskClass: t.taskClass,
          projectId: t.projectId,
          conversationId: t.conversationId,
        });
        void app.agent
          .run({ userText: t.userRequest, mode: 'AGENT', projectId: t.projectId, conversationId: t.conversationId, title: fresh.title })
          .catch((err) => app.log.child('api').warn(`task rerun failed: ${(err as Error).message}`));
        return true;
      }

      case 'tools.list':
        return app.tools.listManifests();

      case 'permissions.state':
        return app.permissions.state();
      case 'permissions.setMode':
        return app.permissions.setMode(args[0] as PermissionMode);
      case 'permissions.decide':
        return app.permissions.decide(String(args[0]), args[1] as PermissionDecision);
      case 'permissions.resetGrant':
        return app.permissions.resetGrant(args[0] as PermissionId);

      case 'memory.list':
        return app.memory.list(args[0] as import('../shared/types/memory.js').MemoryStatus | undefined);
      case 'memory.add': {
        const e = app.memory.add({
          content: String(args[0]),
          type: args[1] as MemoryType,
          source: 'user',
          importance: 0.7,
          autoConfirm: true,
        });
        return e;
      }
      case 'memory.confirm':
        return app.memory.confirm(String(args[0]));
      case 'memory.delete':
        return app.memory.delete(String(args[0]));
      case 'memory.search':
        return app.memory.search(String(args[0]));

      case 'knowledge.import': {
        // args[0] absent -> open a pick dialog (the UI path). With a path it
        // is a direct import (drag & drop; "Open with" forwards via events).
        let p = args[0] ? String(args[0]) : '';
        if (!p) {
          const picked = await app.host.pickFile?.();
          if (!picked) throw AppError.invalidState('No file selected.');
          p = picked;
        }
        return app.importFilePath(p);
      }
      case 'knowledge.list':
        return app.store.all(
          `SELECT id, name, kind, size, created_at AS createdAt FROM knowledge_documents ORDER BY created_at DESC LIMIT 100`,
        );

      case 'skills.list':
        return app.skills.list();
      case 'skills.add': {
        const name = String(args[0] ?? '').trim();
        const description = String(args[1] ?? '').trim();
        const instructions = String(args[2] ?? '').trim();
        if (!name || !instructions) throw AppError.invalidState('Skill needs a name and instructions.');
        return app.skills.createFromUser({ name, description: description || name, instructions });
      }
      case 'skills.toggle':
        return app.skills.toggle(String(args[0]), Boolean(args[1]));
      case 'skills.delete':
        return app.skills.delete(String(args[0]));

      case 'projects.list':
        return app.projects.list();
      case 'projects.add': {
        let p = String(args[0]);
        if (p === '__pick__') {
          const picked = await app.host?.pickDirectory?.();
          if (!picked) throw AppError.invalidState('No directory selected.');
          p = picked;
        }
        const info = await app.projects.addProject(p);
        return info;
      }
      case 'projects.remove':
        return app.projects.remove(String(args[0]));
      case 'projects.reindex':
        return app.projects.reindex(String(args[0]));

      case 'checkpoints.list':
        return app.checkpoints.list();
      case 'checkpoints.restore':
        return app.checkpoints.restore(String(args[0]));

      case 'diagnostics.logs': {
        const { readFileSync, existsSync } = await import('node:fs');
        const { join: j } = await import('node:path');
        const file = j(app.dataDirPath, 'logs', 'app.log');
        if (!existsSync(file)) return { text: '', lines: 0 };
        const lines = readFileSync(file, 'utf8').split('\n');
        const max = Math.min(2000, Number(args[0]) || 300);
        return { text: lines.slice(-max).join('\n'), lines: lines.length };
      }
      case 'diagnostics.reveal':
        if (!app.host.reveal) return { ok: false, error: 'revealing files needs the desktop shell' };
        app.host.reveal(String(args[0] ?? ''));
        return { ok: true };

      case 'diagnostics.health':
        return app.health.run({ probeProviders: true });
      case 'diagnostics.selfTest': {
        const results = await app.health.selfTest();
        for (const r of results)
          app.bus.emit({
            type: 'log.entry',
            level: r.state === 'OK' ? 'info' : 'error',
            subsystem: 'selftest',
            message: `${r.label}: ${r.message}`,
          });
        return { ...(await app.health.run()), components: [...(await app.health.run()).components, ...results] };
      }
      case 'diagnostics.export': {
        const ex = app.health.exportDiagnostics();
        await ex.write();
        return { path: ex.path };
      }

      case 'prompt.analyze':
        return app.promptAssistant.analyze(String(args[0]), String(args[1]), args[2] ? String(args[2]) : undefined, true);
      case 'prompt.analyzeDebounced': {
        const suggestions = app.promptAssistant.analyze(String(args[0]), String(args[1]), args[2] ? String(args[2]) : undefined);
        app.bus.emit({ type: 'prompt.suggestions', inputId: String(args[0]), suggestions });
        return 'scheduled';
      }

      case 'screen.capture':
        return app.vision.captureScreen(args[0] as import('./vision/visionService.js').CaptureRect | undefined);

      case 'screen.captureRegion': {
        const pick = app.host.pickRegion;
        if (!pick) {
          throw new AppError(
            'not_implemented',
            'Region selection needs the desktop shell (Electron). Pass an explicit rect to screen.capture instead.',
            ['screen.capture accepts {x, y, width, height} in screenshot coordinates'],
          );
        }
        const rect = await pick.call(app.host);
        if (!rect) return { mimeType: 'none', dataBase64: '', cancelled: true };
        return app.vision.captureScreen(rect);
      }
      case 'region.submit':
        app.host.onRegionResult?.((args[0] as { x: number; y: number; width: number; height: number } | null) ?? null);
        return 'submitted';

      case 'recording.status':
        return app.recordings.status();
      case 'recording.analyze':
        return app.recordings.summarize(String(args[0] ?? ''), args[1] ? String(args[1]) : undefined);
      case 'recording.pickAndAnalyze': {
        const path = (await app.host.pickFile?.('video')) ?? null;
        if (!path) return { ok: false, error: 'no file picked', cancelled: true };
        return app.recordings.summarize(path, args[0] ? String(args[0]) : undefined);
      }

      case 'voice.transcribe': {
        const bytes = Buffer.from(String(args[0] ?? ''), 'base64');
        const r = await app.voice.transcribe({ audio: new Uint8Array(bytes), mimeType: String(args[1] ?? 'audio/webm') });
        if ('unavailable' in r)
          throw new AppError('not_implemented', r.unavailable, [
            'Start a local STT service (e.g. whisper.cpp) and register it, or bind an STT-capable model to the STT role in Settings',
          ]);
        return r;
      }
      case 'voice.speak': {
        const r = app.voice.synthesize(String(args[0] ?? ''));
        if ('unavailable' in r)
          throw new AppError('not_implemented', r.unavailable, [
            'Register a local TTS provider or bind a TTS model to the TTS role in Settings',
          ]);
        const chunks: Buffer[] = [];
        for await (const c of r as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
        // speedApplied lets the player decide whether to add playbackRate itself (§24).
        return { audioBase64: Buffer.concat(chunks).toString('base64'), mimeType: 'audio/wav', speedApplied: app.voice.ttsAppliesSpeed() };
      }

      case 'extensions.panels':
        return app.extensions.listPanels().map((pr) => ({ id: pr.id, title: pr.title, markdown: pr.markdown }));
      case 'extensions.list':
        return app.extensions.list().map((e) => ({
          id: e.manifest.id,
          name: e.manifest.name,
          version: e.manifest.version,
          description: e.manifest.description,
          active: e.active,
          error: e.error,
          contributedTools: e.contributedTools,
        }));
      case 'extensions.uninstall':
        return app.extensions.uninstall(String(args[0]));
      case 'extensions.reload':
        return app.extensions.loadFromDirectory(app.extensionsDir);
      case 'extensions.info':
        return { dir: app.extensionsDir };

      case 'overlay.show':
        app.host?.overlayShow?.();
        return true;
      case 'overlay.hide':
        app.host?.overlayHide?.();
        return true;

      case 'resource.mode': {
        const m = args[0] as ResourceMode | 'auto';
        return app.resources.setMode(m);
      }
      case 'wizard.complete': {
        app.config.patch({ wizard: { completed: true } });
        return true;
      }
      default:
        throw AppError.notImplemented(String(method), 16);
    }
  }

  private async chatSend(input: SendChatInput): Promise<{ conversationId: string; assistantMessageId: string; taskId?: string }> {
    const app = this.app;
    let conversationId = input.conversationId;
    if (!conversationId || !app.convos.list().some((c) => c.id === conversationId)) {
      conversationId = newId('conv');
      app.convos.create(conversationId, input.text.slice(0, 60) || 'New conversation', input.mode, input.projectId);
    }
    const userMsgId = newId('msg');
    app.messages.add(conversationId, {
      id: userMsgId,
      role: 'user',
      content:
        input.images && input.images.length > 0
          ? [
              { type: 'text', text: input.text },
              ...input.images.map((i) => ({ type: 'image' as const, mimeType: i.mimeType, dataBase64: i.dataBase64 })),
            ]
          : input.text,
      createdAt: nowIso(),
    });
    app.bus.emit({ type: 'chat.message_added', conversationId });
    app.convos.touch(conversationId);

    if (input.mode === 'CHAT') {
      const abort = new AbortController();
      this.chatAborts.set(conversationId, abort);
      try {
        const result = await app.agent.chatTurn({
          conversationId,
          userText: input.text,
          images: input.images,
          projectId: input.projectId,
          signal: abort.signal,
        });
        return { conversationId, assistantMessageId: result.assistantMessageId };
      } finally {
        this.chatAborts.delete(conversationId);
      }
    }
    // AGENT / CODING / ASSISTANT -> full task path
    const mode = input.mode;
    app.proactive.markProjectActive(input.projectId);
    const outcome = app.agent.run({ userText: input.text, conversationId, mode, projectId: input.projectId, images: input.images });
    // don't block the UI: return the ids immediately, task events flow over the bus
    void outcome.catch((err) => app.log.child('api').warn(`agent task ended: ${(err as Error).message}`));
    const settled = await Promise.race([outcome.then((o) => o.taskId), sleep(150).then(() => undefined)]);
    return { conversationId, assistantMessageId: `${userMsgId}_pending`, taskId: settled };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
