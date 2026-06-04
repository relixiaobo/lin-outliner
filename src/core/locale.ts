// The app-level language preference. Unlike the theme preference (core/theme.ts),
// which Electron broadcasts to every renderer for free via nativeTheme.themeSource
// → prefers-color-scheme, language has no such native broadcast: the main process
// must persist it, push it to all windows over LIN_LANGUAGE_CHANGED_CHANNEL, and
// rebuild the native menu. See docs/plans/i18n-multi-language.md.
//
// A `Locale` is always file-backed: every value here has a real message surface in
// core/i18n/messages (even if partial — missing keys fall back to English). Adding
// a language is three edits in lock-step: extend this union, add a SUPPORTED_LOCALES
// row, and add a core/i18n/messages/<locale>.ts file.

export type Locale = 'en' | 'zh-Hans';

export const DEFAULT_LOCALE: Locale = 'en';

// Each locale labelled in its own language (the autonym), the convention for a
// language picker — a reader recognizes their language without reading English.
export const SUPPORTED_LOCALES: ReadonlyArray<{ code: Locale; nativeName: string }> = [
  { code: 'en', nativeName: 'English' },
  { code: 'zh-Hans', nativeName: '简体中文' },
];

const LOCALE_CODES = new Set<string>(SUPPORTED_LOCALES.map((entry) => entry.code));

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && LOCALE_CODES.has(value);
}

// Map an OS locale tag (e.g. 'en-US', 'zh-CN', 'zh-Hans-CN', 'ja-JP') onto the
// nearest supported locale, falling back to English. Used for the first-run default
// before the user has made an explicit pick. The mapping stays intentionally coarse
// — refine a branch only when that script's file actually ships.
export function resolveSystemLocale(systemLocale: string): Locale {
  const tag = systemLocale.toLowerCase();
  if (tag.startsWith('zh')) return 'zh-Hans';
  if (tag.startsWith('en')) return 'en';
  return DEFAULT_LOCALE;
}

// Main → renderer push when the language changes, so every open window re-renders
// in the new locale without a reload (mirrors LIN_WINDOW_ACTIVE_CHANNEL et al.).
export const LIN_LANGUAGE_CHANGED_CHANNEL = 'lin:language-changed';
