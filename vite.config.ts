import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Renderer (React UI) build. The main process + preload are bundled by
 * scripts/build.mjs (esbuild) instead, so this config only covers the UI.
 * Three HTML entries, all relative to root: main window, overlay (Phase 12),
 * region capture selector (Phase 23).
 */
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      // paths relative to `root` (src/renderer) — Vite 8/rolldown validates this
      // strictly; 'src/renderer/index.html' resolved to root+prefix and failed the
      // dependency scan ("failed to resolve rolldownOptions.input value")
      input: {
        main: 'index.html',
        overlay: 'overlay.html',
        region: 'region.html',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
