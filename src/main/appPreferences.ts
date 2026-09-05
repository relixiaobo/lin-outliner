import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeThreadConfigurationSummary } from '../core/agent/codec';
import type { ThreadConfigurationSummary } from '../core/agent/protocol';
import type { ThemeMode } from '../core/theme';
import { isLocale, type Locale } from '../core/locale';
import { isTranslationLanguage, type TranslationLanguage } from '../core/translationLanguage';
import {
  isUrlPageTranslationModel,
  type UrlPageTranslationPreferences,
} from '../core/urlPageTranslation';
import { loadFilePreferences, updateFilePreferences } from './configuration/filePreferences';
import { writeJsonFileSync } from './jsonFileStore';

// Persist app-level UI preferences across launches (stored in userData, which is
// already per-clone isolated). Kept separate from window-state.ts (geometry) and
// the agent settings store (provider/runtime configuration and credentials).

interface PersistedAppPreferences {
  // null follows the effective UI language until the user explicitly chooses a
  // webpage translation target.
  translationLanguage: TranslationLanguage | null;
  // null dynamically follows the model selected by the built-in Agent.
  translationModel: string | null;
  // Automatic URL translation is an explicit global opt-in.
  autoTranslateUrls: boolean;
  // Local EPUB text has an independent explicit provider-sharing opt-in.
  autoTranslateEpubs: boolean;
  // The last root Thread selection the user saved in the Agent composer.
  lastAgentThreadConfiguration: ThreadConfigurationSummary | null;
}

export interface AppPreferences extends PersistedAppPreferences {
  readonly theme: ThemeMode;
  readonly language: Locale | null;
}

const DEFAULTS: PersistedAppPreferences = {
  translationLanguage: null,
  translationModel: null,
  autoTranslateUrls: false,
  autoTranslateEpubs: false,
  lastAgentThreadConfiguration: null,
};

let currentPreferences: PersistedAppPreferences | null = null;
const MAX_AGENT_THREAD_SELECTION_CHARS = 512;

function preferencesFilePath(): string {
  return join(app.getPath('userData'), 'app-preferences.json');
}

export function loadAppPreferences(): AppPreferences {
  if (currentPreferences) {
    const file = loadFilePreferences(app.getPath('userData')).preferences;
    return {
      ...currentPreferences,
      theme: file.appearance.theme,
      language: isLocale(file.appearance.language) ? file.appearance.language : null,
    };
  }
  let loaded: PersistedAppPreferences;
  try {
    const parsed = JSON.parse(readFileSync(preferencesFilePath(), 'utf8')) as Partial<PersistedAppPreferences>;
    loaded = {
      translationLanguage: isTranslationLanguage(parsed.translationLanguage)
        ? parsed.translationLanguage
        : DEFAULTS.translationLanguage,
      translationModel: normalizeTranslationModel(parsed.translationModel),
      autoTranslateUrls: parsed.autoTranslateUrls === true,
      autoTranslateEpubs: parsed.autoTranslateEpubs === true,
      lastAgentThreadConfiguration: normalizeAgentThreadConfiguration(
        parsed.lastAgentThreadConfiguration,
      ),
    };
  } catch {
    // No prior preferences, or the file is unreadable/invalid — fall back to defaults.
    loaded = { ...DEFAULTS };
  }
  currentPreferences = loaded;
  const file = loadFilePreferences(app.getPath('userData')).preferences;
  return { ...loaded, theme: file.appearance.theme, language: isLocale(file.appearance.language) ? file.appearance.language : null };
}

export function saveThemePreference(theme: ThemeMode): void {
  updateFilePreferences(app.getPath('userData'), [{ path: ['appearance', 'theme'], value: theme }]);
}

export function saveLanguagePreference(language: Locale): void {
  updateFilePreferences(app.getPath('userData'), [{ path: ['appearance', 'language'], value: language }]);
}

export function saveAutomaticChecksPreference(enabled: boolean): void {
  updateFilePreferences(app.getPath('userData'), [{ path: ['updates', 'checkAutomatically'], value: enabled }]);
}

export function saveTranslationLanguagePreference(translationLanguage: TranslationLanguage): void {
  savePreferences({ translationLanguage });
}

export function saveUrlPageTranslationPreferences(preferences: UrlPageTranslationPreferences): void {
  savePreferences(preferences);
}

export function saveLastAgentThreadConfiguration(
  configuration: ThreadConfigurationSummary,
): void {
  const decoded = decodePersistedAgentThreadConfiguration(configuration);
  savePreferences({
    lastAgentThreadConfiguration: decoded,
  });
}

export function clearLastAgentThreadConfiguration(): void {
  savePreferences({ lastAgentThreadConfiguration: null });
}

export function resetAppPreferencesForTests(): void {
  currentPreferences = null;
}

// Read-modify-write a subset of preferences, preserving the rest. Best effort —
// failing to persist a UI preference is not worth surfacing an error; the in-memory
// state (nativeTheme.themeSource / the broadcast locale) still applies this session.
function savePreferences(patch: Partial<PersistedAppPreferences>): void {
  const current = currentPreferences ?? loadAppPreferences();
  const persisted: PersistedAppPreferences = {
    translationLanguage: current.translationLanguage,
    translationModel: current.translationModel,
    autoTranslateUrls: current.autoTranslateUrls,
    autoTranslateEpubs: current.autoTranslateEpubs,
    lastAgentThreadConfiguration: current.lastAgentThreadConfiguration,
  };
  const next: PersistedAppPreferences = { ...persisted, ...patch };
  currentPreferences = next;
  try {
    writeJsonFileSync(preferencesFilePath(), next, { pretty: false, trailingNewline: false });
  } catch {
    // ignore — see note above
  }
}

function normalizeTranslationModel(value: unknown): string | null {
  return isUrlPageTranslationModel(value) ? value : null;
}

function normalizeAgentThreadConfiguration(value: unknown): ThreadConfigurationSummary | null {
  try {
    return decodePersistedAgentThreadConfiguration(value);
  } catch {
    return null;
  }
}

function decodePersistedAgentThreadConfiguration(value: unknown): ThreadConfigurationSummary {
  const decoded = decodeThreadConfigurationSummary(
    value,
    'app-preferences.lastAgentThreadConfiguration',
  );
  if (
    decoded.modelProvider.length > MAX_AGENT_THREAD_SELECTION_CHARS
    || decoded.model.length > MAX_AGENT_THREAD_SELECTION_CHARS
  ) {
    throw new Error('Agent Thread selection exceeds the persisted preference limit');
  }
  return decoded;
}
