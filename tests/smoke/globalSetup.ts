import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAIN_ENTRY, REPO_ROOT } from './electronApp';

// The smoke suite launches the *built* main process, so the bundle must exist
// AND reflect the current source. `bun run test:smoke` runs `electron-vite build`
// first; this guard makes a direct `playwright test --config=…` run fail fast,
// with an actionable message, when the build is missing or stale — rather than
// silently smoking an out-of-date bundle.
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtimeMs(path) : statSync(path).mtimeMs);
  }
  return newest;
}

export default function globalSetup(): void {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(
      `Smoke suite needs a built main process at ${MAIN_ENTRY}.\n` +
        'Run `bun run test:smoke` (builds first) or `electron-vite build` before `playwright test --config=playwright.smoke.config.ts`.',
    );
  }
  // `src/` is the product source; test edits live under `tests/` and correctly
  // never mark the build stale (they don't change the bundle).
  const builtMs = statSync(MAIN_ENTRY).mtimeMs;
  const sourceMs = newestMtimeMs(join(REPO_ROOT, 'src'));
  if (sourceMs > builtMs) {
    throw new Error(
      'Smoke build is stale (a source file under src/ is newer than out/main/main.js).\n' +
        'Run `bun run test:smoke` (rebuilds) or `electron-vite build` to refresh the bundle.',
    );
  }
}
