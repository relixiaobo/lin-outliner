// Settings live in their own OS window (a native "Preferences" surface) rather
// than an in-app modal. The settings window reuses the single renderer bundle and
// is told which surface to render through a URL query param, so no extra build
// entry is needed. These constants are shared by the main process (which opens
// the window and broadcasts changes) and the renderer (which routes on the
// surface and listens for change broadcasts).

export const WINDOW_SURFACE_QUERY_PARAM = 'surface';
export type WindowSurface = 'main' | 'settings' | 'provider-config';

export function windowSurfaceFromSearch(search: string): WindowSurface {
  const surface = new URLSearchParams(search).get(WINDOW_SURFACE_QUERY_PARAM);
  if (surface === 'settings') return 'settings';
  if (surface === 'provider-config') return 'provider-config';
  return 'main';
}

// The per-provider config opens as its OWN native window (a modal child of the
// settings window, the System Settings idiom — not an in-renderer overlay). Which
// provider / mode it edits rides the URL query, like the surface itself, so no
// extra IPC channel is needed to hand it its context.
export const PROVIDER_CONFIG_PROVIDER_PARAM = 'provider';
export const PROVIDER_CONFIG_MODE_PARAM = 'mode';
export type ProviderConfigMode = 'configure' | 'custom';

export interface ProviderConfigParams {
  providerId: string;
  mode: ProviderConfigMode;
}

export function providerConfigParamsFromSearch(search: string): ProviderConfigParams {
  const params = new URLSearchParams(search);
  return {
    providerId: params.get(PROVIDER_CONFIG_PROVIDER_PARAM) ?? '',
    mode: params.get(PROVIDER_CONFIG_MODE_PARAM) === 'custom' ? 'custom' : 'configure',
  };
}

// Broadcast from the main process to the main window after the settings window
// mutates provider/agent settings, so the main window re-fetches instead of
// showing stale provider state.
export const LIN_SETTINGS_CHANGED_CHANNEL = 'lin:settings-changed';
