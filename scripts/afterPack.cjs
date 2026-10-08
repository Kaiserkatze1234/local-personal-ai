/**
 * electron-builder afterPack hook — reproducibility contract between dev and dist.
 *
 * With `npmRebuild: false` (electron-builder.yml) the builder no longer swaps
 * better-sqlite3's binary in node_modules; node_modules therefore ALWAYS holds
 * the Node ABI (tests keep working straight after a build). This hook copies the
 * verified, cached Electron-ABI binding — the very same bytes `npm run dev`
 * probes — into the packaged app, choosing the correct <platform>-<arch> entry
 * and validating the binary format before anything ships.
 *
 * Writes:
 *   resources/native/electron/better_sqlite3.node        (db.ts resolveSqliteBinding candidate)
 *   resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/…  (default require path)
 *
 * Missing/mismatched cache => build FAILS with the exact fix command. No silent fallbacks.
 */

const { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

function magicOk(platform, file) {
  try {
    const b = readFileSync(file).subarray(0, 4);
    if (platform === 'win32') return b[0] === 0x4d && b[1] === 0x5a; // MZ (PE)
    if (platform === 'linux') return b[0] === 0x7f && b[1] === 0x45; // \x7fELF
    if (platform === 'darwin') return [0xcf, 0x89, 0xce, 0xca, 0x21, 0x3c].includes(b[0]); // mach-o-ish sanity
    return false;
  } catch {
    return false;
  }
}

// builder-util Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4 —
// the REAL electron-builder context passes `arch` as a NUMBER; 'x64'/'arm64'
// strings only ever appeared in our old mocks (both shapes accepted here).
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];
function archName(arch) {
  if (typeof arch === 'number') return ARCH_NAMES[arch] ?? 'x64';
  if (typeof arch === 'string' && arch) return arch;
  return 'x64';
}

/**
 * electron-builder 26.x PlatformPackager exposes `projectDir` as a STRING
 * getter (platformPackager.d.ts: `get projectDir(): string`; `packager.info`
 * is the Packager, whose `readonly projectDir` is also a string). The former
 * `projectDir?.()` call was never the real API and crashed a full Windows
 * dist with "context.packager?.projectDir is not a function".
 */
function resolveProjectDir(context) {
  const p = context == null ? void 0 : context.packager;
  for (const v of [p == null ? void 0 : p.projectDir, p?.info?.projectDir]) {
    if (typeof v === 'string' && v) return v;
  }
  return process.cwd();
}

/** Exported for tests; `context` mirrors electron-builder's AfterPackContext. */
async function afterPack(context) {
  const platform = context.electronPlatformName ?? context.platform ?? process.platform;
  const arch = archName(context.arch);
  const nativeDir = process.env.LPAI_NATIVE_ROOT ?? join(resolveProjectDir(context), 'native', 'electron');
  const triple = `${platform}-${arch}`;
  const src = join(nativeDir, triple, 'better_sqlite3.node');
  const metaFile = join(nativeDir, triple, 'meta.json');

  if (!existsSync(src) || !existsSync(metaFile)) {
    throw new Error(
      `[afterPack] no cached Electron-ABI binding for ${triple}. Run \`npm run rebuild:native -- --targets=${triple}\` ` +
        `(automatic via \`npm run dist\`'s predist hook) and retry.`,
    );
  }
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  const ev = context.packager?.info?.electronVersion ?? context.electronVersion;
  if (ev && meta.electron !== ev) {
    throw new Error(
      `[afterPack] cached binding for ${triple} targets Electron ${meta.electron} but this build uses ${ev}. ` +
        'Run `npm run rebuild:native -- --force`.',
    );
  }
  if (!magicOk(platform, src) || statSync(src).size < 100_000) {
    throw new Error(
      `[afterPack] cached binding for ${triple} is corrupt or not a ${platform} binary. Run \`npm run rebuild:native -- --force\`.`,
    );
  }

  const appOutDir = context.appOutDir;
  if (!appOutDir) throw new Error('[afterPack] context.appOutDir missing');
  // Always write the explicit candidate that db.ts probes first…
  const targets = [join(appOutDir, 'resources', 'native', 'electron', 'better_sqlite3.node')];
  // …and, when asarUnpack produced the node_modules copy, overwrite it too, so
  // even the package's default require() path resolves to the Electron ABI.
  const unpacked = join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release');
  if (existsSync(unpacked)) targets.push(join(unpacked, 'better_sqlite3.node'));
  mkdirSync(join(appOutDir, 'resources', 'native', 'electron'), { recursive: true });
  for (const t of targets) {
    copyFileSync(src, t); // unpacked dir pre-exists by construction; resources one we just created
    if (!magicOk(platform, t) || statSync(t).size < 100_000) throw new Error(`[afterPack] post-copy verification failed for ${t}`);
  }
  console.log(
    `[afterPack] native binding (${triple}, sha16 ${meta.sha16 ?? '?'}) installed into ${targets.length} location(s) under ${join(appOutDir, 'resources')}`,
  );
}

module.exports = afterPack;
module.exports.afterPack = afterPack;
module.exports.magicOk = magicOk;
module.exports.archName = archName;
module.exports.resolveProjectDir = resolveProjectDir;
