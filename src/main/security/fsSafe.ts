/**
 * Filesystem safety helpers — §11 (scoped access), §36, §3.6 (atomic writes).
 * All path resolution for tools goes through here.
 */
import { copyFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** True when `child` is inside `root` (or equals it), lexically resolved. */
export function isInside(root: string, child: string): boolean {
  const r = resolve(root);
  const c = resolve(child);
  if (c === r) return true;
  const rel = relative(r, c);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export interface ScopedResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * Resolve a user/model provided path under the first matching root of
 * `roots`. Rejects traversal outside roots, and absolute paths when roots
 * are given. Empty roots => nothing allowed.
 */
export function resolveScopedPath(raw: string, roots: string[], cwd?: string): ScopedResult {
  if (roots.length === 0) return { ok: false, error: 'No accessible directories configured (add one under Settings → Tools).' };
  if (!raw || typeof raw !== 'string') return { ok: false, error: 'Empty path.' };
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd ?? roots[0] ?? '.', raw);
  const root = roots.map((r) => resolve(r)).find((r) => isInside(r, abs));
  if (!root) return { ok: false, error: `Path is outside the configured scope: ${abs}` };
  return { ok: true, path: abs };
}

/** Atomic text write: temp in the same dir, then rename over target. */
export function atomicWrite(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.lpairename-${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function copyInto(destPath: string, srcPath: string): void {
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(srcPath, destPath);
}

/** Key for ignoring: normalize separators, lowercase drive on win32. */
export function normalizePathForCompare(p: string): string {
  const n = resolve(p).replaceAll(sep, '/');
  return process.platform === 'win32' ? n.toLowerCase() : n;
}
