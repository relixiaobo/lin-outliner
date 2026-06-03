import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isThemeMode, type ThemeMode } from '../core/theme';

// Persist app-level UI preferences across launches (stored in userData, which is
// already per-clone isolated). Currently just the appearance/theme preference;
// new General-pane settings extend this shape. Kept separate from window-state.ts
// (geometry) and the agent settings store (provider/runtime config).

interface PersistedAppPreferences {
  theme: ThemeMode;
}

const DEFAULTS: PersistedAppPreferences = {
  theme: 'system',
};

function preferencesFilePath(): string {
  return join(app.getPath('userData'), 'app-preferences.json');
}

export function loadAppPreferences(): PersistedAppPreferences {
  try {
    const parsed = JSON.parse(readFileSync(preferencesFilePath(), 'utf8')) as Partial<PersistedAppPreferences>;
    return {
      theme: isThemeMode(parsed.theme) ? parsed.theme : DEFAULTS.theme,
    };
  } catch {
    // No prior preferences, or the file is unreadable/invalid — fall back to defaults.
    return { ...DEFAULTS };
  }
}

export function saveThemePreference(theme: ThemeMode): void {
  const next: PersistedAppPreferences = { ...loadAppPreferences(), theme };
  try {
    writeFileSync(preferencesFilePath(), JSON.stringify(next));
  } catch {
    // Best effort — failing to persist the theme is not worth surfacing an error;
    // the in-memory nativeTheme.themeSource still applies for this session.
  }
}
