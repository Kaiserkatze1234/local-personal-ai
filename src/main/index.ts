/**
 * Electron main-process entry: window management + wiring the Electron host
 * bindings into the headless CoreApp. All real logic lives in services that
 * are testable without Electron (vitest boots CoreApp directly).
 */

import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Notification, screen } from 'electron';
import { APP_ID, APP_NAME, DATA_DIR_ENV, DEV_SERVER_ENV } from '../shared/constants.js';
import type { AppEvent } from '../shared/types/events.js';
import { Api } from './api.js';
import { CoreApp, type HostBindings } from './app.js';
import { OverlayController } from './electron/overlayController.js';
import { createElectronScreenSource } from './electron/screenElectron.js';

const gotLock = app.requestSingleInstanceLock({ id: 'main' });
let core: CoreApp | null = null;
let mainWindow: BrowserWindow | null = null;
let overlay: OverlayController | null = null;

function broadcast(event: AppEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('lpai:event', event);
  }
  if (event.type === 'proactive.suggestion' && overlay?.active) {
    overlay.pushText(event.suggestion.text);
  }
}

async function boot(): Promise<void> {
  const dataDir = process.env[DATA_DIR_ENV] ?? join(app.getPath('userData'), 'lpai');
  const rendererDir = join(app.getAppPath(), 'dist', 'renderer');
  const devUrl = process.env[DEV_SERVER_ENV] ?? null;

  overlay = new OverlayController(rendererDir, devUrl, () => core!.getConfig());

  const host: HostBindings = {
    hostName: APP_NAME,
    sendToUi: broadcast,
    notify: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    },
    screenSource: createElectronScreenSource(),
    pickDirectory: async () => {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Choose folder' });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    pickFile: async () => {
      const r = await dialog.showOpenDialog({ properties: ['openFile'], title: 'Choose file' });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    overlayShow: () => overlay?.show(),
    overlayHide: () => overlay?.hide(),
  };

  core = new CoreApp({ dataDir, host });
  await core.boot();

  // keep proactive overlay informed about task state (§23 task display)
  core.bus.on('task.updated', (e) => {
    if (!overlay?.active || !core) return;
    const t = core.tasks.get(e.taskId);
    if (t) overlay.pushText(`[${t.status}] ${t.title}`);
  });

  const api = new Api(core);
  ipcMain.handle('lpai:invoke', async (_ev, method: string, args: unknown[] = []) => api.handleRaw(method, args));

  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0d1017',
    show: false,
    autoHideMenuBar: true,
    title: APP_NAME,
    webPreferences: {
      preload: join(app.getAppPath(), 'dist', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // Windows: notifications silently fail without an AppUserModelID
  app.setAppUserModelId(APP_ID);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(join(rendererDir, 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // graceful shutdown: flush config + task state
  app.on('before-quit', (e) => {
    if (core) {
      e.preventDefault();
      const c = core;
      core = null;
      void c.dispose().finally(() => app.exit(0));
    }
  });

  void screen; // electron require parity guard for older builds
}

if (!gotLock) {
  const w = BrowserWindow.getAllWindows()[0];
  w?.focus();
  app.quit();
} else {
  void app
    .whenReady()
    .then(boot)
    .catch((err) => {
      console.error('[fatal] boot failed:', err);
      app.exit(1);
    });

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
    // task state is persisted by TaskManager transitions; nothing to "fix"
    // on disk here — recovery happens on next boot (§51).
  });
}
