import { globalShortcut } from 'electron';

// Global hotkey that toggles the launcher even when the app is unfocused. Must
// be registered after app.whenReady(); registration silently fails if another
// app already owns the accelerator, so we try the default then a fallback and
// report which one won. Override with LIN_LAUNCHER_HOTKEY for dev.
// Docs: docs/plans/lazy-like-global-launcher.md.

const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space';
const FALLBACK_HOTKEY = 'Control+Alt+Space';

export interface HotkeyRegistration {
  accelerator: string | null;
  attempted: string[];
}

/**
 * Register the launcher toggle hotkey. Returns the accelerator that won (or null
 * if every candidate was taken) plus what was tried, so the caller can log it
 * and a later phase can surface remediation UI.
 */
export function registerLauncherHotkey(toggle: () => void): HotkeyRegistration {
  const candidates = [
    process.env.LIN_LAUNCHER_HOTKEY,
    DEFAULT_HOTKEY,
    FALLBACK_HOTKEY,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  const attempted: string[] = [];
  for (const accelerator of candidates) {
    attempted.push(accelerator);
    if (globalShortcut.isRegistered(accelerator)) continue;
    const ok = globalShortcut.register(accelerator, toggle);
    if (ok) return { accelerator, attempted };
  }
  return { accelerator: null, attempted };
}

export function unregisterLauncherHotkeys(): void {
  globalShortcut.unregisterAll();
}
