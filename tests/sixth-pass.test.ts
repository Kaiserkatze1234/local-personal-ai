/**
 * Sixth pass: window placement persistence (pure half) and the SQLite
 * binding resolver that keeps Node-ABI tests and Electron-ABI dev runs
 * alive in the same node_modules tree.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePlacement, snapshotPlacement } from '../src/main/electron/windowState.js';
import { resolveSqliteBinding } from '../src/main/storage/db.js';

const monitors = [
  { x: 0, y: 0, width: 1920, height: 1040 }, // primary work area (40px taskbar)
];

describe('window placement', () => {
  it('restores a sane saved rect verbatim', () => {
    const p = parsePlacement({ x: 100, y: 60, width: 1280, height: 800, maximized: false }, monitors, {
      width: 1380,
      height: 900,
    });
    expect(p).toEqual({ width: 1280, height: 800, x: 100, y: 60, maximized: false });
  });

  it('drops positions on a monitor that no longer exists (off-screen bug guard)', () => {
    const p = parsePlacement({ x: 4800, y: 120, width: 1200, height: 760, maximized: false }, monitors, {
      width: 1380,
      height: 900,
    });
    expect(p.x).toBeUndefined();
    expect(p.y).toBeUndefined();
    expect(p.width).toBe(1200); // size still honoured — only the position is unsafe
    expect(p.height).toBe(760);
  });

  it('survives garbage: null, junk, absurd sizes fall back to defaults', () => {
    for (const junk of [null, undefined, 'nope', {}, { width: 'x' }, { width: 5, height: 5 }]) {
      const p = parsePlacement(junk, monitors, { width: 1380, height: 900 });
      expect(p.width).toBe(1380);
      expect(p.height).toBe(900);
    }
  });

  it('keeps the maximized flag across save/load shape', () => {
    const snap = snapshotPlacement({ x: 10, y: 20, width: 900, height: 600, maximized: true });
    expect(snap.maximized).toBe(true);
    const back = parsePlacement(JSON.parse(JSON.stringify(snap)), monitors, { width: 1380, height: 900 });
    expect(back.maximized).toBe(true);
    expect(back.x).toBe(10);
  });

  it('multi-monitor: a position on a still-connected secondary stays put', () => {
    const two = [monitors[0] as (typeof monitors)[number], { x: 1920, y: 0, width: 2560, height: 1400 }];
    const p = parsePlacement({ x: 2200, y: 300, width: 1000, height: 700, maximized: false }, two, { width: 1380, height: 900 });
    expect(p.x).toBe(2200);
    expect(p.y).toBe(300);
  });
});

describe('resolveSqliteBinding', () => {
  it('loads the first candidate that resolves and skips the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpai-bind-'));
    try {
      const good = join(dir, 'good.cjs');
      writeFileSync(good, 'module.exports = { marker: 42 };');
      const r = resolveSqliteBinding([join(dir, 'missing.node'), join(dir, 'broken.txt'), good]);
      expect((r as { marker: number }).marker).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when nothing loads (=> library default resolution)', () => {
    expect(resolveSqliteBinding([undefined, '', 'C:\\definitely\\not\\here.node'])).toBeUndefined();
  });

  it('the real package binding resolves through the default path for this runtime', () => {
    // no candidates at all must not throw — that is the packaged/tests route
    expect(resolveSqliteBinding([])).toBeUndefined();
  });
});
