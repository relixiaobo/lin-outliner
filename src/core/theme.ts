// The app-level appearance preference. These three values map 1:1 onto Electron's
// `nativeTheme.themeSource`: setting it rewrites `prefers-color-scheme` in every
// renderer, so the existing `@media (prefers-color-scheme: dark)` rules in
// theme-dark.css drive the visual flip — no JS theme bridge needed. `'system'`
// follows the OS; `'light'`/`'dark'` pin the app regardless of the OS setting.
//
// This is a UI-preference type, not a document mutation, so it lives in its own
// tiny module rather than the protocol surface in core/types.ts.
export type ThemeMode = 'system' | 'light' | 'dark';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}
