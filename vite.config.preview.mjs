/**
 * TEMPORARY sandbox-preview wrapper for `vite --config` (untracked, preview-only):
 * identical to vite.config.ts plus server.allowedHosts for the e2b live-preview
 * proxy host. Delete freely; nothing in the repo depends on it.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: ['.e2b.app'],
  },
});
