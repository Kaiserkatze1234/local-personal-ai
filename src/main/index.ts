/**
 * Electron main-process entry: window management + wiring the Electron host
 * bindings into the headless CoreApp. All real logic lives in services that
 * are testable without Electron (vitest boots CoreApp directly).
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  screen,
  session,
  shell,
  Tray,
} from 'electron';
import { APP_ID, APP_NAME, DATA_DIR_ENV, DEV_SERVER_ENV } from '../shared/constants.js';
import { tr } from '../shared/i18n.js';
import type { AppEvent } from '../shared/types/events.js';
import { Api } from './api.js';
import { CoreApp, type HostBindings } from './app.js';
import { OverlayController } from './electron/overlayController.js';
import { RegionPicker } from './electron/regionPicker.js';
import { createElectronScreenSource } from './electron/screenElectron.js';
import { parsePlacement, snapshotPlacement } from './electron/windowState.js';
import { extractLaunchFiles } from './launchFiles.js';
import { resolveSqliteBinding } from './storage/db.js';

// Pin the data location BEFORE 'ready' locks it (the instance-socket path
// also lives in userData): %APPDATA%\lpai on Windows, ~/.config/lpai on
// Linux — identical in dev and packaged, exactly what the README promises.
try {
  app.setPath('userData', join(app.getPath('appData'), 'lpai'));
} catch {
  /* setPath after ready is rejected; non-Electron hosts never reach boot() anyway */
}

const gotLock = app.requestSingleInstanceLock({ id: 'main' });
let core: CoreApp | null = null;
let mainWindow: BrowserWindow | null = null;
let overlay: OverlayController | null = null;
let tray: Tray | null = null;
let appQuitting = false;
let createWindowRef: (() => void) | null = null;

function isFilePath(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Files arriving from outside: launch argv (Explorer file association /
 * "Öffnen mit"), second-instance argv, macOS open-file. Queued until the
 * CoreApp is up, imported straight away once it is — each file emits
 * `file.opened` on the bus so every window reports it. Opening a file is
 * an explicit act, so the main window comes forward even when the app is
 * configured to start hidden or minimize to tray.
 */
let pendingFiles: string[] = [];
function deliverFiles(paths: readonly string[]): void {
  if (paths.length === 0) return;
  if (!core) {
    pendingFiles = pendingFiles.concat(paths);
    return;
  }
  core.openFiles(paths);
  showMain();
}

function showMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindowRef?.();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function broadcast(event: AppEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('lpai:event', event);
  }
  if (event.type === 'proactive.suggestion' && overlay?.active) {
    overlay.pushText(event.suggestion.text);
  }
}

async function boot(): Promise<void> {
  // Windows: taskbar grouping, tray and toast notifications silently misbehave
  // without the AppUserModelID — set it before any window or tray exists.
  app.setAppUserModelId(APP_ID);
  const dataDir = process.env[DATA_DIR_ENV] ?? app.getPath('userData');
  const rendererDir = join(app.getAppPath(), 'dist', 'renderer');
  const devUrl = process.env[DEV_SERVER_ENV] ?? null;
  const regionPicker = new RegionPicker(rendererDir, devUrl);

  overlay = new OverlayController(rendererDir, devUrl, () => core!.getConfig());

  const host: HostBindings = {
    hostName: APP_NAME,
    sendToUi: broadcast,
    notify: (title, body) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body });
      n.addListener('click', () => showMain());
      n.show();
    },
    screenSource: createElectronScreenSource(),
    pickDirectory: async () => {
      const lang = () => core?.getConfig().general.language ?? 'en';
      const r = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: tr(lang(), 'Choose folder'),
        buttonLabel: tr(lang(), 'Use this folder'),
      });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    pickFile: async () => {
      const lang = () => core?.getConfig().general.language ?? 'en';
      const r = await dialog.showOpenDialog({
        properties: ['openFile'],
        title: tr(lang(), 'Choose file'),
        buttonLabel: tr(lang(), 'Import'),
      });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    overlayShow: () => overlay?.show(),
    overlayHide: () => overlay?.hide(),
    reveal: (p) => {
      try {
        shell.showItemInFolder(p);
      } catch {
        /* path may not exist yet */
      }
    },
    setAutostart: (on) => {
      app.setLoginItemSettings({ openAtLogin: on, args: [] });
    },
    pickRegion: () => regionPicker.open(),
    onRegionResult: (rect) => regionPicker.deliver(rect),
  };

  // Keep node_modules/better-sqlite3 on the Node ABI (so vitest always
  // works) and let Electron probe the fetched prebuilt binding next to the
  // app — see scripts/prepare-native.mjs + storage/db.ts resolveSqliteBinding.
  const sqliteBinding = resolveSqliteBinding([
    process.env.LPAI_SQLITE_BINDING,
    join(app.getAppPath(), 'native', 'electron', 'better_sqlite3.node'),
    ...(process.resourcesPath ? [join(process.resourcesPath, 'native', 'electron', 'better_sqlite3.node')] : []),
  ]);

  core = new CoreApp({ dataDir, host, sqliteBinding });
  await core.boot();

  // ---- global hotkeys (§23 overlay toggle, §24 voice activation) ----
  const registerShortcuts = (): void => {
    globalShortcut.unregisterAll();
    if (!core) return;
    const c = core.getConfig();
    if (c.overlay.enabled && c.overlay.hotkey) {
      const ok = globalShortcut.register(c.overlay.hotkey, () => {
        const ovl = overlay;
        if (!core || !ovl) return;
        if (ovl.active) ovl.hide();
        else ovl.show();
      });
      if (!ok) core.log.child('host').warn(`overlay hotkey "${c.overlay.hotkey}" is taken by another app`);
    }
    if (c.voice.enabled && c.voice.pushToTalkHotkey) {
      // globalShortcut has no key-up; treat as press=start, press=stop toggle
      const ok = globalShortcut.register(c.voice.pushToTalkHotkey, () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lpai:ptt', 'toggle');
      });
      if (!ok) core.log.child('host').warn(`push-to-talk hotkey "${c.voice.pushToTalkHotkey}" is taken by another app`);
    }
  };
  registerShortcuts();
  const unwatchConfig = core.config.onChange(() => registerShortcuts());
  app.on('will-quit', () => {
    unwatchConfig();
    globalShortcut.unregisterAll();
  });

  // microphone is granted only while voice input is enabled (§24, §35)
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    const allowed = permission === 'media' && (core?.getConfig().voice.enabled ?? false);
    cb(allowed);
  });

  // keep proactive overlay informed about task state (§23 task display)
  core.bus.on('task.updated', (e) => {
    if (!overlay?.active || !core) return;
    const t = core.tasks.get(e.taskId);
    if (t) overlay.pushText(`[${t.status}] ${t.title}`);
  });

  const api = new Api(core);
  ipcMain.handle('lpai:invoke', async (_ev, method: string, args: unknown[] = []) => api.handleRaw(method, args));

  const winStateFile = join(dataDir, 'window-state.json');
  const readJsonSafe = (f: string): unknown => {
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as unknown;
    } catch {
      return null;
    }
  };

  createWindowRef = () => {
    // reopen where the user left it; saved positions on now-absent monitors
    // are dropped (the classic "window off-screen" Windows bug)
    const saved = parsePlacement(
      readJsonSafe(winStateFile),
      screen.getAllDisplays().map((d) => d.workArea),
      {
        width: 1380,
        height: 900,
      },
    );
    mainWindow = new BrowserWindow({
      ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
      width: saved.width,
      height: saved.height,
      minWidth: 980,
      minHeight: 620,
      backgroundColor: '#0d1017',
      show: false,
      autoHideMenuBar: true,
      title: APP_NAME,
      icon: join(app.getAppPath(), 'dist', 'resources', 'icon.png'),
      webPreferences: {
        preload: join(app.getAppPath(), 'dist', 'preload', 'index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    if (saved.maximized) mainWindow.maximize();

    let boundsTimer: NodeJS.Timeout | null = null;
    const flushPlacement = (): void => {
      if (boundsTimer) {
        clearTimeout(boundsTimer);
        boundsTimer = null;
      }
      const w = mainWindow;
      if (!w || w.isDestroyed() || w.isMinimized()) return;
      try {
        writeFileSync(winStateFile, JSON.stringify(snapshotPlacement({ ...w.getBounds(), maximized: w.isMaximized() })));
      } catch {
        /* geometry persistence is best-effort — never fail a close over it */
      }
    };
    const persistPlacement = (): void => {
      if (boundsTimer) clearTimeout(boundsTimer);
      boundsTimer = setTimeout(flushPlacement, 600);
    };
    mainWindow.on('resize', persistPlacement);
    mainWindow.on('move', persistPlacement);
    mainWindow.on('maximize', persistPlacement);
    mainWindow.on('unmaximize', persistPlacement);

    mainWindow.once('ready-to-show', () => {
      // §47 startup behaviour: startHidden keeps the window in the tray
      if (!core?.getConfig().general.startHidden) showMain();
    });
    if (devUrl) void mainWindow.loadURL(devUrl);
    else void mainWindow.loadFile(join(rendererDir, 'index.html'));

    // One-command boot validation: LPAI_SMOKE=1 exercises the whole chain that a
    // real launch depends on — window creation, renderer bundle load, preload
    // bridge exposure, IPC round-trip into the booted core (SQLite already open) —
    // then writes <dataDir>/smoke-result.txt and exits 0/1. On the target Windows
    // box: `$env:LPAI_SMOKE='1'; npm run dev` (or the portable exe) answers
    // "does the app actually start" without clicking anything.
    if (process.env.LPAI_SMOKE === '1') {
      const w = mainWindow;
      const finish = (ok: boolean, detail: string): void => {
        try {
          writeFileSync(join(dataDir, 'smoke-result.txt'), `${ok ? 'SMOKE_OK' : 'SMOKE_FAIL'} ${new Date().toISOString()} ${detail}\n`);
        } catch {
          /* result file is a convenience; the exit code is the contract */
        }
        console.log(`${ok ? 'SMOKE_OK' : 'SMOKE_FAIL'} ${detail}`);
        app.exit(ok ? 0 : 1);
      };
      const t0 = Date.now();
      w?.webContents.once('did-finish-load', () => {
        void w.webContents
          .executeJavaScript(
            `(async () => {
              if (!window.lpai || typeof window.lpai.invoke !== 'function') return 'FAIL: preload bridge missing';
              const r = await window.lpai.invoke('app.info');
              if (!r || !r.ok) return 'FAIL: ipc error ' + JSON.stringify(r && r.error).slice(0, 200);
              return 'renderer+ipc ok: app.info ' + JSON.stringify(r.data).slice(0, 120);
            })()`,
          )
          .then((d) => finish(String(d).startsWith('renderer+ipc ok'), `${String(d)} (${Date.now() - t0}ms)`))
          .catch((e) => finish(false, `evaluate failed: ${String(e)}`));
      });
      w?.webContents.once('did-fail-load', (_e, code, desc) =>
        finish(false, `renderer load failed: ${code} ${desc} (${Date.now() - t0}ms)`),
      );
    }

    mainWindow.on('close', (e) => {
      flushPlacement();
      const cfg = core?.getConfig();
      if (!appQuitting && cfg?.general.closeToTray && tray && !tray.isDestroyed()) {
        e.preventDefault(); // hide instead of quit — restorable from tray
        mainWindow?.hide();
      }
    });
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  };
  createWindowRef();

  // ---- tray (§47 startup behavior: hidden start / close-to-tray) ----
  const needTray = () => {
    const cfg = core?.getConfig();
    return Boolean(cfg && (cfg.general.startHidden || cfg.general.closeToTray));
  };
  const buildTray = (): void => {
    if (tray && !tray.isDestroyed()) return;
    if (!needTray()) return;
    const iconPath = join(app.getAppPath(), 'dist', 'resources', 'icon.png');
    const img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) {
      core?.log.child('host').warn('tray icon missing (dist/resources/icon.png) — tray disabled');
      return;
    }
    tray = new Tray(img.resize({ width: 16, height: 16 }));
    const lang = () => core?.getConfig().general.language ?? 'en';
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: tr(lang(), 'Open'), click: () => showMain() },
        { label: tr(lang(), 'Show/hide overlay'), click: () => (overlay?.active ? overlay.hide() : overlay?.show()) },
        { type: 'separator' },
        {
          label: tr(lang(), 'Quit'),
          click: () => {
            appQuitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.addListener('click', () => (mainWindow?.isVisible() ? mainWindow.focus() : showMain()));
  };
  buildTray();
  core.config.onChange(() => buildTray());

  // Windows autostart registration (HKCU Run) follows the config
  app.setLoginItemSettings({ openAtLogin: core.getConfig().general.autostart, args: [] });

  // "Start the app by opening a file": the installer registers file
  // associations, so Explorer hands the document path to argv[1].
  // Anything collected pre-ready (macOS open-file) rides along here.
  deliverFiles(
    extractLaunchFiles(process.argv, {
      cwd: process.cwd(),
      exe: process.execPath,
      appDir: app.getAppPath(),
      isFile: isFilePath,
    }).concat(pendingFiles.splice(0)),
  );

  // graceful shutdown: flush config + task state
  app.on('before-quit', (e) => {
    appQuitting = true;
    if (core) {
      e.preventDefault();
      const c = core;
      core = null;
      void c.dispose().finally(() => app.exit(0));
    }
  });
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
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error('[fatal] boot failed:', msg);
      // a double-clicked desktop icon that silently does nothing is the worst
      // Windows failure mode — surface at least the reason
      try {
        dialog.showErrorBox(`${APP_NAME} — Fehler / error`, msg.slice(0, 4000));
      } catch {
        /* headless or too early for dialogs */
      }
      app.exit(1);
    });

  // "Öffnen mit…" while already running: no second window — the forwarded
  // argv is imported into this instance and the window comes to the front.
  app.on('second-instance', (_event, argv, cwd) => {
    const files = extractLaunchFiles(argv, {
      cwd: cwd || process.cwd(),
      exe: process.execPath,
      appDir: app.getAppPath(),
      isFile: isFilePath,
    });
    if (files.length === 0) showMain();
    else deliverFiles(files);
  });

  // macOS delivers double-clicked documents via an event instead of argv.
  app.on('open-file', (event, path) => {
    event.preventDefault();
    deliverFiles([path]);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
    // task state is persisted by TaskManager transitions; nothing to "fix"
    // on disk here — recovery happens on next boot (§51).
  });
}
