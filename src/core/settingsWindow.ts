// Settings live in their own OS window (a native "Preferences" surface) rather
// than an in-app modal. The settings window reuses the single renderer bundle and
// is told which surface to render through a URL query param, so no extra build
// entry is needed. These constants are shared by the main process (which opens
// the window and broadcasts changes) and the renderer (which routes on the
// surface and listens for change broadcasts).

export const WINDOW_SURFACE_QUERY_PARAM = 'surface';
export type WindowSurface = 'main' | 'settings';

export function windowSurfaceFromSearch(search: string): WindowSurface {
  return new URLSearchParams(search).get(WINDOW_SURFACE_QUERY_PARAM) === 'settings'
    ? 'settings'
    : 'main';
}

// Broadcast from the main process to the main window after the settings window
// mutates provider/agent settings, so the main window re-fetches instead of
// showing stale provider state.
export const LIN_SETTINGS_CHANGED_CHANNEL = 'lin:settings-changed';
