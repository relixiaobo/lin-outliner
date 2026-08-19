import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASONING_EFFORTS, type ReasoningEffort } from '../core/agent/configuration';
import type { ThreadConfigurationSummary } from '../core/agent/protocol';
import { isThemeMode, type ThemeMode } from '../core/theme';
import { isLocale, type Locale } from '../core/locale';
import { isTranslationLanguage, type TranslationLanguage } from '../core/translationLanguage';
import {
  isUrlPageTranslationModel,
  type UrlPageTranslationPreferences,
} from '../core/urlPageTranslation';
import { writeJsonFileSync } from './jsonFileStore';

// Persist app-level UI preferences across launches (stored in userData, which is
// already per-clone isolated). Kept separate from window-state.ts (geometry) and
// the agent settings store (provider/runtime configuration and credentials).

interface PersistedAppPreferences {
  theme: ThemeMode;
  // null = no explicit pick yet → the main process falls back to the OS locale
  // (resolveSystemLocale) on first run; a concrete value pins the language.
  language: Locale | null;
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

const DEFAULTS: PersistedAppPreferences = {
  theme: 'system',
  language: null,
  translationLanguage: null,
  translationModel: null,
  autoTranslateUrls: false,
  autoTranslateEpubs: false,
  lastAgentThreadConfiguration: null,
};

let currentPreferences: PersistedAppPreferences | null = null;

function preferencesFilePath(): string {
  return join(app.getPath('userData'), 'app-preferences.json');
}

export function loadAppPreferences(): PersistedAppPreferences {
  if (currentPreferences) return { ...currentPreferences };
  let loaded: PersistedAppPreferences;
  try {
    const parsed = JSON.parse(readFileSync(preferencesFilePath(), 'utf8')) as Partial<PersistedAppPreferences>;
    loaded = {
      theme: isThemeMode(parsed.theme) ? parsed.theme : DEFAULTS.theme,
      language: isLocale(parsed.language) ? parsed.language : DEFAULTS.language,
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
  return { ...loaded };
}

export function saveThemePreference(theme: ThemeMode): void {
  savePreferences({ theme });
}

export function saveLanguagePreference(language: Locale): void {
  savePreferences({ language });
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
  savePreferences({
    lastAgentThreadConfiguration: Object.freeze({ ...configuration }),
  });
}

export function resetAppPreferencesForTests(): void {
  currentPreferences = null;
}

// Read-modify-write a subset of preferences, preserving the rest. Best effort —
// failing to persist a UI preference is not worth surfacing an error; the in-memory
// state (nativeTheme.themeSource / the broadcast locale) still applies this session.
function savePreferences(patch: Partial<PersistedAppPreferences>): void {
  const next: PersistedAppPreferences = { ...(currentPreferences ?? loadAppPreferences()), ...patch };
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isCanonicalSelectionString(record.modelProvider)) return null;
  if (!isCanonicalSelectionString(record.model)) return null;
  if (!REASONING_EFFORTS.includes(record.reasoningEffort as ReasoningEffort)) return null;
  return Object.freeze({
    modelProvider: record.modelProvider,
    model: record.model,
    reasoningEffort: record.reasoningEffort as ReasoningEffort,
  });
}

function isCanonicalSelectionString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}
