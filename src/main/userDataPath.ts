import { join } from 'node:path';

/**
 * Dev-run fallback directory name (under `$HOME`) used when running from source
 * with no explicit override. Intentionally kept as the legacy `.lin-outliner-*`
 * compatibility name (see AGENTS.md "Dev environment"); renaming it would touch
 * every clone's `dev:*` script and is a separate change.
 */
export const DEV_USER_DATA_DIR_NAME = '.lin-outliner-dev';

export interface UserDataPathInputs {
  /** `ELECTRON_USER_DATA_DIR` if set — verbatim, highest priority. */
  envOverride: string | undefined;
  /** `app.isPackaged`. */
  isPackaged: boolean;
  /** `app.getPath('home')` — app-name-independent. */
  home: string;
  /** `app.getPath('appData')` — the OS Application Support dir; app-name-independent. */
  appData: string;
  /** The pinned product name (`APP_NAME` = "Tenon"). */
  appName: string;
}

/**
 * Resolve this process's userData directory EXPLICITLY — never derived from
 * `app.getName()`.
 *
 * Electron's default userData path is `<appData>/<app.getName()>`, and a packaged
 * build resolves `getName()` from the bundled package.json `name`
 * ("lin-outliner"), NOT from electron-builder's `build.productName` ("Tenon",
 * which only names the `.app` bundle). Relying on that derivation let a rebuild
 * silently change the data directory from `…/Tenon` to `…/lin-outliner`, so the
 * app appeared to "lose" data by reading a different folder. We pin the packaged
 * directory to `<appData>/<appName>` so it can never drift, regardless of how the
 * asar package.json is generated.
 *
 * Priority:
 *   1. `envOverride` (verbatim) — per-clone dev isolation / explicit override.
 *   2. From source (`!isPackaged`) → `<home>/.lin-outliner-dev`, so a bare
 *      `bun run dev` can never touch the installed prod app's data.
 *   3. Packaged → `<appData>/<appName>` (e.g. `…/Application Support/Tenon`).
 */
export function resolveUserDataDir(inputs: UserDataPathInputs): string {
  const { envOverride, isPackaged, home, appData, appName } = inputs;
  if (envOverride) return envOverride;
  if (!isPackaged) return join(home, DEV_USER_DATA_DIR_NAME);
  return join(appData, appName);
}
