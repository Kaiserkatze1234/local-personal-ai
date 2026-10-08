/**
 * Startup / IPC / shutdown — the foundation every other E2E scenario builds on.
 *
 * These assertions are the real ones: the built app is launched, the main
 * window must appear, the renderer bundle must load, the preload bridge must be
 * exposed and one real IPC round-trip (`app.info`) must answer from the booted
 * core (SQLite open). No mocks, no sleeps standing in for state — Playwright
 * waits on element/condition states.
 */
import { expect, test } from '@playwright/test';
import { launchApp, waitForReady } from './harness.js';

test.describe('App start, bridge, IPC, shutdown', () => {
  test('starts, shows the window, loads the renderer and answers IPC through the preload bridge', async () => {
    const h = await launchApp();
    try {
      const windows = h.app.windows();
      expect(windows.length, 'mindestens ein Fenster').toBeGreaterThan(0);

      await waitForReady(h.page);

      // Document + React root really rendered
      await expect(h.page.locator('.composer')).toBeVisible();
      await expect(h.page.locator('.composer textarea')).toBeVisible();
      expect(await h.page.title()).toContain('Local Personal AI');

      // Preload bridge surface (contextBridge allowlist)
      // the preload bridge is the only surface the renderer gets
      const bridge = await h.page.evaluate(() => {
        const b = (globalThis as { lpai?: Record<string, unknown> }).lpai;
        return {
          hasInvoke: typeof b?.invoke === 'function',
          hasOnEvent: typeof b?.onEvent === 'function',
          hasGetPathForFile: typeof b?.getPathForFile === 'function',
          blocked: b === undefined,
        };
      });
      expect(bridge.blocked, 'window.lpai ist im Renderer verfügbar').toBe(false);
      expect(bridge.hasInvoke, 'window.lpai.invoke im Renderer').toBe(true);
      expect(bridge.hasOnEvent, 'window.lpai.onEvent im Renderer').toBe(true);
      expect(bridge.hasGetPathForFile, 'window.lpai.getPathForFile (Drag & Drop)').toBe(true);

      // unknown methods are rejected by the preload allowlist, not forwarded
      const blocked = await h.invoke('definitely.not.allowed');
      expect(blocked.ok).toBe(false);
      expect(blocked.error?.message ?? '').toContain('Blocked IPC method');

      // Real IPC round-trip into the booted core
      const info = await h.invoke<{ name: string; version: string; dataDir: string; platform: string }>('app.info');
      expect(info.ok).toBe(true);
      expect(info.data?.name).toBe('Local Personal AI');
      expect(info.data?.platform).toBe(process.platform);
      // isolation proof: the test data dir, never %APPDATA%\lpai
      expect(info.data?.dataDir).toBe(h.dataDir);

      // Another real service call: conversations come from SQLite
      const convos = await h.invoke<unknown[]>('conversations.list');
      expect(convos.ok).toBe(true);
      expect(Array.isArray(convos.data)).toBe(true);

      expect(h.pageErrors, 'keine Renderer-Ausnahmen').toEqual([]);
    } finally {
      await h.attachDiagnostics(test.info());
      await h.close();
    }
  });

  test('closes cleanly: window close ends the process with exit code 0', async () => {
    const h = await launchApp();
    try {
      await waitForReady(h.page);
      const closed = new Promise<void>((resolve) => h.app.on('close', () => resolve()));
      await h.app.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) w.close();
      });
      await Promise.race([
        closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('App wurde nach dem Schließen des Fensters nicht beendet')), 45_000)),
      ]);
      // the close event can precede the OS-level exit by a moment — poll, do not sleep
      await expect.poll(() => h.app.process().exitCode, { timeout: 30_000, message: 'Prozess beendet sich' }).not.toBeNull();
      expect(h.app.process().exitCode, 'sauberer Exitcode (dispose-Kette lief durch)').toBe(0);
    } finally {
      await h.attachDiagnostics(test.info());
      await h.close({ keepProvider: true });
    }
  });
});
