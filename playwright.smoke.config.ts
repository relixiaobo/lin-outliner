import { defineConfig } from '@playwright/test';

// Real-Electron smoke suite (native-feel remediation, stage 6). Separate from
// playwright.config.ts: that config drives the renderer bundle in Chromium
// against the Vite dev server; this one launches the built main process from
// `out/main/main.js` and exercises the native host (security shell, application
// menu, window startup, packaged-renderer CSP, userData isolation).
//
// No webServer and no browser `projects`: every test owns its own Electron
// instance via tests/smoke/electronApp.ts. Serial (workers: 1) because each test
// spins up a real GUI process; the suite is small and launch dominates, so
// parallelism buys little and only invites window/focus contention.
export default defineConfig({
  testDir: './tests/smoke',
  testMatch: '**/*.smoke.ts',
  globalSetup: './tests/smoke/globalSetup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'line' : 'list',
});
