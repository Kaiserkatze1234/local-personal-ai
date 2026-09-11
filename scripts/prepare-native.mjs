#!/usr/bin/env node
/**
 * Fetch the better-sqlite3 prebuilt binary for THIS Electron version into
 * native/electron/ — without touching node_modules, so `npm test` (Node ABI)
 * and `npm run dev` (Electron ABI) both work with zero rebuild dances on a
 * fresh Windows checkout. The Electron main process probes this file via
 * src/main/storage/db.ts -> resolveSqliteBinding.
 *
 * Mechanism: run better-sqlite3's own prebuild-install with
 * --runtime=electron --target=<electron version> in the package dir (which
 * also proves the package layout), then move the fresh .node into the repo
 * cache and restore the package's previous binary byte-for-byte.
 *
 * Wired as `predev` (runs before `npm run dev`); manual: `npm run native:fetch`.
 * Never hard-fails: offline or no-prebuild situations only warn — the DB
 * layer raises the actionable error if the ABI truly mismatches.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const QUIET = args.includes('--quiet');
const say = (...a) => {
  if (!QUIET) console.log('[native]', ...a);
};

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16);

function resolveBsq() {
  try {
    return dirname(require.resolve('better-sqlite3/package.json'));
  } catch {
    return null;
  }
}

function electronVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function main() {
  const bsq = resolveBsq();
  if (!bsq) {
    say('better-sqlite3 not installed yet — run npm install first; skipping.');
    return;
  }
  const ev = electronVersion();
  if (!ev) {
    say('electron not installed — nothing to prepare.');
    return;
  }
  const nativeElectron = join(ROOT, 'native', 'electron');
  const cachedBin = join(nativeElectron, 'better_sqlite3.node');
  const metaFile = join(nativeElectron, 'meta.json');
  const readMeta = () => {
    try {
      return JSON.parse(readFileSync(metaFile, 'utf8'));
    } catch {
      return null;
    }
  };

  if (!FORCE && existsSync(cachedBin) && readMeta()?.electron === ev) {
    say(`binding for Electron ${ev} already cached (native/electron) — nothing to do.`);
    return;
  }

  const pkgBin = join(bsq, 'build', 'Release', 'better_sqlite3.node');
  const pkgDir = bsq;
  const backup = existsSync(pkgBin) ? join(ROOT, 'native', '.node-backup.node') : null;
  mkdirSync(join(ROOT, 'native'), { recursive: true });
  if (backup) copyFileSync(pkgBin, backup);

  const pi = join(ROOT, 'node_modules', 'prebuild-install', 'bin.js');
  say(`fetching better-sqlite3 prebuilt for Electron ${ev} (${process.platform}-${process.arch})…`);
  const r = spawnSync(
    process.execPath,
    [pi, '--runtime=electron', `--target=${ev}`, '--platform', process.platform, '--arch', process.arch],
    {
      cwd: pkgDir,
      stdio: QUIET ? 'ignore' : 'inherit',
      timeout: 120_000,
    },
  );

  let ok = false;
  try {
    if (existsSync(pkgBin) && existsSync(backup) && sha(pkgBin) !== sha(backup)) {
      // the fresh file is the Electron build; stash it and give the package its old one back
      mkdirSync(nativeElectron, { recursive: true });
      copyFileSync(pkgBin, cachedBin);
      writeFileSync(metaFile, JSON.stringify({ electron: ev, at: new Date().toISOString(), sha16: sha(cachedBin) }, null, 2));
      ok = true;
      say(`cached Electron binding -> native/electron/better_sqlite3.node (${sha(cachedBin)})`);
    } else if (existsSync(pkgBin) && existsSync(backup) && sha(pkgBin) === sha(backup)) {
      say('prebuild-install produced no new binary (no matching prebuilt release).');
    }
  } finally {
    if (backup && existsSync(backup)) {
      copyFileSync(backup, pkgBin); // package must end exactly as it started
      rmSync(backup, { force: true });
    }
  }

  if (!ok) {
    say(
      `could not fetch an Electron prebuilt (offline, proxy, no published binary for Electron ${ev}, or timeout; exit ${String(r.status)}).` +
        ' npm test is unaffected; for dev run: npx electron-builder install-app-deps' +
        ' (then copy node_modules/better-sqlite3/build/Release/better_sqlite3.node to native/electron/).' +
        ' On Windows this fallback needs "Visual Studio Build Tools + Python" — or simply Node 22 LTS + a published prebuild.',
    );
  }
}

main();
