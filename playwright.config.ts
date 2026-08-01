import { defineConfig, devices } from '@playwright/test';

const port = process.env.PLAYWRIGHT_PORT ?? '5174';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL,
    // Not `on-first-retry`: `retries` is unset (Playwright defaults to 0), so that
    // value produced a trace exactly never — which is why every e2e investigation
    // here has been re-run-and-squint instead of opening a trace. Retries stay at 0
    // deliberately; turning them on would convert a visible instability into an
    // invisible one.
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `bun run renderer:dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
