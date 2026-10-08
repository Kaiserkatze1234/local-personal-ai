/**
 * Region selection (§21): a borderless, transparent, fullscreen window the
 * user drags in; result (physical-pixel rect) resolves the open() promise.
 * Esc / closing without a selection resolves null — caller reports cancel.
 */
import { join } from 'node:path';
import { BrowserWindow, screen } from 'electron';
import type { CaptureRect } from '../../shared/types/ipc.js';

export class RegionPicker {
  private win: BrowserWindow | null = null;
  private pending: ((r: CaptureRect | null) => void) | null = null;

  constructor(
    private rendererDir: string,
    private devUrl: string | null,
  ) {}

  open(): Promise<CaptureRect | null> {
    if (this.win) return Promise.resolve(null); // one selection at a time; earlier one cancels
    const d = screen.getPrimaryDisplay();
    const win = new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: join(this.rendererDir, '..', 'preload', 'index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    win.setMenuBarVisibility(false);
    if (this.devUrl) void win.loadURL(`${this.devUrl}/region.html`);
    else void win.loadFile(join(this.rendererDir, 'region.html'));
    win.on('closed', () => {
      this.win = null;
      const settle = this.pending;
      this.pending = null;
      settle?.(null);
    });
    win.webContents.on('before-input-event', (ev, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        ev.preventDefault();
        this.deliver(null);
      }
    });
    this.win = win;
    win.focus();
    return new Promise<CaptureRect | null>((resolve) => {
      this.pending = resolve;
    });
  }

  /** Called from the api when the region page submits its result. */
  deliver(rect: CaptureRect | null): void {
    const settle = this.pending;
    this.pending = null;
    this.win?.close(); // 'closed' handler sees pending null => no double-resolve
    settle?.(rect);
  }
}
