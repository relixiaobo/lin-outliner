/** Direct native-window destinations. Collections never become Settings pages. */
export const CONFIGURATION_DESTINATIONS = [
  'settings', 'models', 'agents', 'skills', 'memory', 'access', 'data', 'shortcuts', 'about', 'diagnostics',
] as const;
export type ConfigurationDestination = typeof CONFIGURATION_DESTINATIONS[number];
export type ConfigurationDomain = 'preferences' | 'models' | 'agents' | 'skills' | 'access';
export const CONFIGURATION_CHANGED_CHANNEL = 'lin:configuration-changed';
export const WINDOW_SURFACE_QUERY_PARAM = 'surface';
export type WindowSurface = 'main' | 'settings' | 'manager' | 'provider-config' | 'skill-review';
export const CONFIGURATION_DESTINATION_PARAM = 'destination';
export const SETTINGS_SETTING_PARAM = 'setting';
export const LIN_SETTINGS_NAVIGATE_CHANNEL = 'lin:settings-navigate';

export interface SettingsOpenTarget {
  destination?: ConfigurationDestination;
  settingId?: string;
}

export function isConfigurationDestination(value: unknown): value is ConfigurationDestination {
  return typeof value === 'string' && (CONFIGURATION_DESTINATIONS as readonly string[]).includes(value);
}

export function sanitizeSettingsOpenTarget(raw: unknown): SettingsOpenTarget {
  if (!raw || typeof raw !== 'object') return {};
  const input = raw as Record<string, unknown>;
  return {
    ...(isConfigurationDestination(input.destination) ? { destination: input.destination } : {}),
    ...(typeof input.settingId === 'string' && /^[a-zA-Z][\w.-]{0,127}$/.test(input.settingId)
      ? { settingId: input.settingId } : {}),
  };
}

export function windowSurfaceFromSearch(search: string): WindowSurface {
  const surface = new URLSearchParams(search).get(WINDOW_SURFACE_QUERY_PARAM);
  return surface === 'settings' || surface === 'manager' || surface === 'provider-config' || surface === 'skill-review'
    ? surface : 'main';
}

export function settingsOpenTargetFromSearch(search: string): SettingsOpenTarget {
  const params = new URLSearchParams(search);
  return sanitizeSettingsOpenTarget({
    destination: params.get(CONFIGURATION_DESTINATION_PARAM), settingId: params.get(SETTINGS_SETTING_PARAM),
  });
}

export function settingsWindowQuery(target: SettingsOpenTarget = {}): Record<string, string> {
  const destination = target.destination ?? 'settings';
  return {
    [WINDOW_SURFACE_QUERY_PARAM]: destination === 'settings' ? 'settings' : 'manager',
    [CONFIGURATION_DESTINATION_PARAM]: destination,
    ...(target.settingId ? { [SETTINGS_SETTING_PARAM]: target.settingId } : {}),
  };
}

/** Credential editing is a modal child of Models, with its own admission. */
export const PROVIDER_CONFIG_PROVIDER_PARAM = 'provider';
export const PROVIDER_CONFIG_MODE_PARAM = 'mode';
export type ProviderConfigMode = 'configure' | 'custom';
export interface ProviderConfigParams { providerId: string; mode: ProviderConfigMode }
export function providerConfigParamsFromSearch(search: string): ProviderConfigParams {
  const params = new URLSearchParams(search);
  return {
    providerId: params.get(PROVIDER_CONFIG_PROVIDER_PARAM) ?? '',
    mode: params.get(PROVIDER_CONFIG_MODE_PARAM) === 'custom' ? 'custom' : 'configure',
  };
}
