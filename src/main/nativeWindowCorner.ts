import { app, type BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Loader for the optional macOS `window_corner` native addon. It sets a custom
// NSWindow corner radius (see native/window-corner/src/window_corner.mm) while
// keeping the standard window (traffic lights + shadow intact).
//
// Everything here degrades to a silent no-op: if the platform is not macOS, if
// the addon was never built, or if loading/calling it throws, the window simply
// keeps the OS-default ~10pt corner. The app must never fail to launch because
// the native corner could not be applied.

interface WindowCornerAddon {
  setWindowCornerRadius(handle: Buffer, radius: number): boolean;
}

// undefined = not yet attempted; null = attempted and unavailable.
let cached: WindowCornerAddon | null | undefined;

function candidatePaths(): string[] {
  if (app.isPackaged) {
    // electron-builder copies the .node into Resources/native/ (see the
    // `extraResources` entry in package.json's build config).
    return [join(process.resourcesPath, 'native', 'window_corner.node')];
  }
  // Dev/build-from-source: __dirname is <repo>/out/main, so the compiled addon
  // sits two levels up under native/window-corner/build/Release/.
  return [join(__dirname, '../../native/window-corner/build/Release/window_corner.node')];
}

function loadAddon(): WindowCornerAddon | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform !== 'darwin') return cached;
  try {
    const found = candidatePaths().find((path) => existsSync(path));
    if (!found) return cached;
    const requireAddon = createRequire(import.meta.url);
    const mod = requireAddon(found) as WindowCornerAddon;
    if (typeof mod?.setWindowCornerRadius === 'function') {
      cached = mod;
    }
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Apply a custom corner radius to a macOS window. Returns true if the native
 * addon ran successfully; false (silently) on any other platform or failure.
 */
export function applyMacWindowCorner(window: BrowserWindow, radius: number): boolean {
  const addon = loadAddon();
  if (!addon) return false;
  try {
    return addon.setWindowCornerRadius(window.getNativeWindowHandle(), radius);
  } catch {
    return false;
  }
}
