// Settings live in their own OS window (a native "Preferences" surface) rather
// than an in-app modal. The settings window reuses the single renderer bundle and
// is told which surface to render through a URL query param, so no extra build
// entry is needed. These constants are shared by the main process (which opens
// the window and broadcasts changes) and the renderer (which routes on the
// surface and listens for change broadcasts).

export const WINDOW_SURFACE_QUERY_PARAM = 'surface';
export type WindowSurface = 'main' | 'settings' | 'provider-config' | 'agent-config' | 'channel-config';
export type SettingsCategoryTarget = 'general' | 'providers' | 'permissions' | 'memory' | 'skills' | 'agents';

export interface SettingsOpenTarget {
  category?: SettingsCategoryTarget;
  agentId?: string;
  agentCreate?: boolean;
}

export const SETTINGS_CATEGORY_PARAM = 'category';
export const SETTINGS_AGENT_PARAM = 'agent';
export const SETTINGS_AGENT_CREATE_VALUE = 'create';
export const LIN_SETTINGS_NAVIGATE_CHANNEL = 'lin:settings-navigate';

export function windowSurfaceFromSearch(search: string): WindowSurface {
  const surface = new URLSearchParams(search).get(WINDOW_SURFACE_QUERY_PARAM);
  if (surface === 'settings') return 'settings';
  if (surface === 'provider-config') return 'provider-config';
  if (surface === 'agent-config') return 'agent-config';
  if (surface === 'channel-config') return 'channel-config';
  return 'main';
}

export function isSettingsCategoryTarget(value: unknown): value is SettingsCategoryTarget {
  return value === 'general'
    || value === 'providers'
    || value === 'permissions'
    || value === 'memory'
    || value === 'skills'
    || value === 'agents';
}

export function settingsOpenTargetFromSearch(search: string): SettingsOpenTarget {
  const params = new URLSearchParams(search);
  const category = params.get(SETTINGS_CATEGORY_PARAM);
  const agentParam = params.get(SETTINGS_AGENT_PARAM)?.trim();
  return {
    ...(isSettingsCategoryTarget(category) ? { category } : {}),
    ...(agentParam === SETTINGS_AGENT_CREATE_VALUE ? { agentCreate: true } : {}),
    ...(agentParam && agentParam !== SETTINGS_AGENT_CREATE_VALUE ? { agentId: agentParam } : {}),
  };
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

export const AGENT_CONFIG_AGENT_PARAM = 'agent';
export const AGENT_CONFIG_MODE_PARAM = 'mode';
export type AgentConfigMode = 'create' | 'configure';

export interface AgentConfigParams {
  agentId: string;
  mode: AgentConfigMode;
}

export function agentConfigParamsFromSearch(search: string): AgentConfigParams {
  const params = new URLSearchParams(search);
  return {
    agentId: params.get(AGENT_CONFIG_AGENT_PARAM) ?? '',
    mode: params.get(AGENT_CONFIG_MODE_PARAM) === 'create' ? 'create' : 'configure',
  };
}

export const CHANNEL_CONFIG_CONVERSATION_PARAM = 'conversation';
export const CHANNEL_CONFIG_MODE_PARAM = 'mode';
export type ChannelConfigMode = 'create' | 'configure';

export interface ChannelConfigParams {
  conversationId: string;
  mode: ChannelConfigMode;
}

export function channelConfigParamsFromSearch(search: string): ChannelConfigParams {
  const params = new URLSearchParams(search);
  return {
    conversationId: params.get(CHANNEL_CONFIG_CONVERSATION_PARAM) ?? '',
    mode: params.get(CHANNEL_CONFIG_MODE_PARAM) === 'create' ? 'create' : 'configure',
  };
}

// Broadcast from the main process to the main window after the settings window
// mutates provider/agent settings, so the main window re-fetches instead of
// showing stale provider state.
export const LIN_SETTINGS_CHANGED_CHANNEL = 'lin:settings-changed';
