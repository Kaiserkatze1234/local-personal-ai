/**
 * Shared esbuild helper for the headless tooling (same pattern as
 * scripts/bench.mjs): the logic lives in typed TS under src/main/diagnostics/
 * so it is checked by `npm run typecheck` with the app, and the CLI entry
 * bundles it on demand and runs it on plain Node — no Electron involved.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, relative } from 'node:path';

export async function ensureBundle({ entry, out, external = ['better-sqlite3'], define = { 'import.meta.dirname': '""' }, quiet = false }) {
  const fresh = existsSync(out) && existsSync(entry) && statSync(out).mtimeMs >= statSync(entry).mtimeMs;
  if (!fresh) {
    const { build } = await import('esbuild');
    mkdirSync(dirname(out), { recursive: true });
    await build({
      entryPoints: [entry],
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      external,
      logLevel: 'warning',
      define,
    });
    if (!quiet) console.log(`[bundle] ${relative(process.cwd(), out)}`);
  }
  return out;
}
