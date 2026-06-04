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

## Migration backlog

A multi-agent audit (2026-06-04) inventoried **542 hardcoded user-facing string
sites** (84 dynamic; the count includes aria/title pairs that collapse to one key).
Raw inventory: `tmp/i18n-audit.json` (regenerate via the `i18n-string-audit`
workflow). Namespaces: existing `menu` / `window` / `launcher` / `settings`
extended; new `shell`, `nodePanel`, `commandPalette`, `outliner`, `definition`,
`agent`, and a cross-surface `common` (shared atoms — Untitled / Loading… / None /
Save / Cancel / Yes / No — declared once so translations don't drift).

Batches, front-loaded by visibility; each is one self-contained PR on top of the
merged foundation:

- [x] PR1 — mechanism + slice (menu, launcher chrome, settings General) + en/zh-Hans
      + coverage test. (#110)
- [x] **B1 — App shell chrome**: App, Sidebar, WindowChrome, WorkspaceCanvas,
      WorkspacePanelSurface, AgentDock. (#110, commit e229b71)
- [x] **B2 — Node panel + date nav + command palette**: incl. `dateFormat.*`
      abbreviation table + the day-title formatter (pure helper takes labels). (#110)
- [x] **B3 — `common` shared primitives + native dialog/window titles**: `Insert image`
      / `Configure provider` + the image-filter label now resolve via
      `getMessages(effectiveLocale())`. (#110)
- [x] **B4 — Outliner view toolbar + system fields**. (#110)
- [x] **B5 — Outliner row chrome**: context menu, field rows, pickers, popovers. (#110)
- [x] **B6 — Definition / supertag config**: pure registry takes a labels bundle. (#110)
- [x] **B7 — Agent chat + composer + message rows**. (#110)
- [x] **B8 — Agent process / tool-call / subagent + main-process strings**:
      pure helpers (`summarizeProcess`, `summarizeToolCall`) take label sub-trees. (#110)
- [x] **B9 — Agent settings panes**: providers/permissions/OAuth/catalog; vendor brand
      names kept verbatim. (#110)
- [x] **B10 — Launcher dynamic strings**: action/row/remediation labels threaded `t`
      through `launcherModel.ts`. (#110)
- [x] **B11 — Missed surfaces (self-review sweep)**: applied tag badges, the search-node
      query UI (summary bar + builder + full operator chip vocabulary), the agent
      debug panel chrome, the tag context menu, and the agent session-title sentinel.
- [x] **B12 — Baked-in English fallbacks in pure helpers** (self-review): a class of
      `content.text || 'Untitled'` (and `'Plain text'`, the `@`-picker date shortcuts,
      slash-command menu labels) baked into pure helpers, which silently defeated callers'
      localized fallbacks. Fixed the display-facing ones — `textOf` now returns raw text
      (display callers apply `|| t.common.untitled`); reference-candidate date shortcuts +
      untitled, code-language "Plain text", launcher node-match titles, and slash-command
      labels are localized. Kept English by design: agent context (`userViewContext`),
      clipboard serialization (`selectionActions`), node-content data (search/capture node
      titles), search-engine internals, and the runtime session-title sentinel's matching.
- [ ] **Remaining rare/edge fallbacks** (deferred, low impact): empty field-def / option
      labels (`outlinerRows`, `systemFields`, `fieldOptions` → `'Untitled'`/`'Field'`) only
      surface for empty-content definitions, and the ProseMirror-schema reference fallbacks
      (`inlineReferenceAttrs` / `pmSchema` / composer `toDOM` → `'Referenced node/file'`)
      run where `t` isn't reachable and the title attr is normally populated. Localize when
      the schema gains a locale hook or these prove visible.
- [ ] **Plurals → `Intl.PluralRules`**: count-bearing strings still use an English
      `n===1` ternary (correct for en + single-form zh; each site is `// TODO plural via
      Intl`-marked). Wire the `Intl.PluralRules` helper when a European locale lands —
      that is when the ternary becomes wrong.
- [ ] Add 繁體中文, 日本語, European message files (after surfaces are extracted).
- [x] Expand `docs/spec/i18n.md` (pure-helper threading pattern + debug-panel boundary).

### Cross-batch rules (from the audit)

- **Dynamic strings → typed arrow functions** in `en.ts` (never placeholder
  strings); `DeepPartial` enforces matching param names across locales.
- **Plurals → `Intl.PluralRules`**, never an `n===1` ternary (Chinese has one form,
  Slavic several). Relative-time / list joins → `Intl.RelativeTimeFormat` /
  `Intl.ListFormat`.
- **Two-state toggles** ("Collapse|Expand") split into two keys or a boolean-param
  function — never store the pipe string.
- **Do-not-translate:** vendor/brand names (AWS, Vertex AI, GitHub Copilot, ChatGPT,
  Claude, claude.ai…), CLI snippets, env-var names, format masks (`YYYY/MM/DD`),
  model-id placeholders.
- **Chinese-only canonical gap:** suggested-prompt copy gets a fresh English
  canonical + zh-Hans translation; `localFileKeywords` is parser-matching input, not
  display copy — kept locale-independent (accepts EN+ZH keywords regardless of UI
  locale).
