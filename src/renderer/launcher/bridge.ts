import type { LauncherPreloadApi } from '../../preload/launcher';

// `window.lin` is whichever preload loaded THIS document, and the launcher
// window loads its own minimal bundle (`src/preload/launcher.ts`) rather than
// the app bridge. The global declaration names the app shape because that is
// what every other renderer sees, so the launcher subtree narrows once, here,
// instead of casting at each call site.
//
// This is a type-level statement only. It grants nothing: the launcher's
// capabilities are what main registered for its `webContents`, and a method
// that is not in its preload simply does not exist at runtime.
export function launcherBridge(): LauncherPreloadApi | undefined {
  return window.lin as unknown as LauncherPreloadApi | undefined;
}
