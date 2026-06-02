import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Real-Electron smoke harness. Unlike the renderer e2e suite (which runs the
// React bundle in plain Chromium against the Vite dev server), these tests
// launch the *built* main process from `out/main/main.js` so they exercise the
// native host: the security shell, the application menu, window startup, and the
// packaged `file://` renderer with its enforced CSP.
//
// Each launch gets a throwaway `ELECTRON_USER_DATA_DIR`, so a smoke run can
// never read or clobber a real clone's documents — and so the userData
// isolation contract itself becomes testable (see userdata-isolation.smoke.ts).

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MAIN_ENTRY = join(REPO_ROOT, 'out', 'main', 'main.js');

export interface SmokeApp {
  app: ElectronApplication;
  /** The main BrowserWindow's renderer page, already attached. */
  window: Page;
  /** The throwaway userData directory this instance was launched against. */
  userDataDir: string;
}

export interface LaunchOptions {
  /** Extra environment overlaid on the launch env (after dev-URL stripping). */
  env?: Record<string, string>;
  /** Provide a userData dir instead of minting a fresh temp one. */
  userDataDir?: string;
}

// Strip any dev-server pointers from the inherited environment so the launched
// app loads the packaged renderer from `file://` (prod-like) rather than the
// Vite origin. Without this, a developer running the smoke suite from a shell
// that exported ELECTRON_RENDERER_URL would silently test the dev surface — and
// the CSP smoke would be meaningless (CSP is only injected on file://).
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'ELECTRON_RENDERER_URL' || key === 'VITE_DEV_SERVER_URL') continue;
    if (key === 'ELECTRON_USER_DATA_DIR') continue;
    env[key] = value;
  }
  return env;
}

export async function launchSmokeApp(options: LaunchOptions = {}): Promise<SmokeApp> {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'lin-smoke-'));
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    cwd: REPO_ROOT,
    env: {
      ...baseEnv(),
      ELECTRON_USER_DATA_DIR: userDataDir,
      ...options.env,
    },
  });
  const window = await app.firstWindow();
  return { app, window, userDataDir };
}

export async function closeSmokeApp(smoke: SmokeApp, { keepUserData = false } = {}): Promise<void> {
  await smoke.app.close();
  if (!keepUserData) {
    rmSync(smoke.userDataDir, { recursive: true, force: true });
  }
}
