import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isThemeMode, type ThemeMode } from '../core/theme';
import { isLocale, type Locale } from '../core/locale';

// Persist app-level UI preferences across launches (stored in userData, which is
// already per-clone isolated). The appearance/theme preference and the display
// language; new General-pane settings extend this shape. Kept separate from
// window-state.ts (geometry) and the agent settings store (provider/runtime config).

interface PersistedAppPreferences {
  theme: ThemeMode;
  // null = no explicit pick yet → the main process falls back to the OS locale
  // (resolveSystemLocale) on first run; a concrete value pins the language.
  language: Locale | null;
}

const DEFAULTS: PersistedAppPreferences = {
  theme: 'system',
  language: null,
};

function preferencesFilePath(): string {
  return join(app.getPath('userData'), 'app-preferences.json');
}

export function loadAppPreferences(): PersistedAppPreferences {
  try {
    const parsed = JSON.parse(readFileSync(preferencesFilePath(), 'utf8')) as Partial<PersistedAppPreferences>;
    return {
      theme: isThemeMode(parsed.theme) ? parsed.theme : DEFAULTS.theme,
      language: isLocale(parsed.language) ? parsed.language : DEFAULTS.language,
    };
  } catch {
    // No prior preferences, or the file is unreadable/invalid — fall back to defaults.
    return { ...DEFAULTS };
  }
}

export function saveThemePreference(theme: ThemeMode): void {
  savePreferences({ theme });
}

export function saveLanguagePreference(language: Locale): void {
  savePreferences({ language });
}

// Read-modify-write a subset of preferences, preserving the rest. Best effort —
// failing to persist a UI preference is not worth surfacing an error; the in-memory
// state (nativeTheme.themeSource / the broadcast locale) still applies this session.
function savePreferences(patch: Partial<PersistedAppPreferences>): void {
  const next: PersistedAppPreferences = { ...loadAppPreferences(), ...patch };
  try {
    writeFileSync(preferencesFilePath(), JSON.stringify(next));
  } catch {
    // ignore — see note above
  }
}
