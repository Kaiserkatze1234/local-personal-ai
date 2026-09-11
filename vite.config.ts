import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Renderer (React UI) build. The main process + preload are bundled by
 * scripts/build.mjs (esbuild) instead, so this config only covers the UI.
 * Two HTML entries: the main window and the desktop overlay (Phase 12).
 */
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: 'src/renderer/index.html',
        overlay: 'src/renderer/overlay.html',
        region: 'src/renderer/region.html',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
