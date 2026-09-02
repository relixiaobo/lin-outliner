// Settings live in their own OS window (a native "Preferences" surface) rather
// than an in-app modal. The settings window reuses the single renderer bundle and
// is told which surface to render through a URL query param, so no extra build
// entry is needed. These constants are shared by the main process (which opens
// the window and broadcasts changes) and the renderer (which routes on the
// surface and listens for change broadcasts).

import { isAgentTypeIdentifier } from './agent/configuration';

export const WINDOW_SURFACE_QUERY_PARAM = 'surface';
export type WindowSurface = 'main' | 'settings' | 'provider-config';

/**
 * The three rail categories, cut along what a user is trying to affect rather
 * than which subsystem implements it.
 */
export type SettingsCategoryTarget = 'general' | 'agent' | 'preview';

/**
 * Second-level pages. A collection the user installs or connects — unbounded and
 * carrying its own lifecycle — gets a page; a bounded set of settings stays
 * inline on its category. About is a page for the same reason: it is content, not
 * controls.
 */
export type SettingsPageTarget = 'services' | 'skills' | 'agents' | 'about';

export interface SettingsOpenTarget {
  category?: SettingsCategoryTarget;
  page?: SettingsPageTarget;
  /** Agent type whose editor should open when the Agents page is targeted. */
  agentType?: string;
  /**
   * A group to scroll to and briefly highlight. Landing at the top of a long
   * category is a downgrade for a contextual "open settings" affordance, which is
   * what a deep link owes the user in place of the aliases this replaced.
   */
  anchor?: string;
}

export const SETTINGS_CATEGORY_PARAM = 'category';
export const SETTINGS_ANCHOR_PARAM = 'anchor';
export const SETTINGS_AGENT_TYPE_PARAM = 'agent';
export const LIN_SETTINGS_NAVIGATE_CHANNEL = 'lin:settings-navigate';
const SETTINGS_ANCHOR_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Which category owns each page, so a page target routes without being told twice. */
const PAGE_CATEGORY: Record<SettingsPageTarget, SettingsCategoryTarget> = {
  services: 'agent',
  skills: 'agent',
  agents: 'agent',
  about: 'general',
};

export function windowSurfaceFromSearch(search: string): WindowSurface {
  const surface = new URLSearchParams(search).get(WINDOW_SURFACE_QUERY_PARAM);
  if (surface === 'settings') return 'settings';
  if (surface === 'provider-config') return 'provider-config';
  return 'main';
}

export function isSettingsCategoryTarget(value: unknown): value is SettingsCategoryTarget {
  return value === 'general' || value === 'agent' || value === 'preview';
}

export function isSettingsPageTarget(value: unknown): value is SettingsPageTarget {
  return value === 'services' || value === 'skills' || value === 'agents' || value === 'about';
}

export function isSettingsAnchorTarget(value: unknown): value is string {
  return typeof value === 'string' && SETTINGS_ANCHOR_PATTERN.test(value);
}

export function isSettingsAgentTypeTarget(value: unknown): value is string {
  return isAgentTypeIdentifier(value);
}

export function settingsPageCategory(page: SettingsPageTarget): SettingsCategoryTarget {
  return PAGE_CATEGORY[page];
}

/**
 * Parse `category=agent`, or a page in path form: `category=agent/skills`.
 *
 * The retired ids (`providers`, `security`, `skills` as a category) are not
 * aliased. Only one in-app caller ever passed a category and there are no
 * persisted or external deep links, so an alias would be permanent weight for a
 * migration nobody needs — the same call `permissions` got when it was replaced
 * rather than aliased.
 */
export function settingsOpenTargetFromSearch(search: string): SettingsOpenTarget {
  const params = new URLSearchParams(search);
  const raw = params.get(SETTINGS_CATEGORY_PARAM) ?? '';
  const anchor = params.get(SETTINGS_ANCHOR_PARAM);
  const agentType = params.get(SETTINGS_AGENT_TYPE_PARAM);
  const [head, tail] = raw.split('/');
  const target: SettingsOpenTarget = {};

  if (tail !== undefined) {
    // A pair that disagrees with itself — `general/skills` — is a malformed link,
    // not a hint. Honouring the category half would land the user on a pane they
    // did not ask for and looks like it worked; routing nowhere leaves them on the
    // default pane and is at least legible as "that link is wrong".
    if (isSettingsPageTarget(tail) && settingsPageCategory(tail) === head) {
      target.category = head as SettingsCategoryTarget;
      target.page = tail;
    }
  } else if (isSettingsCategoryTarget(head)) {
    target.category = head;
  }
  if ((target.category || target.page) && isSettingsAnchorTarget(anchor)) target.anchor = anchor;
  if (target.page === 'agents' && isSettingsAgentTypeTarget(agentType)) target.agentType = agentType;
  return target;
}

/** The inverse, for building a link: `agent` or `agent/skills`. */
export function settingsTargetPath(target: SettingsOpenTarget): string {
  if (target.page) return `${settingsPageCategory(target.page)}/${target.page}`;
  return target.category ?? '';
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
// mutates provider settings, so the main window re-fetches instead of
// showing stale provider state.
export const LIN_SETTINGS_CHANGED_CHANNEL = 'lin:settings-changed';
