/**
 * Backup-safe swap shared by both native-binding acquisition paths
 * (prebuild-install fetch and @electron/rebuild fallback) in
 * rebuild-native.mjs. One rule, applied identically whether or not a Node-ABI
 * binding pre-existed:
 *
 *   - node_modules better-sqlite3 ends EXACTLY as it started:
 *       had file  -> original bytes restored byte-for-byte
 *       no file   -> the produced file is REMOVED again (a missing
 *                    build/Release/better_sqlite3.node is legitimate: the
 *                    package may resolve its binding elsewhere, e.g. prebuilds/
 *                    lookups — backup/restore must not assume it exists; that
 *                    assumption was the Windows predev ENOENT crash)
 *   - stash() runs INSIDE the try, while the produced binding is on disk —
 *     copying afterwards would cache the restored Node-ABI file (magic bytes
 *     cannot tell them apart)
 *   - returns true only if: produce succeeded AND the binding exists AND it
 *     differs from the original (unchanged file = nothing usable was produced)
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export function shaFile(f) {
  return createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16);
}

export function swapWithProducedBinding({ pkgBin, backup, produce, stash }) {
  const had = existsSync(pkgBin);
  const originalSha = had ? shaFile(pkgBin) : null;
  if (had) {
    mkdirSync(dirname(backup), { recursive: true });
    copyFileSync(pkgBin, backup);
  }
  let ok = false;
  let restoreError = null;
  try {
    ok = produce() === true;
    // a successful producer MUST have left the expected binding on disk —
    // verify it, never trust the exit code alone
    if (ok && !existsSync(pkgBin)) ok = false;
    if (ok && had && shaFile(pkgBin) === originalSha) ok = false;
    if (ok) stash(pkgBin);
  } finally {
    // The producer's first act can be a clean: node-gyp/@electron-rebuild remove
    // build/Release entirely before they (possibly) fail. Restoring into a
    // directory that no longer exists threw ENOENT out of this finally — which
    // left the package WITHOUT its Node binding and the backup stranded on disk
    // (real failure mode: offline/module-mismatch fetch failing on Windows).
    if (had) {
      mkdirSync(dirname(pkgBin), { recursive: true });
      copyFileSync(backup, pkgBin);
      const restored = shaFile(pkgBin);
      if (restored !== originalSha) {
        // recorded, not thrown: a throw from finally would mask the producer's
        // own error and leave the caller without the real reason
        restoreError = new Error(`restoring the original binding failed (sha ${restored} != ${String(originalSha)})`);
      }
    } else {
      rmSync(pkgBin, { force: true });
    }
    rmSync(backup, { force: true });
  }
  if (restoreError) throw restoreError;
  return ok;
}
