import { defineConfig } from '@playwright/test';

/**
 * Electron E2E configuration.
 *
 * Deliberately serial: one Electron instance at a time (the app holds a
 * single-instance lock keyed by its userData path, and a 16 GB laptop should
 * not run several Electron/Chromium trees plus a local model in parallel).
 * Traces are kept on failure, screenshots on failure only — both land in
 * test-reports/e2e-artifacts and are uploaded as workflow artifacts, which is
 * what the repair prompt points at.
 *
 * `retries: 0` is intentional: a retry can turn a real, reproducible defect
 * into a green run. A flaky test is a bug in the test, and the loop is supposed
 * to surface it.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-reports/e2e-artifacts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['json', { outputFile: 'test-reports/e2e-results.json' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
});
