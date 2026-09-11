/**
 * Desktop overlay — spec §23/§46. Frameless transparent always-on-top window
 * that never steals focus in compact mode and is cheap when hidden (destroy
 * instead of hide => zero resource use, gaming-friendly §23).
 * Windows-specific tuning is guarded so the module loads on dev machines.
 */

import { join } from 'node:path';
import { BrowserWindow, screen } from 'electron';
import type { AppConfig } from '../../shared/types/config.js';

export class OverlayController {
  private win: BrowserWindow | null = null;
  private enabled = false;

  constructor(
    private rendererDir: string,
    private devServerUrl: string | null,
    private getConfig: () => Readonly<AppConfig>,
  ) {}

  private position(): { x: number; y: number } {
    const cfg = this.getConfig().overlay;
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const W = 340;
    const H = 140;
    const M = 16;
    switch (cfg.position) {
      case 'top-left':
        return { x: M, y: M };
      case 'bottom-left':
        return { x: M, y: height - H - M };
      case 'bottom-right':
        return { x: width - W - M, y: height - H - M };
      default:
        return { x: width - W - M, y: M };
    }
  }

  show(): void {
    this.enabled = true;
    if (this.win && !this.win.isDestroyed()) {
      void this.win.loadURL(this.targetUrl());
      return;
    }
    const cfg = this.getConfig().overlay;
    const { x, y } = this.position();
    this.win = new BrowserWindow({
      width: 340,
      height: 140,
      x,
      y,
      frame: false,
      transparent: true,
      resizable: true,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      hasShadow: false,
      webPreferences: {
        preload: join(this.rendererDir, '..', 'preload', 'index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: cfg.lowResourceMode,
      },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'win32') {
      // do not appear in alt-tab / screenshots of the game bar
      this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    this.win.setIgnoreMouseEvents(true, { forward: true });
    void this.win.loadURL(this.targetUrl());
    this.win.on('closed', () => {
      this.win = null;
    });
  }

  hide(): void {
    this.enabled = false;
    if (this.win && !this.win.isDestroyed()) this.win.destroy(); // zero idle cost
    this.win = null;
  }

  private targetUrl(): string {
    if (this.devServerUrl) return `${this.devServerUrl}/overlay.html`;
    return `file://${join(this.rendererDir, 'overlay.html')}`;
  }

  pushText(text: string): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('lpai:overlay', text);
  }

  get active(): boolean {
    return this.enabled && this.win !== null;
  }
}
