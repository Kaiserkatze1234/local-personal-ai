/**
 * Bundles the Electron main process (ESM) and preload (CJS) with esbuild.
 * Type checking is done separately by `npm run typecheck` (tsc --noEmit).
 *
 * Phase 0 requirement: the app must be buildable without a tsc emit pipeline.
 */
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

/** Modules that must stay external: provided by Electron/Node at runtime. */
const external = ['electron', 'better-sqlite3'];

const targets = [
  {
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main/index.js',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external,
    sourcemap: true,
    logLevel: 'warning',
    define: { 'import.meta.dirname': '""' },
  },
  {
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/preload/index.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external,
    sourcemap: false,
    logLevel: 'warning',
  },
];

async function run() {
  if (watch) {
    for (const t of targets) {
      const ctx = await context(t);
      await ctx.watch();
    }
    console.log('[build] watching main + preload');
  } else {
    await Promise.all(targets.map((t) => build(t)));
    console.log('[build] main + preload bundled to dist/');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
