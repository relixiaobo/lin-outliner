import { type BrowserWindow } from 'electron';
import { loadOptionalMacAddon } from './nativeAddon';

// Loader for the optional macOS `window_corner` native addon. It sets a custom
// NSWindow corner radius (see native/window-corner/src/window_corner.mm) while
// keeping the standard window (traffic lights + shadow intact).
//
// Everything here degrades to a silent no-op: if the platform is not macOS, if
// the addon was never built, or if loading/calling it throws, the window simply
// keeps the OS-default corner (16pt on macOS 26). The app must never fail to
// launch because the native corner could not be applied.

interface WindowCornerAddon {
  setWindowCornerRadius(handle: Buffer, radius: number): boolean;
}

// undefined = not yet attempted; null = attempted and unavailable.
let cached: WindowCornerAddon | null | undefined;

function loadAddon(): WindowCornerAddon | null {
  if (cached !== undefined) return cached;
  cached = loadOptionalMacAddon<WindowCornerAddon>({
    fileName: 'window_corner.node',
    devSubdir: 'window-corner',
    validate: (mod): mod is WindowCornerAddon =>
      typeof (mod as WindowCornerAddon)?.setWindowCornerRadius === 'function',
  });
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
