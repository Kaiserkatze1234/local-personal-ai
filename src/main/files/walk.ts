/**
 * Directory walker used by indexing + file tools. Skips generated junk by
 * default (§13 "ignored files"). Sync iteration is chunked by callers for
 * big trees; the queue breaks work between batches (recoverability §3.6).
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export interface WalkEntry {
  absPath: string;
  relPath: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface WalkOptions {
  maxEntries?: number;
  maxDepth?: number;
  excludeDirs?: string[];
  skipGenerated?: boolean;
}

const GENERATED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.next',
  '.nuxt',
  '.parcel-cache',
  'coverage',
  '.pytest_cache',
  '.mypy_cache',
  '.idea',
  '.vscode',
  'bin',
  'obj',
  '.gradle',
  '.turbo',
  '.svelte-kit',
  'release',
]);

export function walkFiles(root: string, opts: WalkOptions = {}): WalkEntry[] {
  const max = opts.maxEntries ?? 5000;
  const maxDepth = opts.maxDepth ?? 12;
  const exclude = new Set((opts.excludeDirs ?? []).map((d) => d.toLowerCase()));
  const out: WalkEntry[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: resolve(root), depth: 0 }];
  while (stack.length > 0 && out.length < max) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // permission errors: skip silently, diagnostics covers it
    }
    for (const name of names) {
      if (out.length >= max) break;
      const lower = name.toLowerCase();
      if ((opts.skipGenerated ?? true) && GENERATED.has(lower)) continue;
      if (exclude.has(lower)) continue;
      const abs = join(dir, name);
      let st: import('node:fs').Stats;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const isDir = st.isDirectory();
      out.push({ absPath: abs, relPath: relative(root, abs).split(sep).join('/'), isDir, size: st.size, mtimeMs: st.mtimeMs });
      if (isDir && depth + 1 < maxDepth) stack.push({ dir: abs, depth: depth + 1 });
    }
  }
  return out;
}
