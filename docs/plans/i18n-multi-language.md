---
status: in-progress
priority: P1
owner: relixiaobo
created: 2026-06-04
updated: 2026-06-04
---

# Multi-Language (i18n) Support

## Goal

Externalize every user-facing string so the app's interface can switch languages
at runtime, including the native menu and dialogs. The user picks a language in
Settings → General; it applies instantly across all windows and persists.

PM-ratified direction (2026-06-04):

- **Approach: lightweight self-built typed i18n.** TS dictionary modules + a React
  context, wrapping the platform's native `Intl.*` for plurals/number/date
  formatting. No `i18next`/`react-intl` — zero runtime deps (A1), and the typed
  dictionary catches missing/typo'd keys at compile time, which fits the repo's
  strict-TS + guard-test culture. Translations are **self-maintained** (the
  deciding factor that ruled out i18next's translation-platform ecosystem).
- **Target languages:** English (canonical base) + 简体中文 + 繁體中文 + 日本語 +
  European languages. Multi-language is the architecture target; English and
  简体中文 ship first, the rest are added as their message files land.

## Non-goals

- Translating user note content (it is the user's own data).
- Translating agent responses — the agent already replies in the user's language
  (`agent-pi-mono-implementation.md`).
- Changing the canonical date storage/query language (`date-field-values.md`,
  `search-query-grammar.md` mandate one canonical local-date language).
- RTL layout — no RTL language is in the initial set; revisit when one is.
- External translation-platform / TMS integration.

## Design

### Mechanism (PR1 — shipped)

- **`src/core/locale.ts`** — the `Locale` union (every value is file-backed),
  `SUPPORTED_LOCALES` (each labelled with its autonym), `DEFAULT_LOCALE`,
  `isLocale`, `resolveSystemLocale` (OS locale → nearest supported), and the
  `LIN_LANGUAGE_CHANGED_CHANNEL`.
- **`src/core/i18n/`** — `messages/en.ts` is the **canonical** tree and defines
  `type Messages = typeof en`. Other locales (`messages/zh-Hans.ts`) are a
  `DeepPartial<Messages>` and fall back to English for any untranslated key.
  Static strings are plain values; strings with runtime values are arrow functions
  taking a typed params object, so interpolation is type-checked at the call site
  (`t.menu.help({ app })`). `getMessages(locale)` deep-merges the override onto
  English and memoizes per locale. Shared by main and renderer.
- **Plurals/formatting** — wrap native `Intl.PluralRules` / `Intl.NumberFormat` /
  `Intl.DateTimeFormat` (CLDR data is built in, so all languages format correctly
  with zero deps). Added in the first migration PR that needs a count, not before
  (no dead code in the foundation).
- **Preference plumbing** mirrors the theme (`appPreferences.ts` gains a
  `language` field). The difference: theme rides Electron's free
  `nativeTheme.themeSource` → `prefers-color-scheme` broadcast; **language has no
  such free broadcast**, so the main process must push it. On `setLanguage`: persist
  → broadcast `LIN_LANGUAGE_CHANGED_CHANNEL` to every window → rebuild the native
  menu.
- **No-flash first paint** — preload reads the effective locale synchronously
  (`ipcRenderer.sendSync('lin:get-language-sync')`, exposed as
  `window.lin.initialLanguage`); the main process resolves it (stored pick, else OS
  locale). The `I18nProvider` seeds from it so launch never flashes English →
  target (mirrors the theme's before-first-paint discipline).
- **Renderer** — each entry (main app, launcher, settings) wraps in
  `<I18nProvider>`; `useT()` reads strings, `useI18n().setLocale` drives the picker.
  The context has an English default so `useT()` never throws outside a provider
  (isolated component tests degrade to English instead of crashing). It also keeps
  `document.documentElement.lang` current for a11y + font shaping.
- **Coverage** — `tests/core/i18nCoverage.test.ts` asserts each locale file is a
  strict subset of English (no stale/typo'd keys, leaf kinds match) and that the
  resolved tree fills every English key; it logs per-locale coverage so partial
  translations are visible without failing the build.
- **Brand** — `src/core/brand.ts` is the single `APP_NAME` source (was a literal in
  main + the launcher); passed into messages as the `app` param, never translated.

**Adding a language** = three lock-step edits: extend the `Locale` union +
`SUPPORTED_LOCALES` (`core/locale.ts`), add `core/i18n/messages/<locale>.ts`, and
register it in `LOCALE_OVERRIDES` (`core/i18n/index.ts`).

### Rollout (foundation-first, A7)

PR1 proves the mechanism end-to-end on a vertical slice — native app/context menu,
launcher chrome, and the Settings → General pane (incl. the language picker) — with
English + 简体中文 complete for that slice. Subsequent PRs migrate the rest surface
by surface, each self-contained; languages beyond en/zh-Hans are added as their
message files land.

## Open questions

- A "System / Automatic" language option (like the theme's System) that follows the
  OS live? PR1 defaults to the OS on first run but then pins the pick; a live-follow
  option can be added later (needs an OS-locale-change listener).
- Whether to code-split message namespaces per renderer surface if the launcher
  bundle's string weight ever matters (negligible at current scale).

## Subtasks

- [x] PR1 — mechanism + slice (menu, launcher chrome, settings General) + en/zh-Hans
      + coverage test.
- [ ] Migrate main-app chrome (sidebar, command palette, window chrome, node panel).
- [ ] Migrate the agent panel (chat, composer, settings panes beyond General).
- [ ] Migrate the outliner (view config, definition config, date picker).
- [ ] Migrate remaining native dialogs (file/image pickers).
- [ ] Add 繁體中文, 日本語, European message files.
- [ ] Fold this design into a `docs/spec/i18n.md` once migration is broadly done
      (PR1 adds the initial spec).
