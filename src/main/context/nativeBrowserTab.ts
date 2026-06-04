import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// `electron` is resolved lazily (not a top-level import) so this module's graph
// stays Electron-free: the unit-tested capture orchestrator imports it, and bun's
// test runtime cannot load the `electron` shim's named exports.
function appIsPackaged(): boolean {
  try {
    const electron = createRequire(import.meta.url)('electron') as typeof import('electron');
    return Boolean(electron.app?.isPackaged);
  } catch {
    return false;
  }
}

// Loader for the optional macOS `browser_tab` native addon (see
// native/browser-tab/src/browser_tab.mm). It reads the focused browser window's
// URL + title via the Accessibility API, targeting a process by PID — the
// authoritative way to get the tab the user is actually looking at across
// multiple windows/instances (the AppleScript "front window" path cannot).
//
// Everything degrades to a silent no-op: off macOS, addon unbuilt, load failure,
// or Accessibility not granted → the caller falls back to AppleScript. The app
// must never fail because AX capture is unavailable.

/** Focused-tab read result. All fields may be absent; `error` is set on failure. */
export interface FocusedTabResult {
  url?: string;
  title?: string;
  /** Set when the read failed: invalid-pid | ax-not-trusted | ax-app-failed | ax-no-window. */
  error?: string;
}

interface BrowserTabAddon {
  getFocusedTab(pid: number): { url: string | null; title: string | null; error: string | null };
  accessibilityTrusted(): boolean;
  promptAccessibility(): boolean;
}

// undefined = not yet attempted; null = attempted and unavailable.
let cached: BrowserTabAddon | null | undefined;

function candidatePaths(): string[] {
  if (appIsPackaged()) {
    return [join(process.resourcesPath, 'native', 'browser_tab.node')];
  }
  // Dev/build-from-source: __dirname is <repo>/out/main, so the compiled addon
  // sits two levels up under native/browser-tab/build/Release/.
  return [join(__dirname, '../../native/browser-tab/build/Release/browser_tab.node')];
}

function loadAddon(): BrowserTabAddon | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform !== 'darwin') return cached;
  try {
    const found = candidatePaths().find((path) => existsSync(path));
    if (!found) return cached;
    const requireAddon = createRequire(import.meta.url);
    const mod = requireAddon(found) as BrowserTabAddon;
    if (typeof mod?.getFocusedTab === 'function') {
      cached = mod;
    }
  } catch {
    cached = null;
  }
  return cached;
}

/** Whether the Accessibility grant is in place (no prompt). False if the addon is unavailable. */
export function isAccessibilityTrusted(): boolean {
  const addon = loadAddon();
  if (!addon) return false;
  try {
    return addon.accessibilityTrusted();
  } catch {
    return false;
  }
}

/** Trigger the system Accessibility prompt (and add the app to the list). Returns current trust. */
export function promptAccessibility(): boolean {
  const addon = loadAddon();
  if (!addon) return false;
  try {
    return addon.promptAccessibility();
  } catch {
    return false;
  }
}

/**
 * Read the focused browser window's URL + title for a process by PID. Returns
 * null when AX capture is unavailable (off-darwin / addon missing / load fails);
 * returns a result with `error` set when the addon ran but could not read (e.g.
 * Accessibility not granted) — both signal the caller to use the AppleScript path.
 */
export function getFocusedBrowserTab(pid: number): FocusedTabResult | null {
  const addon = loadAddon();
  if (!addon) return null;
  try {
    const raw = addon.getFocusedTab(pid);
    return {
      ...(raw.url ? { url: raw.url } : {}),
      ...(raw.title ? { title: raw.title } : {}),
      ...(raw.error ? { error: raw.error } : {}),
    };
  } catch {
    return null;
  }
}
