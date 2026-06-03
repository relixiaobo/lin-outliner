# Changelog

All notable changes to Lin Outliner are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries reference the pull request that introduced them.

## [Unreleased]

Tracks `main`; not yet tagged for release. `package.json` is at `0.1.0`.

### Added

- **macOS branding & chrome polish (PR #84)** — implements
  `macos-native-branding-polish.md` (T1–T6). The **app icon** is rebuilt to Apple's macOS
  icon grid: a squircle master (`assets/brand/tenon-icon-master.svg`, 824 / r≈185.4 / 100px
  transparent gutter on 1024) regenerated to `.icns`/`.png` by `scripts/gen-icon.mjs`. The
  Dock "white frame" (白边) is fixed by switching the rasterizer from `qlmanage` — which
  mattes the transparent gutter to opaque white — to headless Chromium with
  `omitBackground`; the gutter is `rgba(0,0,0,0)` (pixel-probed at 1024/512/32), replacing
  the old full-bleed square. The duplicate sidebar brand header (and its `sidebar-brand*`
  CSS) is removed so the **workspace-root row is the sole identity**. The **app menu** gains
  About/Hide/Quit, renames "Preferences…" → "Settings…", sets copyright `© 2026 Lin Lab`
  (About panel + electron-builder), and Help → "Tenon Help" + "Report an Issue…". (In a dev
  run the bold app title still reads "Electron" and ⌘, still reads "Preferences…" because
  those are OS-managed from the Electron dev bundle; a packaged `--dir` build was launched
  and verified to show "Tenon" + "Settings…" with the correct Info.plist and a
  sha256-identical bundled icon.) Design-system spec updated to the single workspace-root
  avatar (A6); no `src/core` protocol surface touched. The true Liquid-Glass `.icon`
  pipeline is deferred to `docs/plans/macos-liquid-glass-icon.md` (P2 draft).

- **Editable workspace root title (rename your workspace)** — the workspace root
  (`WORKSPACE_ID`, "Tenon") is now seeded with `locked=false`, so its title is editable
  rich text in the panel header and the sidebar workspace-root row. Structural protection
  is unchanged: `ensureNodeMovable` still blocks move/delete/reparent via the independent
  `isSystemId` check, so the root stays fixed in the tree while only its title becomes
  editable. The functional sections (Daily notes, Library, Schema, Saved searches, Trash,
  Settings) keep read-only titles. The sidebar brand wordmark (the logo + "Tenon" at
  top-left) is a hardcoded brand string and is unaffected. `ensureSystemNodeDirect`
  reconciles the flag on existing documents, so current data flips to editable on next
  launch with no migration or data wipe; the title-reconcile guard only resets empty/legacy
  titles, so a custom workspace name survives restarts. (Direct merge to `main`, no PR.)

- **Appearance theme toggle: System / Light / Dark (PR #82)** — a new **Settings ›
  General** pane exposes a `SegmentedControl` (System / Light / Dark). Selecting calls
  `lin:set-theme` → the main process sets `nativeTheme.themeSource`, which rewrites every
  renderer's `prefers-color-scheme` so the already-shipped `@media (prefers-color-scheme:
  dark)` rules flip all windows at once (no CSS dark rules changed, no `[data-theme]`
  bridge). The choice persists in `userData/app-preferences.json` and is reapplied in
  `app.whenReady()` before the first window paints (no flash); it applies instantly (no Save
  button). Preload exposes a narrow typed `getTheme`/`setTheme`; the handler validates the
  mode before touching `themeSource`. Closes the `#45` item of design-system-rollout.
  ([#82](https://github.com/relixiaobo/lin-outliner/pull/82))

- **macOS packaging + real-Electron smoke suite (native-feel stage 6) (PR #81)** — a
  real-Electron Playwright smoke suite (`tests/smoke/` + `playwright.smoke.config.ts`) that
  launches the built main process against a throwaway `ELECTRON_USER_DATA_DIR` (prod
  `file://` renderer) and asserts native behaviors the Chromium e2e suite never covered:
  first-frame (no launch flash), native menu shape + `Preferences ⌘,`, CSP enforcement
  (inline-script `securitypolicyviolation`), external-link routing (`shell.openExternal`,
  `file:` never routed), and userData isolation (a real `create_node` mutation persists into
  the isolated dir and survives before-quit). Adds `test:smoke` + `mac.category`. macOS-only
  scope; smokes the built bundle's prod path, not the signed `.dmg`. Completes
  `native-feel-remediation` (all six stages shipped).
  ([#81](https://github.com/relixiaobo/lin-outliner/pull/81))

- **Rebrand: Lin Outliner → Tenon (PR #83)** — full product-identity change. New Tenon
  logo + generated Electron app icons, favicon, sidebar brand mark, and app/window/About
  titles; agent-facing identity copy updated. electron-builder `appId`
  `com.linoutliner.desktop` → `dev.linlab.tenon` and `productName` → `Tenon`, so the
  packaged macOS userData dir is now `~/Library/Application Support/Tenon/`; the system
  workspace title migrates `Lin Outliner` → `Tenon` (display-only, idempotent). All
  internal `lin:*` IPC channels, command names, storage keys, and `provider: 'lin'` are
  preserved — protocol surface unchanged. Dev `$HOME/.lin-outliner-*` override dirs are
  intentionally kept. ([#83](https://github.com/relixiaobo/lin-outliner/pull/83))

- **Unified inline reference foundation: `ReferenceTarget` (node | local-file) (PR #80)** —
  the inline-reference model is unified under one `ReferenceTarget` union so node
  references and local-file/folder references share a single grammar and codec.
  `InlineRef` carries `{ offset, target, displayName?, mimeType?, sizeBytes? }`; the
  marker grammar is `[[node:label^id]]` / `[[file:label^path]]` (value percent-encoded)
  parsed by one `referenceMarkup.ts`; a pure `referenceTargetToResourceItem` serializer
  builds the agent context resource. Local-file references are inline-only with
  path-as-identity (no id/registry/bookmark); backlinks and search stay node-only via
  `inlineRefNodeId`. Foundation for `lazy-like-global-launcher` and
  `agent-composer-attachment-path-model`. Pre-release format break — no migration or
  bare-marker back-compat; dev userData reset.
  ([#80](https://github.com/relixiaobo/lin-outliner/pull/80))

- **Native master-detail Providers settings + own provider-config window (PR #69)** —
  the agent **Settings → Providers** surface reworked to the macOS System Settings
  *interaction* idiom in our own tokens/B-rules. A reusable inset grouped-list primitive
  (`SettingsInsetList`) with content-aligned hairlines, region-by-colour, neutral
  selection/focus, and no row hover fill; Providers grouped **Connected / Available**
  with a brand-avatar identity, neutral status dot, a per-row `⋯` menu (only when a row
  has >1 action) and a trailing **Configure** button otherwise; back/forward category
  history reusing the shared chrome control. The per-provider config opens as its **own
  native window** — a frameless modal child of the settings window
  (`lin:open-provider-config`, `?surface=provider-config`), the System Settings
  attached-dialog idiom — hosting the connection only (credential + base URL inline,
  async non-blocking validate with cancel); it is multi-mode so OAuth / managed
  credentials plug in later. The settings window itself becomes frameless with the main
  shell's geometry (inset traffic lights, 24pt corner). Also fixes dark-mode switch
  thumb / checkbox check / `==highlight==` text rendering near-black. Security defaults
  (A3) match every other window. ([#69](https://github.com/relixiaobo/lin-outliner/pull/69))

- **Reference field type: read-only system reference rows + editable node picker
  (PR #71)** — node-reference field values now follow one model: the reference node
  is always full-featured (double-click edits the target, expandable) and only the
  value *container* differs. Read-only **References / Owner / Day** project synthetic
  read-only `reference` rows (computed render-time over the global reverse index, not
  core's incremental projection) whose set is read-only — no add, no delete — but
  whose rows still edit/expand their target. A new editable **`reference` field type**
  (`FieldType += 'reference'`; protocol command `add_field_reference`, append-any-node
  + deduped, rejects a non-reference field) makes a value draft a node-search box
  (`TrailingReferencePopover`); the typed query is never persisted as free text — a
  value only ever comes from a picked existing node. Also: system-field derivation is
  consolidated into `core/systemFields.ts`, and a node carrying a **Done** field
  auto-shows a synced row checkbox that is read-only on a locked owner (fixing the
  locked-node toggle crash). Removes the now-dead `.field-value-link`. Touches the
  protocol surface (`types.ts`, `commands.ts`) per the plan.
  ([#71](https://github.com/relixiaobo/lin-outliner/pull/71))

- **Field-row UX: name reuse + read-only system fields + Tab relocate (PR #70)** —
  typing a field name (or `Space` on an empty one) now offers a popover of existing
  user fields + built-in system fields to relink to, instead of always minting a
  fresh definition. Adds the protocol command `reuse_field_definition` (`commands.ts`;
  `types.ts` untouched) that repoints the entry's `fieldDefId`, drops the orphaned
  draft def, and clears stored value children when relinking onto a read-only system
  field; a node can't carry the same field twice (renderer-enforced dedupe). Read-only
  system fields now render by their real type — Created / Last-edited / Done-time as a
  date with a calendar glyph, Tags as navigable badges, References / Owner / Day as
  links, and Done as a checkbox that goes **read-only when the owner is locked**
  (fixing the "operation is not allowed on locked node" crash on daily-note date
  pages). And `Tab` / `Shift+Tab` on an empty trailing draft now **relocate** it (pure
  focus + expand — no create, no indent IPC) instead of materializing then indenting,
  removing the flicker and the stray empty node.
  ([#70](https://github.com/relixiaobo/lin-outliner/pull/70))

- **Native shell behaviors (PR-D)** — a standard macOS application menu
  (App / Edit / View / Window / Help) with **Preferences on `Cmd+,`** opening the
  settings window, plus a native right-click context menu (editing roles + spelling
  suggestions on editable fields, Copy on a selection) that fires only for the bare
  right-clicks the renderer's own command menus leave un-`preventDefault`'d, so it
  never double-pops over a custom menu. Dev-only View items (reload / devtools) are
  gated to source runs. Also adds the macOS inactive-window convention: when the
  window loses OS focus the two floating rails desaturate (rails-only, via a
  `window-active` IPC channel — never content, selection, or the rose accent). D6:
  the pre-paint backing colour is aligned to `--bg-window` (`#ececec`); D7: a spec
  note that the 24pt window corner is packaged-build-only.
  ([#68](https://github.com/relixiaobo/lin-outliner/pull/68))

- **Field values create on Enter (node-based field-value editors)** — a field
  value is now a plain outliner node: Enter in a field value materializes the
  trailing draft and appends the next value through the same draft, so "everything
  is a node" holds for field values too. The legacy `TrailingInput` /
  `TypedFieldValueControl` / `DateFieldControl` / `TrailingInputLeading` fork is
  removed; field-value editing flows through the unified `OutlinerItem` draft row
  with additive layers — `CheckboxFieldControl` (the one whole-field control),
  `DateValuePicker` (summoned by Space on an empty draft or a calendar
  affordance), and `TrailingOptionsPopover` (type-to-filter + `Create "x"`).
  Adds id-aware field-value commands (the renderer proposes the draft row's stable
  id so React identity / IME survive materialization, validated in core against
  shape + collisions) and a new `remove_field_value` command whose backspace-an-
  empty-value cleanup promotes an externally-referenced auto-collected value into
  the option pool instead of orphaning the reference. Touches the protocol surface
  (`src/core/commands.ts`, `src/core/types.ts`) per the coordination policy.
  ([#64](https://github.com/relixiaobo/lin-outliner/pull/64))
- A central accessibility layer (`styles/a11y.css`) honoring `prefers-contrast`, `prefers-reduced-motion`, and `prefers-reduced-transparency`, with a reusable `--material-backdrop` opaque-fallback token (PR-B, #63).
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

- **Workspace shell: tabs removed, split panes kept (PR #85)** — implements
  `workspace-tabs-to-single-pane.md`. The multi-**tab** concept is gone; the multi-**pane**
  split view stays and panes become the single top-level canvas primitive. `tabs[] +
  activeTabId` flattens to one `WorkspaceLayout { activePanelId, panels[] }`; tile `size`
  moves onto each panel (the parallel `panelSizes` map is deleted); localStorage bumps
  `:v1`→`:v2` (v1 dropped on load, pre-release). Hooks/flags renamed to tell the truth
  (`useWorkspaceTabs`→`useWorkspaceLayout`, `wantsNewTabFromClick`→`wantsNewPaneFromClick`,
  `NavigateRootOptions.newTab`→`newPane`). Default layout is a **single Today pane**;
  Cmd/Ctrl+click a reference opens a new split pane (replaces the rightmost root at the
  4-pane cap). The sidebar tree shows all root sections (Schema/Settings no longer hidden);
  right-click "Open" → "Open in split pane"; the node **Appearance** (icon/banner)
  context-menu item + submenu are removed (T4 — no UI entry point to set/clear a node
  icon/banner remains, by design). Review-gate hardening: debug-only canvas states no longer
  wipe the canvas (`navigateRoot`), silently drop an agent-debug session (`openPanel` at the
  cap now reverse-finds an outliner pane), boot into a rootless canvas (`sanitizeLayout`
  rejects an all-debug persisted layout), or mis-target page-history / Cmd+M (`activeOutlinerPanel`
  is strict; the ambient fallback drives only sidebar/drag). Net ~−990 lines; no `src/core`
  protocol change. Spec rewritten for the no-tabs model (`docs/spec/workspace-layout.md`, A6).

- **Sidebar / agent rail toggles use static `PanelLeft` / `PanelRight` icons (main)** —
  the two window-chrome rail toggles drop the open/close chevron-swap glyphs
  (`PanelLeftClose/Open`, `PanelRightClose/Open`) for one clean static icon per side;
  open/collapsed state reads from the deepened glyph colour alone (B6), not a glyph swap.
  The workspace-layout guard updated to assert the static glyph + colour-carried state.
  (main)

- **Agent composer is a flush input region, not a floating card (main)** — the
  composer surface drops its `--layout-gap` inset and `--agent-composer-radius`
  card: it is now full-bleed to the rail's side and bottom edges with a neutral
  `--fill-1` background, rounded TOP corners at the rail's own `--panel-radius`
  (the dock's `overflow:hidden` rounds the flush bottom to match), and uniform
  padding. Focus and drag deepen one neutral step to `--fill-2` — no border, no
  brand ring (B3). `design-system.md` (concentric chain + Agent component) and the
  composer geometry guard test updated to match. (main)

- **Provider model dropdowns rank by recency, not a static preferred list** —
  replaces the hand-maintained `PREFERRED_MODEL_IDS` allowlist (which sorted any
  unlisted model to the bottom via `MAX_SAFE_INTEGER`, silently burying Claude Opus
  4.8 / Sonnet 4.6 and keeping them out of the `models[0]` default) with a
  recency-first comparator in a new pure module `src/main/modelRanking.ts`. Ordering:
  product line (version-independent, only so a side line like `gemma-4` can't outrank
  the `gemini-3.x` flagship line) → numeric version desc (the recency signal —
  `gemini-3.5-flash` over `gemini-2.5-pro`, and `4-10` > `4-9`) → `reasoning` → clean
  alias before its dated snapshot → id. Price is deliberately unused (newer Anthropic
  models are cheaper + regional skew, so cost is anti-correlated with recency). The
  default now tracks the current flagship automatically and new model versions need
  zero code changes; the only human-maintained input is `MODEL_LINES`, whose staleness
  is caught by `findUnknownLineModels` + live-catalog guard tests
  (`tests/core/modelRanking.test.ts`).
  ([#67](https://github.com/relixiaobo/lin-outliner/pull/67))
- **Native-feel component pass (CSS-only, PR-C)** — tightens the chrome to the
  strict-native cursor/affordance policy across components. Field-value
  affordances and rail toggles now signal hover/active by deepening color
  (`background: transparent`, `transition: color`) instead of a `--fill-*` box
  (B6); the row bullet deepens its dot color on hover instead of `transform:
  scale` (B7, no layout shift); non-link controls (approval toggle/button, tag
  label) drop `cursor: pointer` so the pointing-hand cursor is reserved for
  content hyperlinks (A5/B10), pinned by a new `cursor-affordances` e2e guard;
  overlays move onto the tiered elevation tokens (menus level-1, dialogs/palette
  level-2, D3); agent chrome text is `user-select: none` (A8); and agent surfaces
  use the semantic `--text-secondary` token (D5). No DOM/behavior changes.
  ([#65](https://github.com/relixiaobo/lin-outliner/pull/65))
- **Upgraded the agent core (`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`) 0.75.4 → 0.78.0.** Brings Claude Opus 4.8 model metadata + Opus adaptive-thinking (0.77.0), a provider retry/timeout overhaul (0.76.0: `maxRetries` reliably honored, SDK retries default to 0, billing-429s no longer retried), `isContextOverflow` detection fixes, Anthropic-compatible replay fixes, and session-disposal abort of in-flight agent/compaction/retry/bash work (0.77.0). Underlying provider SDKs unchanged; only new transitive dep is `@smithy/node-http-handler@4.7.3`. Type-compatible (typecheck clean); no Lin call-site changes needed (we pass `SimpleStreamOptions.maxRetries` explicitly only when configured). ([#66](https://github.com/relixiaobo/lin-outliner/pull/66))
- **Field values no longer have a cardinality** — the single/list `FieldType`
  cardinality concept is removed end to end (`FieldCardinality`,
  `SCHEMA_CARDINALITIES_ID`, the `cardinality` config key/schema/projection, and
  the definition-config Cardinality control). Every value is a node and always
  appends; selecting an option appends a (deduped) reference rather than replacing.
  The done-state checkbox mechanism keeps its binary replace semantics explicitly:
  the forward mapping clears-then-selects, and the reverse mapping now drops the
  opposite-mapped option so a mapped field never holds both checked and unchecked
  at once (#64).
- Dark mode now follows the OS via `@media (prefers-color-scheme)` with `color-scheme: light dark` (native scrollbars/controls theme correctly; the `[data-theme]`+JS bridge and `theme.ts` were removed) (PR-B, #63).
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

- **System-node protection: `isSystemId` now covers Library and Recents** —
  `isSystemId()` (`src/core/core.ts`) omitted `LIBRARY_ID` and `RECENTS_ID`, so
  the Library section and the Recents saved-search were not treated as the
  authoritative system nodes the other sections are. Library was protected only by
  its `locked` flag, leaving `removeSubtreeDirect` (whose sole guard is
  `isSystemId`) able to hard-delete it, and `isSearchCandidate` wrongly surfaced
  Library/Recents as search results (unlike Daily notes / Schema / Trash /
  Settings). Both ids are now in the list, so they get the same structural
  protection (no move / delete / reparent) and search-exclusion as every other
  seeded section. (Fast-track, direct merge to `main`, no PR.)

- **Security: agent exfiltration redline + skill-shell ask path hardened (PR #79)** —
  the sensitive-data exfiltration hard block now recognizes opaque sinks (inline
  interpreter execution `python -c` / `node -e` / `perl -e` / `ruby -e` / `php -r`
  / `osascript -e`, and `ssh host '<cmd>'`) in addition to network-write verbs, so
  `cat ~/.ssh/id_rsa | python3 -c '...'` is a `platform_hard_block` instead of a
  downgrade to `ask`; `id_dsa`/`id_ecdsa` added to the sensitive-command patterns.
  Separately, the skill-shell permission path now routes `ask` decisions through
  the shared `resolveAgentPermissionAsk` (safe-allowlist + classifier-eligibility
  veto + unattended fail-safe) instead of jumping straight to the approval handler.
  Both changes only tighten policy. Resolves hardening item #3.
  ([#79](https://github.com/relixiaobo/lin-outliner/pull/79))

- **Agent dock header icons (＋ / bug) no longer read as blurry (main)** — they used
  `--text-faint` (ink/0.30), too low-contrast for their thin SVG strokes to resolve as
  crisp edges on the dark rail, while the 0.55 title text beside them looked sharp. They
  now share the window-chrome rail toggles' ink (`--text-secondary`, 0.55) at rest →
  `--text-strong` on hover. Not a glass/vibrancy rendering bug — a contrast one; no
  material change. The composer header guard updated to match. (main)

- **Agent dock header action icons drop the hover fill box + sit on a uniform pitch
  (main)** — ＋/bug hover/focus now only deepen the glyph colour (no `--control-hover`
  rounded-square fill), matching the rail toggles' colour-only chrome idiom (B6; focus
  ring unchanged). The right chrome zone's trailing gap is now `--space-2` (was
  `--space-4`), sliding the buttons one step toward the corner-anchored agent toggle so
  ＋→bug and bug→toggle land on the same 30px icon pitch. (main)

- **Agent composer attachment errors auto-dismiss (main)** — the inline attachment error
  is now a transient hint (`role="status"`, cleared after 5s) instead of a persistent
  banner, so the composer never carries a stale error. (main)

- **Agent dock collapse no longer janks (main)** — the rail collapsed by
  animating `width`/`top`/`right`/`bottom` (layout properties), so the transcript
  and composer re-wrapped every frame. It now slides off the right window edge via
  `transform: translateX` + `opacity` like the sidebar — a rigid GPU-composited
  layer move with no panel reflow. Glass material is applied unconditionally so it
  persists through the collapse fade instead of popping. (main)

- **Toggling Thinking no longer flickers the dock or jumps the model menu (main)**
  — two issues: (1) every model/reasoning change called `reloadSession`, which set
  the projection to empty and published it before re-fetching, flashing the whole
  transcript blank for a frame; a same-session reload now keeps the current
  projection on screen and swaps it atomically. (2) The model menu's reasoning row
  unmounted the 28px level button when Thinking was off, collapsing the row and
  jumping the menu height; the row now reserves the level-button height. (main)

- **Composer overflow scrollbar hugs the panel edge (main)** — the editor's scroll
  viewport was nested inside the surface's padding, so its native scrollbar floated
  ~12px inside the panel with empty padding to its right. The editor now breaks out
  of the horizontal padding (re-insetting its text to `--agent-content-x`) so the
  scrollbar sits at the panel edge like the transcript scroll (B10). (main)

- **Agent model menu uses the canonical menu radius (main)** — the model popover
  and its thinking-level submenu used `--radius-lg` (12) / `--radius-md` (8); they
  now use `--radius-overlay-sm` (10) like every other menu (session, context,
  settings). (main)

- **Agent composer footer controls are capsules, not rounded squares (B6)** — the
  send, attach, and model-selector controls were carrying the composer's 2px
  concentric-inset radius, so the filled send button read as a tiny rounded square
  and the model button's hover fill clashed with it. They now use `--radius-pill`:
  the 28px square icon buttons render as circles, the wide model button as a
  stadium, so every footer control shows the same corner arc (= half its height)
  and they line up. Codifies the systematic rule that interactive icon/pill
  controls are fully-rounded capsules, off the concentric *surface* radius chain
  (design-system.md + the composer layout guard test updated to match). (main)
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

- **Agent permission authority folded into spec (PR #78)** — new
  `docs/spec/agent-tool-permissions.md` is the authority for the shipped
  allow/ask/deny policy (evaluation precedence, platform hard blocks, bash
  classifier, ask resolution, sensitive-data redlines, fail-closed store, events,
  UI), with a *Known divergences* section recording shipped-vs-plan gaps verified
  against the implementation. `agent-tool-design.md` Approval Policy slimmed to a
  pointer; the spec README index and the hardening plan re-pointed at the new
  spec. ([#78](https://github.com/relixiaobo/lin-outliner/pull/78))
- **AGENTS.md reorganized to best-practice structure + on-the-loop model (PR #77)** —
  restructured per Anthropic CLAUDE.md guidance (a Commands section up front,
  load-bearing first, `Stack Constraints` folded into A1, userData / packaging /
  `tmp` compressed into one Dev environment section) and folded in the
  collaboration refinements: the PM ratifies a dev-drafted one-pager (on-the-loop,
  not in-the-loop), a what-NOT-to-escalate rule, collision self-check as the dev
  agent's job, explicit cross-agent autonomy boundaries, and mechanical
  review-gate / `significant` triggers. `docs/TASKS.md` drops the hand-maintained
  plan index — the active-plan catalog is derived from `docs/plans/*.md`
  frontmatter. ([#77](https://github.com/relixiaobo/lin-outliner/pull/77))
- **Collaboration-method model folded into `AGENTS.md`; docs restructured (PR #76)** —
  the agreed PM-led parallel-planning model lands in `AGENTS.md`: the main agent
  is the end-stage gate (no up-front framing), with a review-gate table, a WIP
  cap (2 significant changes), a Draft-PR-as-claim collision radar, a
  document-system table, and the plan status legend. `docs/TASKS.md` becomes the
  single live board (folds the deleted `docs/plans/README.md` active-plan index;
  adds the `anti` clone). The 15 terminal plans move to `docs/plans/archive/`;
  the shipped status word is unified to `done`; test fixtures move under
  `tests/fixtures/`; stale references in the READMEs, active plans, and src
  comments are repointed. ([#76](https://github.com/relixiaobo/lin-outliner/pull/76))
- **Agent + launcher planning docs (PRs #72–#75)** — added the
  `agent-self-modification` controlled-self-maintenance plan plus cc-2.1-aligned
  spec guidance (#72), an OAuth agent self-configuration boundary in
  `agent-oauth-providers` (#73), the `lazy-like-global-launcher` plan (#74), and
  the `outliner-local-file-references` plan (#75). Docs-only.
  ([#72](https://github.com/relixiaobo/lin-outliner/pull/72),
  [#73](https://github.com/relixiaobo/lin-outliner/pull/73),
  [#74](https://github.com/relixiaobo/lin-outliner/pull/74),
  [#75](https://github.com/relixiaobo/lin-outliner/pull/75))
- Removed the ~1.3k-line legacy `TrailingInput` editor (plus `TrailingInputLeading`) — its trigger paths (`#`/`@`/`/`/`>`/code/checkbox/image) are re-implemented as atomic-create branches on the `OutlinerItem` trailing draft, collapsing the two-ProseMirror-editor fork to one. Removed the now-dead `resolveTrailingRow*` interaction resolvers. Fixed a focus-propagation bug where a command-outcome focus request (`panelId: null` wildcard) failed the row memo's `targetsRow` predicate and dropped focus to `<body>`; added `focusAncestorToken` so a memoized ancestor re-renders to pass a focus/pending-input request down to a nested target (#64).
- Re-armed the design-system guard e2e specs after the CSS split and floating-rails shell redesign: the typography-tokens guard now globs `src/renderer/styles/*.css` and the workspace-layout spec asserts the shipped DOM; page-title sizing corrected to 24px/32px (PR-A, #62).
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
