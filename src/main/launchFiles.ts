/**
 * Turn process-launch arguments into document paths — the mechanism that
 * lets the app "start by opening one thing": a double-click on an
 * associated file or Explorer's "Öffnen mit…" invokes the executable with
 * the document path as a plain argv entry; a Windows second instance
 * forwards its argv through the `second-instance` event.
 *
 * Electron/Chromium also append their own switches and the app directory,
 * so anything that is not an existing regular file is ignored — no guessing.
 * Pure + injected `isFile` so it is unit-testable without Electron.
 */

import { posix, win32 } from 'node:path';

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
const ELECTRON_EXE = /[\\/]electron\.exe$/i;

/**
 * Path semantics per argument: a drive-letter argument is a Windows path
 * even when this code runs on another OS (dev on Linux, tests), while bare
 * relative arguments follow the host. That keeps the parser deterministic
 * everywhere while staying exactly right on the Windows target.
 */
function pathApiFor(arg: string, cwd: string): typeof posix {
  if (WINDOWS_DRIVE.test(arg) || WINDOWS_DRIVE.test(cwd)) return win32;
  return process.platform === 'win32' ? win32 : posix;
}

export interface LaunchFileOptions {
  /** Base directory that relative arguments are resolved against. */
  cwd: string;
  /** Executable path (argv[0]) — never treated as a document. */
  exe?: string;
  /** App directory — `electron .` in dev passes it positionally. */
  appDir?: string;
  /** True only for existing regular files (statSync().isFile() at the host). */
  isFile(path: string): boolean;
}

export function extractLaunchFiles(argv: readonly string[], opts: LaunchFileOptions): string[] {
  // Windows paths are case-insensitive; compare lowercase there.
  const norm = (p: string): string => {
    const n = pathApiFor(p, opts.cwd).normalize(p);
    return WINDOWS_DRIVE.test(n) ? n.toLowerCase() : n;
  };
  const skip = new Set([opts.exe, opts.appDir].filter((x): x is string => Boolean(x)).map(norm));

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of argv) {
    if (!raw) continue;
    let arg = raw.trim();
    // Defensive: strip surrounding quotes some launchers pass through.
    if (arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')) arg = arg.slice(1, -1).trim();
    if (!arg) continue;
    if (arg.startsWith('-')) continue; // Chromium/Electron switches
    if (arg === '.' || arg === '..') continue; // dev mode: `electron .`
    if (ELECTRON_EXE.test(arg)) continue;
    const api = pathApiFor(arg, opts.cwd);
    const abs = api.isAbsolute(arg) ? api.normalize(arg) : api.resolve(opts.cwd, arg);
    if (skip.has(norm(abs))) continue;
    if (!opts.isFile(abs)) continue;
    const key = norm(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}
