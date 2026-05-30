# Changelog

All notable changes to Lin Outliner are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries reference the pull request that introduced them.

## [Unreleased]

Tracks `main`; not yet tagged for release. `package.json` is at `0.1.0`.

### Added

- **Agent tool permissions (global runtime policy)** — implements
  `docs/plans/agent-tool-permissions.md`: one global, runtime-owned permission
  policy (allow/ask/deny by action kind) replacing the hidden one-off approval
  matrix. Adds action descriptors and a global JSON permission store
  (`permissions.allow`/`ask`/`deny`) with fail-closed load/save validation that
  rejects forbidden-allow shapes (wildcards, the arbitrary-code shell-prefix
  denylist — interpreters, `eval`/`exec`/`xargs`/`sudo`, package managers
  `npm`/`pnpm`/`yarn`/`bun`/`npx`/`bunx`/`tsx`, `ssh`, PowerShell — and the
  agent/sub-agent-spawn ban). Platform hard blocks are evaluated before any
  allow rule: sensitive-read-plus-network-write exfiltration, credential /
  shell-startup / `.git/hooks` / persistence writes, payment, permission
  self-modification, and unknown/obfuscated shell. The bash classifier handles
  known command families and evaluates compound commands by most-restrictive
  segment (`find -exec`/`-delete` and `sed -i` are treated as
  execution/edit/persistence, not read-only). A classifier-backed `ask` resolver
  is bounded by a `classifierAutoAllowEligible` gate (default `false`) that can
  never auto-allow high-consequence / outward / sensitive actions, and the
  classifier sub-call receives only a classification output contract, never the
  real tools. Ships the composer approval card (Approve once / Always allow this
  kind / Deny once), a permission center UI, structured `permission_denied`
  results, and `tool.permission.checked`/`tool.permission.resolved` event-log
  entries. Reviewed via a deep multi-agent pass that found and confirmed-fixed 1
  critical + 4 high fail-opens before merge; `typecheck` clean, permission tests
  30/0. Non-blocking follow-ups remain (sessionApproved ordering vs
  configured-ask, `parseGlobalToolPermissionSettings` pre-shaped early-return,
  interpreter-stdin exfil sinks, dual `approval.*`/`tool.permission.*` event
  vocabulary, denied-reason literal naming).
  ([#60](https://github.com/relixiaobo/lin-outliner/pull/60))
- **Agent tool permissions plan (authority)** — adds
  `docs/plans/agent-tool-permissions.md` as the single authoritative agent
  permission plan and shelves the two earlier P0 drafts
  (`agent-permissions.md`, `agent-reversible-execution.md`) with pointers to it.
  The plan defines one global runtime-owned policy (allow/ask/deny by action
  kind), platform hard blocks, a classifier-backed `ask` resolver bounded by a
  `classifierAutoAllowEligible` descriptor gate (a deliberate strengthening over
  cc-2.1, which lets its classifier model auto-allow high-consequence actions),
  fail-closed rule validation with an explicit arbitrary-code shell-prefix
  denylist and an agent/sub-agent-spawn allow ban, sensitive-data exfiltration
  redlines, and a defined interactive/unattended fail-safe. Plan refined on merge
  per a cc-2.1 source comparison (precedence wording, the two borrowed validation
  rules, and classifier-callable vs auto-allow-eligible terminology). A second
  pass pinned the concrete defaults cc-2.1 ships (per-action-kind
  `defaultDecision` table — outside-area read / web fetch / delete / publish /
  send-message default to `ask`; in-area read/edit and web search to `allow`),
  added a Classifier Prompt Contract (named block-category taxonomy mirroring
  the deterministic redlines + operational params) and a concrete safe
  auto-allow tool allowlist + outward-facing shell-command list, so the defaults
  are implementable rather than left as `Allow / Ask` placeholders.
  ([#59](https://github.com/relixiaobo/lin-outliner/pull/59))
- **macOS window corner radius (native)** — gives the standard macOS window a
  custom `24pt` continuous corner (matching Raycast) while keeping native traffic
  lights, the OS drop shadow, vibrancy, and live resize. A tiny zero-dependency
  Node-API addon (`native/window-corner/`) sets the corner via the private
  `_cornerRadius`/`_effectiveCornerRadius` selectors on macOS 26 Tahoe (where
  `_cornerMask` is ignored for frame/shadow shaping) and falls back to a
  `_cornerMask` override on older macOS; the vibrancy frost is rounded via the
  public `NSVisualEffectView.maskImage`. The loader degrades to a silent no-op
  off-darwin / when unbuilt, the radius is the `MAC_WINDOW_CORNER_RADIUS` JS
  const (restart-only to tune), and `app:build` runs `build:native` before
  packaging (the `.node` ships via `extraResources`, outside the asar).
  ([#58](https://github.com/relixiaobo/lin-outliner/pull/58))
- **Design system — spec, rollout plan, and Phase 1 token foundation** — adds
  `docs/spec/design-system.md` (the design language as a contract: two-theme
  alpha-on-ink tokens, material/overlay taxonomy, concentric radius chain,
  neutral-functional state with sparse rose brand) and `design-system-rollout.md`
  (4-phase staged plan). Phase 1 is CSS-only in `styles.css`: introduces the
  `--ink` semantic layer (text / fill / separator / surface / material / accent /
  status / selection / focus / elevation / outline) as the source of truth and
  re-points every legacy alias onto it, so components keep working and move to the
  designed light palette. The dark theme is fully defined but **gated behind
  `:root[data-theme="dark"]`** (not `prefers-color-scheme`) so it stays inert
  until the component layer is theme-aware — Phase 2 wires `nativeTheme.themeSource`
  → `data-theme`. ([#55](https://github.com/relixiaobo/lin-outliner/pull/55))
- **Native-feel stage 2 — startup polish, window-state, single-instance** — the
  window is created `show: false` and revealed on `ready-to-show` (no white
  launch flash); a new `windowState.ts` persists and restores normal bounds +
  the maximized flag (validated against connected displays so a now-disconnected
  monitor can't strand the window off-screen); and `requestSingleInstanceLock()`
  focuses the running window instead of spawning a duplicate.
  ([#45](https://github.com/relixiaobo/lin-outliner/pull/45))
- **Native-feel stage 3b — OS window material** — macOS draws `under-window`
  vibrancy and Windows draws `mica` behind the chrome, driven by a shared
  `core/windowMaterial.ts` mapping read by both the main process and preload; the
  renderer tags `<html>` with `data-window-material` on the first painted frame
  so there is no opaque→frosted flash. Other platforms keep the opaque deck.
  ([#47](https://github.com/relixiaobo/lin-outliner/pull/47))
- **Native-feel stage 4a — in-app dialogs (no `window.prompt`/`confirm`)** — the
  remaining blocking browser dialogs are gone: node icon/banner edits use an
  in-menu text-input sub-mode (consistent with the existing tag/move inputs), and
  destructive session-delete uses a reusable `ConfirmDialog` primitive (focus
  trap, Escape-to-cancel, Cancel takes initial focus so a stray Enter can't
  delete). ([#48](https://github.com/relixiaobo/lin-outliner/pull/48))
- **Native-feel stage 4b — settings in its own window** — settings moved from an
  in-app modal into a dedicated Preferences-style window with a native title bar,
  served from the single `index.html` via a `?surface=settings` marker (no second
  build entry) and going through the same stage-1 navigation hardening + CSP. New
  IPC: `lin:open-settings` / `lin:close-settings` / `lin:settings-changed`. The
  stage-4 native right-click `Menu` was intentionally dropped — the rich DOM
  context menu outweighs the native-feel gain.
  ([#49](https://github.com/relixiaobo/lin-outliner/pull/49))
- **Keyboard shortcut parity with nodex** — closes the audited gaps against the
  nodex reference. `Cmd/Ctrl+A` now selects every visible row in the current
  root even from an empty selection (focused editors still get native text
  select-all); `Cmd/Ctrl+Shift+D` goes to today's daily note when no row is
  selected while keeping batch-duplicate when a selection is active; panel
  navigation history gets dedicated `Cmd/Ctrl+[` / `Cmd/Ctrl+]` and
  `Alt+ArrowLeft` / `Alt+ArrowRight` bindings (document undo/redo stays on
  `Cmd/Ctrl+Z`, never overloaded); and a selected option-reference field value
  opens a keyboard-owned option menu where `ArrowUp`/`ArrowDown` move, `Enter`
  selects, and `Escape` closes the menu before clearing the row selection. The
  audit confirmed drag-select and click-away dismissal were already present.
  ([#53](https://github.com/relixiaobo/lin-outliner/pull/53))
- **Agent tool permissions — `allow | ask | deny` with an approval flow** — the
  runtime permission decision evolved from a boolean to a three-state behavior
  computed entirely in TypeScript policy (never from model prose). High-consequence
  actions now suspend the agent and request user approval instead of silently
  running or hard-failing: external GitHub mutations (`git push`, `gh pr/issue/
  release/repo/workflow`), package/deploy/publish changes, database migrations,
  background commands, sandbox overrides, sensitive local-path access
  (`~/.ssh`, `.env`, credential/keychain files), and unscoped recursive deletes
  ask; machine destruction, remote-code-execution pipes, shell obfuscation, and
  sensitive-data network exfiltration are redline `deny` that session rules and
  skills cannot approve. Approvals render in the agent composer (Allow once /
  this session / Deny + details popover), bubble up from subagents and skill-shell
  commands through one path, queue when multiple are pending, and are recorded as
  `approval.requested` / `approval.resolved` in the event log.
  ([#51](https://github.com/relixiaobo/lin-outliner/pull/51))
- **Inline Markdown formatting while typing** — typing the closing delimiter now
  converts low-ambiguity inline syntax in the row editor and agent composer into
  the matching mark and drops the delimiters: `` `code` ``, `**bold**`,
  `~~strike~~`, `==highlight==`, and `[text](url)`. `*italic*` and underscore
  variants are intentionally ignored to avoid accidental conversion. The `code`
  mark is non-inclusive and ArrowLeft/ArrowRight can move the caret out of an
  inline code mark even with no adjacent plain text.
  ([#51](https://github.com/relixiaobo/lin-outliner/pull/51))
- **Done-state mapping + free-typed options + color swatch picker** — three
  user-facing additions ride with the config-as-nodes refactor. A supertag with
  "Show as checkbox" on can map its done/undone state to one or more option-field
  values (Tana parity): checking the box sets each mapped field's checked value,
  and selecting a mapped checked/unchecked value toggles the box (two-way, single
  write each direction, loop-guarded). Number fields gain a non-blocking
  out-of-range warning (`minValue`/`maxValue`) that never rejects a write. Options
  fields now accept **free-typed** values decoupled from auto-collect (collect on
  ⇒ value becomes a reusable collected option; off ⇒ stored as a plain free-text
  value on that entry alone) and render as inline editable rows. The supertag
  display color is now a preset **swatch picker** (8 base colors + "no color")
  storing a theme-aware token instead of raw hex.
  ([#18](https://github.com/relixiaobo/lin-outliner/pull/18))
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

- **Design system — floating-rails shell, neutral token migration,
  dark-follows-OS** — dissolves `TopBar` into a persistent `WindowChrome` (a top
  drag strip that reserves the traffic-light inset plus two centreline rail
  toggles) and per-pane breadcrumb headers; the global tab strip, `WorkspaceTab`,
  and global Back/Forward are gone — the sidebar is now the tab switcher (select /
  create / close), per-pane Back lives in the breadcrumb, and page-nav is on
  `Cmd+[` / `Cmd+]`. The sidebar and agent rails **float** (inset, rounded
  `--radius-panel`, `--shadow-rail`, material + `backdrop-filter` + `--rail-edge`)
  over a full-bleed opaque canvas; the agent rail unfurls from a collapsed seed
  to the open panel without ever remounting `AgentChatPanel` (chat scroll +
  composer draft survive). Components move onto the alpha-on-ink token layer:
  `rgba` → alpha-on-ink tokens, the deprecated rose `--primary*` family →
  neutral `--fill-*` / `--focus-ring` / `--outline-focus` (the family is now
  deleted, zero references), inline-ref blue → rose centralized at the token
  layer, `--danger` → `--status-danger`, new `--text-on-accent`. `theme.ts`
  mirrors the OS colour scheme onto `[data-theme]` so **dark follows the OS**
  (a persisted in-app light/dark/system toggle via `nativeTheme.themeSource` is
  deferred to #45). Resize handles gain double-click-to-reset; the pre-paint
  window background follows `nativeTheme` so a dark-OS launch never flashes a
  light frame. ([#57](https://github.com/relixiaobo/lin-outliner/pull/57))
- **Native-feel stage 3 — strict-native cursor + system font** — removed
  `cursor: pointer` from every chrome control (buttons, toggles, bullets, rows,
  tabs, `summary` disclosures); the pointing-hand cursor is now reserved for
  genuine content hyperlinks (inline references, clickable tag chips, external
  doc links). `--font-family-sans` now leads with `-apple-system` /
  `Segoe UI Variable` so text renders in the platform UI font, keeping `Inter`
  only as a late fallback.
  ([#46](https://github.com/relixiaobo/lin-outliner/pull/46))
- **Inline/code styling on design tokens + simplified agent wording** — inline
  code and code blocks now use shared `--font-code-inline` / `--font-code-block`,
  `--line-code-*`, `--inline-code-bg`, and `--primary-muted-text` tokens (inline
  code reads as a compact badge with `box-decoration-break: clone`) instead of
  ad-hoc font stacks and rgba backgrounds. Product-facing agent/tool wording was
  simplified so the agent keeps the `Lin Agent` identity without over-describing
  itself as a separately branded outliner: "Lin Outline Format" → "outline
  format", "local file root" → "default file area"/"allowed file area", and the
  system-prompt identity line is trimmed. The `dangerouslyDisableSandbox` bash
  parameter is removed from the tool schema (still checked in the policy layer as
  defense-in-depth). ([#51](https://github.com/relixiaobo/lin-outliner/pull/51))
- **Config-as-nodes — definition config lives in the node tree** — definition
  (tag/field) configuration no longer lives as flat typed `Node` fields. Each
  knob is a `defConfig` child node (stable id, locked structure) whose value is
  held as its own child node(s) — the same mechanism field values use: scalars as
  a value node (codec-validated text), refs/enums as a `reference` to a target or
  a derived `systemOption` node. Reads go through typed accessors over
  `buildConfigIndex`; writes go through one registry-governed `setConfigValue`
  chokepoint. Config nodes stay in the projection (so reference labels resolve)
  but are excluded per-consumer via a shared `isInternalConfigNode` predicate. The
  cutover migrated `color`, `extends`, `childSupertag`, `fieldType`, `cardinality`,
  `nullable`, `hideField`, `autocollectOptions`, `autoInitialize`,
  `minValue`/`maxValue`, `sourceSupertag`, `showCheckbox`, and `doneStateEnabled`.
  `FieldType` is slimmed 13 → 8 (`plain`, `options`, `options_from_supertag`,
  `date`, `number`, `url`, `email`, `checkbox`); retired types fall back to `plain`
  instead of crashing. ([#18](https://github.com/relixiaobo/lin-outliner/pull/18))
- **Settings panel info architecture & style normalization** — the agent
  Settings dialog is reorganized from two categories into three: **Providers**,
  **Skills**, and **Agent Profiles**. Providers now infer credential state
  automatically — the "Enabled" toggle (introduced in #38) is replaced by a
  "Set as Active" action with `Active` / `Configured` badges and a list status
  dot (green = active, filled-soft = configured-but-inactive); the API key field
  gains a reveal mask plus a remove (trash) action, Base URL collapses into an
  "Advanced Settings" disclosure, and a "Test Connection" button reports a
  one-shot diagnostic (401 / 404 / 403 / timeout classified). The **Skills** tab
  adds global behavior switches (Automatic Skills, Slash Skills, Compact) and a
  per-skill enable/disable list; the **Agent Profiles** tab pairs a list with a
  read-only detail card (persona prompt, model / reasoning / permission / max-turns,
  tools) and per-agent enable/disable. Disabled skills and agents are filtered
  from model/slash listings and rejected at invocation and spawn. Backed by new
  IPC: `agent_list_all_skills`, `agent_list_all_definitions`, and
  `agent_test_provider_connection`. Supersedes parts of #38 (enablement toggle)
  and #39 (inline Base URL). ([#42](https://github.com/relixiaobo/lin-outliner/pull/42))
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

- **Modularize `styles.css` into per-surface modules** — the 6851-line monolith
  is split into 30 cascade-ordered modules under `src/renderer/styles/` behind a
  `styles/index.css` barrel; concatenating the modules in barrel order reproduces
  the original byte-for-byte at the split commit. Also fixes two long-standing
  undefined-token references the split surfaced (`--font-mono` →
  `--font-family-mono`, `--control-bg` → `--fill-2`).
  ([#57](https://github.com/relixiaobo/lin-outliner/pull/57))
- **Renderer perf — per-node memo, focus memo, opt-in flat virtualization** —
  `OutlinerItem` is memoized on a per-node `renderRev` (a dev-only
  `LIN_RENDER_PROBE` measures per-command re-render cost), and the global
  `uiGen` re-render is replaced by `deriveRowMemoState` / `rowMemoStateEqual` so a
  row re-renders only when its own UI state moves (behavioural reads route
  through a live `uiRef`, so skipped rows stay correct). A windowed
  `OutlinerFlatView` is gated behind `localStorage 'lin:flat-outliner'`, so
  default behavior is unchanged. Resolved one positional merge conflict in
  `OutlinerItem.tsx` against the #53 keyboard work on the way in (both additions
  kept). ([#54](https://github.com/relixiaobo/lin-outliner/pull/54))
- **Native-feel stage 5b — incremental core state + projection caches** — the
  Core mutation/read path is now O(touched) instead of rematerializing the whole
  document and deep-cloning every node per command; the public IPC contract
  (`DocumentProjection`, `CommandOutcome`, `DocumentState`) is byte-for-byte
  unchanged. A single keystroke in a 1000-node doc dropped from ~770ms to
  ~0.27ms and the old ~2000-node loro crash is gone.
  ([#52](https://github.com/relixiaobo/lin-outliner/pull/52))
- **Native-feel stage 5a — opt-in IPC tracing (measure-first)** — `LIN_TRACE_IPC=1`
  logs one line per command (`[ipc] <command> <ms> <payload kB> nodes=<n>`) around
  the `lin:invoke` chokepoint, with zero overhead when off. The measurement proved
  serialization was a non-issue (<1ms at 1000 nodes), redirecting the stage-5b
  perf work to the Core layer.
  ([#50](https://github.com/relixiaobo/lin-outliner/pull/50))
- **Security shell — host owns navigation + capabilities (native-feel stage 1)**
  — the main process now closes the renderer's default-open Chromium surface.
  `setWindowOpenHandler` denies all child windows (http(s) `target="_blank"`
  links route to the OS browser via `shell.openExternal`); `will-navigate` /
  `will-redirect` block navigating the renderer away from its own document
  (`file://` in prod, the Vite origin in dev) and send external http(s) to the
  OS browser. Permission request/check handlers deny every capability except
  `clipboard-sanitized-write` (the only one the renderer uses). A strict
  `Content-Security-Policy` (`script-src 'self'`, no `unsafe-inline`/`eval`;
  `unsafe-inline` styles only; remote http(s) only as img/media sources;
  `connect-src 'self'`) is injected on the packaged renderer's own `file://`
  main-frame document — scoped so the agent's remote web-fetch windows are
  untouched. Verified against the built bundle and an `electron out/main` run
  (CSP applies, zero violations). The applied behavior remains scoped to the
  main window; agent web-fetch/search windows keep their own navigation
  lifecycle. ([#43](https://github.com/relixiaobo/lin-outliner/pull/43))
- **Discriminated `Node` union — god-record removed** — the ~57-field `Node`
  god-record is now a discriminated union of per-`NodeType` variant interfaces
  over a small uniform `NodeBase` (`ContentNode` = the `type?: undefined`
  variant). Content-type-specialized fields moved onto their owning variant
  (media → `CodeBlockNode`/`ImageNode`/`EmbedNode`; query params → a
  `QueryParams` mixin on `SearchNode`/`QueryConditionNode`; view rules →
  `ViewDefNode`/`SortRuleNode`/`FilterRuleNode`/`DisplayFieldNode`; `configKey` →
  `DefConfigNode`; `fieldDefId` → `FieldEntryNode`; `targetId`/`refRole` →
  `ReferenceNode`). The query-rule target that `search`/`queryCondition` shared
  with references was split out to `queryTargetId` so `targetId` is unambiguously
  the reference pointer. Persistence enumerates `NodeFieldKey = KeysOfUnion<Node>`
  to read/write the flat scalar map generically. References carry an explicit
  `refRole` (`link`/`fieldValue`/`config`/`enum`/`searchResult`/`autoInit`) and
  backlinks use an allowlist instead of parent inference.
  ([#18](https://github.com/relixiaobo/lin-outliner/pull/18))
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
