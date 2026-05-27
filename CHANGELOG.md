# Changelog

All notable changes to Lin Outliner are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries reference the pull request that introduced them.

## [Unreleased]

Tracks `main`; not yet tagged for release. `package.json` is at `0.1.0`.

### Added

- **`` ``` `` / `~~~` shortcut converts a row to a code block** — typing a lone
  triple-backtick (or triple-tilde) fence that owns an empty, plain row now turns
  the row into an empty `codeBlock` and drops the fence text, a markdown-style
  shortcut alongside the `/code` slash command and pasting a fenced block. Fires
  the instant the row text equals the bare fence (mirroring the `>` field
  trigger), focuses the new code editor, and is gated to plain content rows so
  reference / image / existing-code rows opt out. The eager trailing draft
  materializes first, then converts. Language is left unset (pick it from the
  picker). ([#28](https://github.com/relixiaobo/lin-outliner/pull/28))
- **Local file mentions in the agent composer** — the `@` mention menu now
  combines recent nodes, local files, folders, and live file-search results
  (Spotlight `mdfind` on macOS, `rg` fallback elsewhere); selected entries
  render as inline tokens with native icons, image thumbnails, and hover
  previews. The model-facing prompt preserves positional intent with
  `[[file:<ref>]]` markers while a hidden `<user-attachments>` table maps each
  `ref` to its local path, kind, MIME type, and size, so files, folders, inline
  text, and images share one resolution path. Folders are exposed to the agent
  via a symlink into the local root for `file_glob`. Trashed nodes are excluded
  from both outliner and agent `@` suggestions.
  ([#21](https://github.com/relixiaobo/lin-outliner/pull/21))
- **Eager-materialized trailing draft row** — the Tana-style blank line at the
  bottom of the outline is now a real draft row: typing the first committed
  character materializes an actual node in place (IME-seamless, no editor
  remount) via a client-proposed node id, and drops a fresh empty draft below.
  Create + the first text edits collapse into one undo step. Structural keys
  work on the draft (Enter / Tab indent-under-previous-sibling / Shift+Tab /
  Backspace), plus fixes for leading-inline-ref backspace and merging a row
  into a reference node (converts it to a leading inline reference). Main
  outliner only; `FieldValueOutliner` keeps its typed-control trailing input.
  ([#16](https://github.com/relixiaobo/lin-outliner/pull/16))
- **Agent composer with inline references** — replaced the agent composer
  textarea with a ProseMirror editor supporting slash commands, inline node
  references (rendered consistently across user / assistant / tool output and
  clickable, with Cmd/Ctrl-click opening a new tab), inline file references,
  and paste/drop + native-picker file attachments sent inline to the model.
  ([#15](https://github.com/relixiaobo/lin-outliner/pull/15))
- **Inline images and a local asset subsystem** — paste an image or pick one
  via `/image`; images render inline on a reusable, focusable block-node shell.
  A content-addressed asset store (MIME sniffing, intrinsic-dimension probe,
  path-traversal-safe ids) is served through the privileged `asset://` protocol.
  Each image has a hover toolbar (caption / fullscreen lightbox / open original);
  the caption is the node's description.
  ([#8](https://github.com/relixiaobo/lin-outliner/pull/8))
- **Remote image sources** — image nodes accept a remote `mediaUrl` (validated
  http/https) alongside local assets; pasting a lone image URL creates a remote
  image, while pasting a URL over a selection links the text instead.
  ([#10](https://github.com/relixiaobo/lin-outliner/pull/10))
- **Dedicated code block editor** — `codeBlock` nodes with Shiki syntax
  highlighting, a language picker, horizontal scroll, and cross-row selection.
  ([#2](https://github.com/relixiaobo/lin-outliner/pull/2))
- **`past_chats` agent recall tool** — recent / search / read access over prior
  agent conversations, backed by the event store; tool-call JSON is
  Shiki-highlighted in the UI and renders identically live versus reloaded.
  ([#1](https://github.com/relixiaobo/lin-outliner/pull/1),
  [#4](https://github.com/relixiaobo/lin-outliner/pull/4),
  [#7](https://github.com/relixiaobo/lin-outliner/pull/7))

### Changed

- **Custom-provider add button at the top; in-place model search** — the pinned
  "Custom provider" row at the bottom of the provider list is replaced by a
  compact "+" button beside the search box (active fill while the custom draft is
  open). The model search no longer opens as a separate row below the "Models N"
  heading — the search icon expands in place into an inline field (icon + input +
  close) that fills the header row; closing clears the query.
  ([#40](https://github.com/relixiaobo/lin-outliner/pull/40))
- **Provider detail layout polish + brand icons** — the single-field "Advanced"
  disclosure is gone; Base URL shows inline (optional override, default-endpoint
  placeholder) for every non-managed provider. The read-only model catalog is no
  longer collapsed — it renders inline, with the search field tucked behind a
  search icon beside the "Models N" heading that expands a small input (only when
  a provider has more than one model). Provider list rows and the detail header
  now render real brand logos (color variant where one exists, monochrome mark
  for inherently single-color brands like OpenAI / Vercel / Grok), resolved at
  build time from vendored SVGs; providers without a logo keep the monogram
  fallback. Icons are MIT, vendored from `@lobehub/icons-static-svg` with no
  dependency added. ([#39](https://github.com/relixiaobo/lin-outliner/pull/39))
- **Provider enablement gated on a credential; list status + control polish** —
  "Enabled" now means set up and usable: the toggle is disabled until the
  provider has a credential (key / env key / non-key auth), pasting a key
  auto-enables, and save persists the effective state (never enabled without a
  credential). The provider list shows an enablement dot (green = on, hollow =
  configured-but-off). The search box now uses the design-system field idiom
  (icon + soft border) instead of the bare global input, and selecting a provider
  uses a background fill rather than an outline.
  ([#38](https://github.com/relixiaobo/lin-outliner/pull/38))
- **Correct auth class for OAuth / managed-credential providers** — pi-ai
  authenticates providers three ways, but settings modeled every one as a
  pasteable API key. OAuth providers (GitHub Copilot, OpenAI Codex) and
  managed-credential providers (Amazon Bedrock via AWS, Google Vertex via gcloud
  ADC) now show a credential note explaining the real auth method (+ docs link)
  instead of a misleading key field; the Models disclosure stays. API-key
  providers are unchanged. Full OAuth sign-in is specced in
  `docs/plans/agent-oauth-providers.md`.
  ([#37](https://github.com/relixiaobo/lin-outliner/pull/37))
- **Declutter provider detail (progressive disclosure)** — the provider detail
  had buried its primary task (paste an API key) under repeated status and two
  long lists. The API key is now the hero; Base URL moves into a collapsed
  **Advanced** disclosure (known providers) and the read-only model list into a
  collapsed **Models (N)** disclosure. Dropped the dialog subtitle, the duplicate
  middle "Providers" heading + its disconnected right-floating caption, and the
  "ADD KEY" badge (the empty key field conveys it); the badge now shows only
  Active / Disabled / New. Custom providers keep Provider ID + Base URL visible.
  ([#36](https://github.com/relixiaobo/lin-outliner/pull/36))
- **Provider detail: toggle, key-first order, read-only model list** — the
  Enabled control is now the shared switch toggle (was a checkbox); the API key
  is the first field with Base URL ("Optional") below it (was reversed);
  "Remove key" appears only when a key is actually saved, as a subtle danger link
  in the key's meta row (was a permanently-disabled button); and each provider
  shows a read-only list of its catalog models (name, id, reasoning, context)
  with a count and a search box for large catalogs (OpenRouter exposes 266). No
  per-model enable/disable or fetch — that needs backend work.
  ([#35](https://github.com/relixiaobo/lin-outliner/pull/35))
- **Searchable provider list with pinned Custom + correct names** — follow-up to
  the three-pane Providers settings for the real ~32-provider catalog: a
  "Search providers…" box filters the list, the "Custom provider" entry is pinned
  below the scroll area (no longer buried after every known provider), display
  names get acronym-aware casing (Azure OpenAI, Cloudflare AI Gateway, GitHub
  Copilot, …) via an explicit map + token overrides, and the status dot renders
  only for providers with a meaningful state instead of a hollow dot on every
  row. ([#34](https://github.com/relixiaobo/lin-outliner/pull/34))
- **Three-pane Providers settings with metadata** — the Settings dialog's
  Providers category becomes a three-pane layout: category nav, an always-visible
  scrollable provider list (a monogram avatar + name + a status dot), and the
  selected provider's detail. The textual status moves to a badge in the detail
  header next to the Enabled toggle and a data-driven description
  (`Includes <top models>`). The API key field gains a show/hide reveal toggle
  and a "Get your <provider> API key" docs link (for providers we can link), and
  Base URL is now offered as an optional override for every provider — placeheld
  with the provider's default endpoint — not just custom ones (Provider ID stays
  custom-only). Backed by a new optional `AgentProviderOption.defaultBaseUrl`
  sourced from the catalog. ([#33](https://github.com/relixiaobo/lin-outliner/pull/33))
- **Settings window with provider / agent categories** — the cramped "Agent
  settings" dialog (which stacked provider connection, model + reasoning, and
  global behavior in one scroll, with a duplicate "Provider ID" field, a doubled
  "No key", and a pink "SETUP" box) is now a "Settings" window with a left
  category nav. **Providers** is connection-only: a clean provider row list
  (known providers + a `Custom` OpenAI-compatible entry), one API key with a
  single status line, and Enabled — Provider ID / Base URL surface only for a
  custom provider. **Agent** holds model + reasoning (active-provider defaults,
  key-gated) and behavior (permission mode, skills, directories). The composer
  model menu and the backend commands are unchanged.
  ([#31](https://github.com/relixiaobo/lin-outliner/pull/31))
- **Sidebar tree shows only a node's own icon** — the workspace tree no longer
  paints hardcoded fallback glyphs on system nodes (the calendar on Daily notes,
  plus the library / search / trash glyphs), since those nodes carry no icon of
  their own. The top primary-nav shortcuts (Today / Library / Recents / Schema)
  keep their icons. ([#30](https://github.com/relixiaobo/lin-outliner/pull/30))
- **Humanized day-note titles, no date header icon** — a daily-note panel titled
  with its raw ISO date (`2026-05-13`) above a calendar icon now shows a humanized
  read-only label instead: the weekday/month/day (`Wed, May 27`), prefixed with
  `Today` / `Tomorrow` / `Yesterday` for the adjacent days (`Today, Wed, May 27`),
  matching nodex. The docked breadcrumb's current-page label uses the same string,
  and the today panel's calendar header icon is removed so date nodes carry no
  header icon. Day nodes are locked, so this is display-only — the `YYYY-MM-DD`
  content is untouched. ([#29](https://github.com/relixiaobo/lin-outliner/pull/29))
- **Tool output shows the model-visible payload** — the agent tool-call Output
  region now renders exactly the slimmed `content` the model received (a
  syntax-highlighted JSON envelope) instead of reconstructing the fuller
  `details` envelope. This makes "what you see" match "what the model got" and
  removes the prior live-vs-reload inconsistency (`details` is not persisted).
  ([#19](https://github.com/relixiaobo/lin-outliner/pull/19))
- **View toolbar redesign** — per-node Display / Group by / Sort by / Filter by
  moved from inline panels to anchored popovers that no longer shift the row
  list; progressive, field-type-aware filter editors (boolean / options / date /
  number / text); date-aware filter matching; humanized group labels and
  field-semantic sort directions; an active-state summary line; and removal of
  the non-functional "View as" switcher.
  ([#9](https://github.com/relixiaobo/lin-outliner/pull/9))
- **Structure-aware clipboard paste** — inline marks, fenced code into code
  blocks, rich-HTML routing, and single-line URL linking; later extracted into a
  shared `classifyMediaPaste` classifier used by both the inline editor and the
  trailing input (Phase 1 of the node-line editor unification).
  ([#5](https://github.com/relixiaobo/lin-outliner/pull/5),
  [#11](https://github.com/relixiaobo/lin-outliner/pull/11))

### Fixed

- **Code-block language picker redesign** — replaced the native `<select>` (which
  opened an OS-styled, uncoordinated dropdown) with the shared menu primitives: a
  compact trigger whose chevron sits next to the label, opening a portaled
  `MenuSurface` popover that matches the design system. Hover now deepens text /
  icon color instead of adding a background fill, for both the language trigger
  and the copy button. ([#27](https://github.com/relixiaobo/lin-outliner/pull/27))
- **Unknown code-block languages fall back to Plain text** — a pasted fence with
  a non-language info string (e.g. `tool` / `tool-error` from an agent
  transcript) no longer shows a bogus language in the picker. A Shiki-backed
  `isKnownCodeLanguage` check coerces any language Shiki cannot highlight to
  Plain text for the label, selected value, and highlighting, while preserving
  real grammars outside the picker list (e.g. `kotlin`). The code block's
  language picker now uses the `SelectControl` primitive and `--control-size-*`
  tokens. ([#26](https://github.com/relixiaobo/lin-outliner/pull/26))
- **Pasting into the trailing draft row** — pasting structured content into the
  blank line at the bottom of the outline threw `CoreError: node not found`,
  because the eager draft row has no core node until its first character
  materializes it. The paste path now appends the pasted trees under the parent
  (via `create_nodes_from_tree`) for a pristine draft, and waits for an in-flight
  materialize otherwise. ([#25](https://github.com/relixiaobo/lin-outliner/pull/25))
- **Pasting fenced code blocks with multi-word info strings** — the paste
  parser only recognized a fence whose info string was a single token, so a
  CommonMark-valid fence like ` ```tool node_create ` leaked as plain text and
  desynced every later open/close pairing (prose swallowed into empty "Plain
  text" code blocks, real code split into one row per line). Any info string is
  now accepted, with its first token used as the language.
  ([#24](https://github.com/relixiaobo/lin-outliner/pull/24))

### Internal

- **Register the `anti` dev clone** — a fourth parallel dev clone
  (`lin-outliner-anti/`, Claude Code dev agent, branch prefix `anti/<topic>`) is
  documented in `AGENT.md` / `CLAUDE.md`, with a matching `dev:anti` script
  pointing `ELECTRON_USER_DATA_DIR` at `$HOME/.lin-outliner-anti` for userData
  isolation. ([#41](https://github.com/relixiaobo/lin-outliner/pull/41))
- **Drop dead `ProviderChoice` fields** — the Settings dialog's
  `buildProviderChoices` no longer populates `modelId` / `custom` on each
  provider choice; nothing read them (rendering, sort, and status label use only
  `providerId` / `configured` / `active` / `enabled` / `hasCredential`).
  Self-review follow-up to #31, behavior-preserving.
  ([#32](https://github.com/relixiaobo/lin-outliner/pull/32))
- **Prod install isolation + signing** — `userData` now resolves in three
  tiers (`ELECTRON_USER_DATA_DIR` → `$HOME/.lin-outliner-dev` for unpackaged
  source runs → the default path for installed builds), so a bare `bun run dev`
  can never touch the installed prod app's daily-use data. An `afterPack` hook
  deep ad-hoc signs the packaged macOS `.app` (electron-builder skips bundle
  signing under `mac.identity: null`), sealing it so the unsigned arm64 build
  launches on Apple Silicon. Docs cover the resolution order and the build /
  install flow. ([#23](https://github.com/relixiaobo/lin-outliner/pull/23))
- **Bounded local-file caches** — the local file search / icon / thumbnail
  caches now evict oldest-first via a shared bounded helper instead of clearing
  wholesale at 1000 entries. The wholesale clear could drop the `id -> path`
  mappings that prepare/preview rely on, making recently surfaced `@`-mention
  files unselectable mid-session. Follow-up to #21.
  ([#22](https://github.com/relixiaobo/lin-outliner/pull/22))
- **Subagent next-step guidance on the envelope** — the `Agent` / `AgentStatus`
  / `AgentSend` / `AgentStop` subagent tools now carry their next-step
  `instructions` via the envelope's top-level `instructions` field
  (`successEnvelope(tool, data, { instructions })`) instead of duplicating it on
  `data.instructions` in the model-visible projection. Follow-up to #17.
  ([#20](https://github.com/relixiaobo/lin-outliner/pull/20))
- **Slimmer model-visible tool output** — `web_search`, `web_fetch`,
  `file_glob`, `file_grep`, `bash`, `task_stop`, `operation_history`, and the
  `Agent`/`AgentStatus`/`AgentSend`/`AgentStop` subagent tools now project a
  trimmed view to the model via `agentToolResult(envelope, modelData)`, dropping
  echoed call arguments, constant provider metadata, and telemetry
  (`durationMs`, `byteLength`, `finalUrl`, the Loro cursor, etc.). The full data
  stays on the envelope (`details`); conditional fields (redirect `finalUrl`,
  non-200 `statusCode`, pagination) are emitted only when meaningful. Adds
  projection unit tests per tool.
  ([#17](https://github.com/relixiaobo/lin-outliner/pull/17))
- **Shared node-line view helpers** — extracted `nodeLineView.ts`
  (`caretAnchor`, `selectionTextOffsets`, and a unified inline-ref-aware
  `selectionForPlacement` / `applyCursorPlacement`) from `RichTextEditor` and
  `TrailingInput`, which both now delegate to it. Behavior-preserving (the
  trailing input's old `1 + offset` math reduces to the shared version for
  plain text, pinned by unit tests); Phase 2a of the node-line editor
  unification. ([#12](https://github.com/relixiaobo/lin-outliner/pull/12))
- **Node-line editor core build contract** — design doc
  (`docs/plans/node-line-editor-core-design.md`) pinning the Phase 2b
  approach: drop the monolithic `useNodeLineEditor` hook in favor of shared
  pure modules, and route trigger application through `resolveTargetId`.
  ([#13](https://github.com/relixiaobo/lin-outliner/pull/13))
- **Three-clone parallel-agent hub model** — `lin-outliner` (main: review /
  merge / integration) plus `lin-outliner-cc`, `lin-outliner-cc-2`, and
  `lin-outliner-codex` dev clones sharing one GitHub origin, integrating via PRs
  to `main`, with per-clone `userData` isolation (`dev:main` / `dev:cc` /
  `dev:cc-2` / `dev:codex`).
