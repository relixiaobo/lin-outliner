import { existsSync } from 'node:fs';
import { MAIN_ENTRY } from './electronApp';

// The smoke suite launches the *built* main process, so the bundle must exist
// and be current. `bun run test:smoke` runs `electron-vite build` first; this
// guard catches a stale/missing build when the suite is invoked directly (e.g.
// `playwright test --config=playwright.smoke.config.ts`) and fails with an
// actionable message instead of an opaque Electron launch error.
export default function globalSetup(): void {
  if (existsSync(MAIN_ENTRY)) return;
  throw new Error(
    `Smoke suite needs a built main process at ${MAIN_ENTRY}.\n` +
      'Run `bun run test:smoke` (builds first) or `electron-vite build` before `playwright test --config=playwright.smoke.config.ts`.',
  );
}
