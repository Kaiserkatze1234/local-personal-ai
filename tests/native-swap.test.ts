/**
 * Regression for the Windows predev ENOENT crash: scripts/rebuild-native.mjs
 * assumed a Node-ABI binding already exists in build/Release before backing it
 * up. It legitimately can be ABSENT (the package may resolve its binding via
 * prebuilds/ lookups, or after install flows that never populate it). The
 * swap helper must handle both worlds and restore node_modules EXACTLY as it
 * started — including back to "absent".
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { shaFile, swapWithProducedBinding } from '../scripts/native-swap.mjs';

let dir: string;
let pkgBin: string;
let backup: string;
let cache: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lpai-swap-'));
  mkdirSync(join(dir, 'build', 'Release'), { recursive: true });
  pkgBin = join(dir, 'build', 'Release', 'better_sqlite3.node');
  backup = join(dir, '.backup');
  cache = join(dir, 'cache');
  mkdirSync(cache, { recursive: true });
});

describe('swapWithProducedBinding — missing pre-rebuild binding (the crash case)', () => {
  it('no original binding: never crashes, stashes the produced file, leaves pkgBin ABSENT again', () => {
    expect(existsSync(pkgBin)).toBe(false);
    const ok = swapWithProducedBinding({
      pkgBin,
      backup,
      produce: () => {
        // what @electron-rebuild/prebuild-install do: WRITE the electron binding in place
        writeFileSync(pkgBin, 'ELECTRON-ABI'.repeat(10));
        return true;
      },
      stash: (p) => copyFileSync(p, join(cache, 'better_sqlite3.node')),
    });
    expect(ok).toBe(true);
    expect(readFileSync(join(cache, 'better_sqlite3.node'), 'utf8')).toContain('ELECTRON-ABI'); // cache got the ELECTRON file, stashed before restore
    expect(existsSync(pkgBin), 'package must end exactly as it started — with NO binding').toBe(false);
    expect(existsSync(backup), 'no backup residue').toBe(false);
  });

  it('missing binding + producer fails: quiet false, still nothing left behind', () => {
    const ok = swapWithProducedBinding({
      pkgBin,
      backup,
      produce: () => false,
      stash: () => {
        throw new Error('must not stash');
      },
    });
    expect(ok).toBe(false);
    expect(existsSync(pkgBin)).toBe(false);
    expect(existsSync(backup)).toBe(false);
  });

  it('producer "succeeds" but wrote NO file: returns false (verify-existence rule, req 5)', () => {
    const ok = swapWithProducedBinding({
      pkgBin,
      backup,
      produce: () => true, // exit 0 alone must not be enough
      stash: () => {
        throw new Error('must not stash a missing binding');
      },
    });
    expect(ok).toBe(false);
    expect(existsSync(join(cache, 'better_sqlite3.node'))).toBe(false);
  });

  it('original binding present: byte-for-byte restore AND changed-file detection (preserved path)', () => {
    writeFileSync(pkgBin, 'NODE-ABI-original');
    const original = shaFile(pkgBin);
    const ok = swapWithProducedBinding({
      pkgBin,
      backup,
      produce: () => {
        writeFileSync(pkgBin, 'ELECTRON-ABI-newbytes');
        return true;
      },
      stash: (p) => copyFileSync(p, join(cache, 'better_sqlite3.node')),
    });
    expect(ok).toBe(true);
    expect(shaFile(pkgBin)).toBe(original); // working Node ABI survives byte-for-byte
    expect(readFileSync(join(cache, 'better_sqlite3.node'), 'utf8')).toContain('ELECTRON-ABI');
    expect(existsSync(backup)).toBe(false);
  });

  it('producer leaves the file UNCHANGED: nothing usable -> false, no stash, original intact', () => {
    writeFileSync(pkgBin, 'NODE-ABI-original');
    const original = shaFile(pkgBin);
    const ok = swapWithProducedBinding({
      pkgBin,
      backup,
      produce: () => true, // command succeeded but never rewrote the binding
      stash: () => {
        throw new Error('unchanged file must not be cached');
      },
    });
    expect(ok).toBe(false);
    expect(shaFile(pkgBin)).toBe(original);
  });
});
