import { defineConfig } from 'vitest/config';

/**
 * Unit/integration tests run the real core services (main-process logic) in a
 * plain Node environment: no Electron required. Windows-specific adapters
 * (overlay, screen capture) are exercised only through their interfaces.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
