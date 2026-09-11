/**
 * Preload bridge — the ONLY surface the renderer gets. contextIsolation on,
 * nodeIntegration off (§35). Method names are validated against a static
 * allowlist; everything else stays in the main process.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const ALLOWED_METHODS = new Set<string>([
  'app.info',
  'config.get',
  'config.set',
  'providers.list',
  'providers.refresh',
  'providers.health',
  'models.list',
  'roles.list',
  'roles.set',
  'chat.send',
  'chat.cancel',
  'conversations.list',
  'conversations.messages',
  'conversations.delete',
  'conversations.search',
  'tasks.list',
  'tasks.get',
  'tasks.cancel',
  'tasks.recover',
  'tools.list',
  'permissions.state',
  'permissions.setMode',
  'permissions.decide',
  'permissions.resetGrant',
  'memory.list',
  'memory.add',
  'memory.confirm',
  'memory.delete',
  'memory.search',
  'knowledge.import',
  'knowledge.list',
  'skills.list',
  'skills.add',
  'skills.toggle',
  'skills.delete',
  'projects.list',
  'projects.add',
  'projects.remove',
  'projects.reindex',
  'checkpoints.list',
  'checkpoints.restore',
  'diagnostics.health',
  'diagnostics.selfTest',
  'diagnostics.export',
  'prompt.analyze',
  'prompt.analyzeDebounced',
  'screen.capture',
  'screen.captureRegion',
  'region.submit',
  'recording.status',
  'recording.analyze',
  'recording.pickAndAnalyze',
  'voice.transcribe',
  'voice.speak',
  'extensions.list',
  'extensions.panels',
  'diagnostics.logs',
  'diagnostics.reveal',
  'extensions.reload',
  'extensions.info',
  'extensions.uninstall',
  'overlay.show',
  'overlay.hide',
  'resource.mode',
  'wizard.complete',
]);

const api = {
  async invoke(method: string, ...args: unknown[]): Promise<unknown> {
    if (!ALLOWED_METHODS.has(method)) {
      return { ok: false, error: { kind: 'invalid_state', message: `Blocked IPC method: ${method}` } };
    }
    return ipcRenderer.invoke('lpai:invoke', method, args);
  },
  onEvent(callback: (event: unknown) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void => callback(payload);
    ipcRenderer.on('lpai:event', listener);
    return () => ipcRenderer.removeListener('lpai:event', listener);
  },
  onOverlayText(callback: (text: string) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, text: string): void => callback(String(text));
    ipcRenderer.on('lpai:overlay', listener);
    return () => ipcRenderer.removeListener('lpai:overlay', listener);
  },
  onPtt(callback: (action: 'toggle') => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, action: string): void => callback(action === 'toggle' ? 'toggle' : 'toggle');
    ipcRenderer.on('lpai:ptt', listener);
    return () => ipcRenderer.removeListener('lpai:ptt', listener);
  },
  /**
   * Drag & drop: map a dropped DOM File to its absolute disk path, or ''
   * when it has none (text/data drops). Runs in the preload realm where
   * webUtils is available; the renderer never touches Node/Electron.
   */
  getPathForFile(file: unknown): string {
    try {
      return webUtils.getPathForFile(file as never);
    } catch {
      return '';
    }
  },
};

contextBridge.exposeInMainWorld('lpai', api);

export type LpaiBridge = typeof api;
