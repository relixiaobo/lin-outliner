import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isThemeMode, type ThemeMode } from '../core/theme';
import { isLocale, type Locale } from '../core/locale';
import { isTranslationLanguage, type TranslationLanguage } from '../core/translationLanguage';
import { writeJsonFileSync } from './jsonFileStore';

// Persist app-level UI preferences across launches (stored in userData, which is
// already per-clone isolated). The appearance/theme preference and the display
// language; new General-pane settings extend this shape. Kept separate from
// window-state.ts (geometry) and the agent settings store (provider/runtime config).

interface PersistedAppPreferences {
  theme: ThemeMode;
  // null = no explicit pick yet → the main process falls back to the OS locale
  // (resolveSystemLocale) on first run; a concrete value pins the language.
  language: Locale | null;
  // null follows the effective UI language until the user explicitly chooses a
  // webpage translation target.
  translationLanguage: TranslationLanguage | null;
  // Opt-in OS (Electron) notifications for off-floor task delivery. Default off —
  // the durable in-app delivery is always on; the OS banner is the user-enabled
  // escalation layer (A3-respecting).
  osNotificationsEnabled: boolean;
}

const DEFAULTS: PersistedAppPreferences = {
  theme: 'system',
  language: null,
  translationLanguage: null,
  osNotificationsEnabled: false,
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
      osNotificationsEnabled: parsed.osNotificationsEnabled === true,
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

export function saveOsNotificationsPreference(enabled: boolean): void {
  savePreferences({ osNotificationsEnabled: enabled });
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
