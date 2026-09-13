/**
 * End-to-end regression for the Windows `predev` crash: run the REAL
 * scripts/rebuild-native.mjs against a self-contained fixture repo where
 *   - better-sqlite3 is a pure-JS stub (node ABI probe passes without a binary),
 *   - node_modules/better-sqlite3/build/Release/better_sqlite3.node does NOT
 *     exist (the exact ENOENT precondition of the old backup step),
 *   - prebuild-install is absent (so the electron-PREBUILT fetch declines),
 *     forcing the @electron/rebuild FALLBACK — the function that crashed,
 *   - @electron/rebuild is a stub cli that writes an electron-MAGIC binding,
 *   - electron dist is missing (ABI probe degrades to format+size — by design).
 * Old code: `Error: ENOENT ... copyfile ... -> native\.node-backup-rebuild`
 * before ever reaching the rebuild. New code must complete, cache the
 * binding, and leave the fixture package EXACTLY as it started.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_SCRIPTS = resolve('scripts');
// platform-magic payload that passes magicOk() for the CURRENT platform
function fakeBinding(marker: string): Buffer {
  const head =
    process.platform === 'win32'
      ? Buffer.from([0x4d, 0x5a]) // MZ
      : process.platform === 'linux'
        ? Buffer.from([0x7f, 0x45, 0x4c, 0x46]) // \x7fELF
        : Buffer.from([0xca, 0xfe]);
  const body = Buffer.from(`${marker} `.repeat(12_000)); // > 100_000 bytes
  return Buffer.concat([head, Buffer.alloc(0), body.slice(0, Math.max(0, 110_000 - body.length)), body]);
}

let root: string;
let pkgBin: string;
let cacheBin: string;

function writeTree() {
  root = mkdtempSync(join(tmpdir(), 'lpai-native-fixture-'));
  const bsq = join(root, 'node_modules', 'better-sqlite3');
  mkdirSync(join(bsq, 'build', 'Release'), { recursive: true });
  pkgBin = join(bsq, 'build', 'Release', 'better_sqlite3.node');
  cacheBin = join(root, 'native', 'electron', `${process.platform}-${process.arch}`, 'better_sqlite3.node');

  // package + pure-JS stub binding resolution: class satisfies the probe (`new D(':memory:').exec(...)`)
  writeFileSync(join(bsq, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '0.0.0-fixture', main: 'index.js' }));
  writeFileSync(
    join(bsq, 'index.js'),
    'module.exports = class D { constructor(){ if (process.env.FIXTURE_BINDING_REQUIRED && !require("node:fs").existsSync(require("node:path").join(__dirname,"build","Release","better_sqlite3.node"))) throw new Error("missing binding") } exec(){} };\n',
  );

  // electron "installed" (version needed for target ABI computation); dist intentionally absent
  const el = join(root, 'node_modules', 'electron');
  mkdirSync(el, { recursive: true });
  writeFileSync(join(el, 'package.json'), JSON.stringify({ name: 'electron', version: '33.4.5' }));

  // @electron/rebuild stub: "rebuilds" by WRITING an electron-magic binding into the package
  const cli = join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(
    cli,
    [
      'const { mkdirSync, writeFileSync } = require("node:fs");',
      'const { join } = require("node:path");',
      'if (process.env.FIXTURE_REBUILDS_FAIL) process.exit(1);',
      'const rel = join(__dirname, "..", "..", "..", "better-sqlite3", "build", "Release");',
      'mkdirSync(rel, { recursive: true });',
      'if (process.env.FIXTURE_UNCHANGED) process.exit(0); // succeeded but produced NOTHING new',
      'const head = process.platform === "win32" ? Buffer.from([0x4d,0x5a]) : process.platform === "linux" ? Buffer.from([0x7f,0x45,0x4c,0x46]) : Buffer.from([0xca,0xfe]);',
      'const body = Buffer.from(("ELECTRON-ABI-PRODUCED ").repeat(12000)).subarray(0, 110000);',
      'writeFileSync(join(rel, "better_sqlite3.node"), Buffer.concat([head, body]));',
      'process.exit(0);',
    ].join('\n'),
  );
  // prebuild-install deliberately ABSENT -> fetch declines -> fallback runs

  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  copyFileSync(join(REPO_SCRIPTS, 'rebuild-native.mjs'), join(scripts, 'rebuild-native.mjs'));
  copyFileSync(join(REPO_SCRIPTS, 'native-swap.mjs'), join(scripts, 'native-swap.mjs'));
}

beforeAll(writeTree);

describe('rebuild-native.mjs survives a missing pre-rebuild Node binding (Windows predev ENOENT)', () => {
  it('fallback path completes: no ENOENT, binding cached, package left untouched (absent)', async () => {
    expect(existsSync(pkgBin), 'fixture precondition: NO node binding exists').toBe(false);
    rmSync(dirname(cacheBin), { recursive: true, force: true });
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'rebuild-native.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, PATH: process.env.PATH },
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status, out).toBe(0);
    expect(out, 'the old crash signature (ENOENT during copyfile backup) must be gone').not.toMatch(
      /ENOENT[^\n]*copyfile|copyfile[^\n]*ENOENT/i,
    );
    expect(out).toContain('fetched + verified');
    expect(existsSync(cacheBin)).toBe(true);
    expect(readFileSync(cacheBin, 'utf8')).toContain('ELECTRON-ABI-PRODUCED'); // cached the PRODUCED file, not a restored one
    expect(existsSync(pkgBin), 'no original -> package stays WITHOUT a binding').toBe(false);
    const meta = JSON.parse(readFileSync(join(dirname(cacheBin), 'meta.json'), 'utf8'));
    expect(meta.electron).toBe('33.4.5');
    expect(existsSync(join(root, 'native', '.node-backup-rebuild')), 'backup cleaned up').toBe(false);
  });

  it('pre-existing binding: untouched producer => loud FAILED, original survives byte-for-byte, cache not poisoned', async () => {
    const original = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('NODE-ABI-ORIGINAL '.repeat(9000))]);
    writeFileSync(pkgBin, original);
    rmSync(dirname(cacheBin), { recursive: true, force: true });
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'rebuild-native.mjs'), '--force'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, FIXTURE_UNCHANGED: '1' },
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status, out).toBe(0); // non-dist: loud FAILED line, never a crash
    expect(out).toContain('FAILED');
    expect(readFileSync(pkgBin)).toEqual(original); // working Node ABI untouched, byte-for-byte
    expect(existsSync(cacheBin), 'unchanged file must NOT be cached as an electron binding').toBe(false);
    expect(existsSync(join(root, 'native', '.node-backup-rebuild'))).toBe(false);
  });

  it('fallback FAILING with a missing binding is still a graceful, loud FAILED (never a crash)', async () => {
    rmSync(dirname(cacheBin), { recursive: true, force: true });
    rmSync(pkgBin, { force: true }); // precondition again: package without any binding
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'rebuild-native.mjs'), '--force'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, FIXTURE_REBUILDS_FAIL: '1' },
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out, 'no crash from the backup step even when nothing was backed up').not.toMatch(/ENOENT[^\n]*copyfile|copyfile[^\n]*ENOENT/i);
    expect(out).toContain('FAILED'); // actionable message, exit stays 0 for non-dist (predev survives, DB layer errors at boot)
    expect(r.status).toBe(0);
    expect(existsSync(pkgBin)).toBe(false);
  });
});
