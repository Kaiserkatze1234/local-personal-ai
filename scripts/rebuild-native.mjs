#!/usr/bin/env node
/**
 * Reproducible native-module build for better-sqlite3 — single source of truth.
 *
 * Two ABIs must coexist, and this script guarantees both without ever leaving
 * the repo in a half-repaired state:
 *
 *   1. NODE ABI  (node_modules/better-sqlite3)      -> `npm test` / vitest
 *   2. ELECTRON ABI (native/electron/<plat>-<arch>/) -> `npm run dev` and, via
 *      the afterPack hook, the packaged app — dist embeds these exact cached
 *      bytes, so dev and dist always run the identical native configuration.
 *
 * Fetching uses better-sqlite3's own prebuild-install (download only, no
 * compiler needed on Windows); the swap into node_modules is fully backed up
 * and restored byte-for-byte, so a run can never destroy the working Node ABI.
 * When no prebuilt exists for the target (future Electron/Node majors), the
 * script falls back to `@electron/rebuild` (current platform only) and finally
 * to an actionable error — never silence.
 *
 * Modes:
 *   (no flags)         ensure node ABI + electron binding for the CURRENT platform
 *   --node-only        only verify/repair the node ABI (used as pretest)
 *   --quiet            minimal output (used as predev)
 *   --dist             ensure node ABI + every win32 arch the dist targets need
 *   --targets=a,b      explicit <platform>-<arch> triples (override default)
 *   --force            re-fetch even when the cache matches
 *
 * Wired as: pretest, predev, predist, and `npm run rebuild:native`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(join(ROOT, 'package.json'));
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const QUIET = args.includes('--quiet');
const NODE_ONLY = args.includes('--node-only');
const DIST = args.includes('--dist');
const say = (...a) => {
  if (!QUIET) console.log('[native]', ...a);
};
const fail = (msg) => {
  console.error('[native] ERROR:', msg);
  process.exit(1);
};

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16);
const NATIVE_DIR = process.env.LPAI_NATIVE_ROOT ?? join(ROOT, 'native', 'electron');

function magicOk(platform, file) {
  try {
    const b = readFileSync(file).subarray(0, 4);
    if (platform === 'win32') return b[0] === 0x4d && b[1] === 0x5a; // MZ (PE)
    if (platform === 'linux') return b[0] === 0x7f && b[1] === 0x45; // \x7fELF
    return statSync(file).size > 100_000; // darwin/fat binaries: size sanity only
  } catch {
    return false;
  }
}

function betterSqliteDir() {
  try {
    return dirname(require_.resolve('better-sqlite3/package.json'));
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

/** ---- 1. Node ABI: verified by actually opening an in-memory database. ---- */
function ensureNodeAbi() {
  const probe = spawnSync(
    process.execPath,
    ['-e', "const D=require('better-sqlite3'); const db=new D(':memory:'); db.exec('select 1'); process.exit(typeof D==='function'?0:2)"],
    { cwd: ROOT, stdio: 'ignore', timeout: 30_000 },
  );
  if (probe.status === 0) {
    say('node ABI binding loads (vitest-ready) ✓');
    return true;
  }
  say('node ABI binding is broken (wrong file after a native rebuild?) — repairing via `npm rebuild better-sqlite3`…');
  const r = spawnSync('npm', ['rebuild', 'better-sqlite3'], { cwd: ROOT, stdio: QUIET ? 'ignore' : 'inherit', timeout: 900_000 });
  const re = spawnSync(process.execPath, ['-e', "const D=require('better-sqlite3'); new D(':memory:').exec('select 1')"], {
    cwd: ROOT,
    stdio: 'ignore',
    timeout: 30_000,
  });
  if (re.status === 0) {
    say('node ABI restored ✓');
    return true;
  }
  fail(
    `better-sqlite3 could not be rebuilt for Node (npm rebuild exit ${String(r.status)}).\n` +
      '  → Node 22+ LTS is required for prebuilt Node binaries; older majors compile from source\n' +
      '    and then need "Visual Studio Build Tools + Python" on Windows.\n' +
      '  → Or: npm install better-sqlite3@latest',
  );
}

/** ---- 2. Electron ABI per <platform>-<arch> triple, cached under native/. ----
 * The helpers must stash the swapped binary into the cache INSIDE their try,
 * before restoring node_modules byte-for-byte in finally — copying afterwards
 * would cache the restored Node-ABI file (magic bytes can't tell them apart!).
 * For same-platform builds the cached file is then proven by making the real
 * Electron binary `require()` it — the only check that verifies ABI, not just
 * file format. Cross-platform entries get magic+size verification only.
 */
function stashToCache(pkgBin, dest) {
  mkdirSync(dest, { recursive: true });
  copyFileSync(pkgBin, join(dest, 'better_sqlite3.node'));
}

function fetchPrebuilt(bsq, platform, arch, ev, dest) {
  const pkgBin = join(bsq, 'build', 'Release', 'better_sqlite3.node');
  const backup = join(ROOT, 'native', `.node-backup-${platform}-${arch}`);
  mkdirSync(dirname(backup), { recursive: true });
  const had = existsSync(pkgBin);
  if (had) copyFileSync(pkgBin, backup);
  try {
    const pi = join(ROOT, 'node_modules', 'prebuild-install', 'bin.js');
    if (!existsSync(pi)) return false;
    const r = spawnSync(process.execPath, [pi, '--runtime=electron', `--target=${ev}`, '--platform', platform, '--arch', arch], {
      cwd: bsq,
      stdio: QUIET ? 'ignore' : 'inherit',
      timeout: 180_000,
    });
    if (r.status !== 0 || !existsSync(pkgBin) || (had && sha(pkgBin) === sha(backup))) return false;
    stashToCache(pkgBin, dest); // BEFORE the restore below
    return true;
  } finally {
    if (had) copyFileSync(backup, pkgBin); // package must end exactly as it started
    rmSync(backup, { force: true });
  }
}

function rebuildViaElectronRebuild(bsq, dest) {
  // current platform only, requires local toolchain — fallback when no prebuilt exists
  const bin = join(ROOT, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
  if (!existsSync(bin)) return false;
  const pkgBin = join(bsq, 'build', 'Release', 'better_sqlite3.node');
  const backup = join(ROOT, 'native', '.node-backup-rebuild');
  copyFileSync(pkgBin, backup);
  try {
    const r = spawnSync(process.execPath, [bin, '--force', '--only', 'better-sqlite3'], {
      cwd: ROOT,
      stdio: QUIET ? 'ignore' : 'inherit',
      timeout: 1_800_000,
    });
    if (r.status !== 0 || !existsSync(pkgBin) || sha(pkgBin) === sha(backup)) return false;
    stashToCache(pkgBin, dest); // BEFORE the restore below
    return true;
  } finally {
    copyFileSync(backup, pkgBin); // never leave the Electron build inside node_modules
    rmSync(backup, { force: true });
  }
}

/** Make the actual Electron binary load the file — definitive ABI verification. */
function probeInElectron(binding) {
  const probe = join(ROOT, 'native', '.abi-probe.cjs');
  mkdirSync(dirname(probe), { recursive: true });
  writeFileSync(
    probe,
    "const p = process.argv.find((a) => a.endsWith('.node'));\ntry { require(p); console.log('ABI_OK'); process.exit(0); } catch (e) { console.error(String(e.message).split('\\n')[0]); process.exit(1); }\n",
  );
  const electronBin = join(ROOT, 'node_modules', 'electron', process.platform === 'win32' ? 'electron.exe' : 'dist/electron');
  try {
    // headless-safe: the probe never opens a window; --no-sandbox for restricted envs
    const r = spawnSync(electronBin, [probe, binding, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], {
      encoding: 'utf8',
      timeout: 45_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, // plain Node-in-Electron still checks NODE_MODULE_VERSION
    });
    rmSync(probe, { force: true });
    if (r.stdout?.includes('ABI_OK')) return { ok: true };
    if (r.error) return { ok: null, why: `could not launch electron for probing (${r.error.message})` };
    const err = String(r.stderr ?? '');
    if (r.status === 127 || err.includes('error while loading shared libraries')) {
      // Electron itself cannot start in THIS environment (missing system libs) —
      // that is not a verdict on the binding's ABI; fall back to format+size check.
      return { ok: null, why: 'electron not launchable here (missing system libraries)' };
    }
    return { ok: false, why: err.trim().split('\n')[0] || 'load failed' };
  } catch (e) {
    rmSync(probe, { force: true });
    return { ok: null, why: `probe failed: ${String(e)}` };
  }
}

function ensureElectronAbi(bsq, ev, triples) {
  const results = [];
  for (const t of triples) {
    const [platform, arch] = t.split('-');
    const dir = join(NATIVE_DIR, t);
    const bin = join(dir, 'better_sqlite3.node');
    const metaFile = join(dir, 'meta.json');
    let meta = null;
    try {
      meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    } catch {
      /* first run */
    }
    if (!FORCE && meta?.electron === ev && existsSync(bin) && magicOk(platform, bin)) {
      results.push(`${t}: cached ✓ (${meta.sha16})`);
      continue;
    }
    let ok = false;
    say(`fetching better-sqlite3 prebuilt for Electron ${ev} (${t})…`);
    if (fetchPrebuilt(bsq, platform, arch, ev, dir)) ok = true;
    if (!ok && t === `${process.platform}-${process.arch}`) {
      say(`no prebuilt available for ${t} — falling back to @electron/rebuild (needs local toolchain)…`);
      if (rebuildViaElectronRebuild(bsq, dir)) ok = true;
    }
    if (!ok) {
      results.push(
        `${t}: FAILED — no prebuilt for electron-v${ev.replace(/\./g, '')} on ${t} and no toolchain fallback. ` +
          'Options: use an Electron version better-sqlite3 publishes prebuilds for, install VS Build Tools + Python, or set LPAI_SQLITE_BINDING to a manually built binding.',
      );
      continue;
    }
    if (!existsSync(bin) || !magicOk(platform, bin) || statSync(bin).size < 100_000) {
      rmSync(dir, { recursive: true, force: true });
      results.push(`${t}: FAILED — fetched file is not a valid ${platform} binary (corrupt download? proxy?)`);
      continue;
    }
    // same-platform: PROVE the ABI by making the real Electron binary load it
    if (t === `${process.platform}-${process.arch}`) {
      const p = probeInElectron(bin);
      if (p.ok === false) {
        rmSync(dir, { recursive: true, force: true });
        results.push(`${t}: FAILED — Electron refused to load the fetched binding: ${p.why}`);
        continue;
      }
      if (p.ok === null) say(`note: ${p.why} — falling back to format+size verification for ${t}`);
    }
    const s = sha(bin);
    writeFileSync(metaFile, JSON.stringify({ electron: ev, platform, arch, sha16: s, at: new Date().toISOString() }, null, 2));
    results.push(`${t}: fetched + verified ✓ (${s})`);
  }
  return results;
}

function main() {
  const bsq = betterSqliteDir();
  if (!bsq) {
    if (QUIET) return; // pretest/predev before `npm install` — nothing to do, npm install fixes it next run
    say('better-sqlite3 not installed — run npm install first; skipping.');
    return;
  }
  const nodeOk = ensureNodeAbi();
  if (NODE_ONLY) {
    if (!nodeOk) fail('node ABI could not be restored');
    return;
  }
  const ev = electronVersion();
  if (!ev) fail('electron is not installed — cannot determine the target ABI');
  const targetArg = args.find((a) => a.startsWith('--targets='));
  const triples = targetArg
    ? targetArg
        .slice('--targets='.length)
        .split(',')
        .map((s) => s.trim())
    : DIST
      ? ['win32-x64', 'win32-arm64']
      : [`${process.platform}-${process.arch}`];
  const results = ensureElectronAbi(bsq, ev, triples);
  for (const r of results) say(r);
  const failed = results.filter((r) => r.includes('FAILED'));
  if (failed.length > 0) {
    // dev on other OSes may survive with the default require path; dist must never ship a broken native config
    if (DIST || !process.resourcesPath) for (const f of failed) console.error('[native]', f);
    if (DIST) fail('dist needs verified bindings for every target arch — see [native] lines above');
    say('warning: proceeding — the DB layer will raise an actionable error at app boot if the ABI truly mismatches.');
  }
}

main();
