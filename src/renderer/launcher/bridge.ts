import type { LauncherPreloadApi } from '../../preload/launcher';

// `window.lin` is whichever preload loaded THIS document. There is only ONE
// preload bundle (a second rollup entry emits a shared chunk a sandboxed
// preload cannot `require`), so it branches on a role flag and the launcher
// window gets the minimal API from `src/preload/launcher.ts`, not the app
// bridge. The global declaration names the app shape because that is what every
// other renderer sees, so the launcher subtree narrows once, here, instead of
// casting at each call site.
//
// This is a type-level statement only. It grants nothing: the launcher's
// capabilities are what main registered for its `webContents`, and a method
// that is not in its preload simply does not exist at runtime.
export function launcherBridge(): LauncherPreloadApi | undefined {
  return window.lin as unknown as LauncherPreloadApi | undefined;
}
