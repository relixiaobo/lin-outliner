# Tasks

Single source of truth for in-flight and upcoming work across the three
clones. **Owned by the main agent** (`lin-outliner/`). Dev agents
(`lin-outliner-cc`, `lin-outliner-codex`) read this but do not edit it — the
main agent updates it on merge.

`docs/plans/` holds the detailed design for each item; this board is the
short, current view of who-is-doing-what. See `AGENT.md` / `CLAUDE.md` for the
workflow.

## Agent status

| Agent | Clone | Active branch | Current task |
|-------|-------|---------------|--------------|
| main | `lin-outliner/` | `main` | Review / merge / integration |
| Claude Code | `lin-outliner-cc/` | — | idle |
| Claude Code 2 | `lin-outliner-cc-2/` | — | idle |
| Codex | `lin-outliner-codex/` | — | idle |

## In progress

- **agent-past-chats** (P1, Codex) — `past_chats` recall tool (recent + search
  + read) backed by the event store. Recall tool and tool-UI polish landed
  (PRs #1, #4); see `docs/plans/agent-past-chats.md` for remaining scope.

## Backlog

Ordered by priority; lower items may depend on higher ones.

- **design-system-rollout** (P1) — staged migration to `docs/spec/design-system.md`.
  Phase 1 (token foundation + gated dark theme) landed (PR #55). Phases 2–4 landed
  in PR #57: CSS modularized into per-surface modules; components migrated to the
  alpha-on-ink token layer; `--primary*` neutralized + deleted; inline-ref
  blue→rose; dark follows the OS via `theme.ts`; floating-rails shell
  (`WindowChrome` + per-pane breadcrumbs + sidebar-as-tab-switcher). Remaining:
  persisted in-app light/dark/system toggle via `nativeTheme.themeSource` (#45);
  light-mode + interaction (unfurl / drag / resize) visual pass (verified dark
  only at merge); real OS vibrancy tuning. See
  `docs/plans/design-system-rollout.md`.
- **agent-oauth-providers** (P2) — OAuth sign-in (Anthropic Pro/Max, GitHub
  Copilot, OpenAI Codex) + managed credentials (Bedrock AWS, Vertex ADC) for the
  provider settings: credential storage, Electron-main login over IPC, view-model
  `authKind`, sign-in / connected / sign-out UI. Lightweight UI fix shipped in
  #37; see `docs/plans/agent-oauth-providers.md`.
- **file-attachments** (P1) — `attachment` node type for arbitrary local files
  (plugs into `BlockNodeRow` via `renderBlockBody` + `isBlockNodeType`).
- **media-types** (P2) — audio/video players + PDF thumbnail on the
  `BlockNodeRow` shell; `serve()` needs a streaming/range response for large
  media (current whole-file read is image-only).
- **asset-gc** (P2) — asset `index.json` rebuild + garbage collection for
  orphaned assets; drag-from-Finder ingest; inline alt-text editing.
- **agent-image-awareness** (P2) — surface `image` nodes in the agent
  projection so the agent can read/insert them.
- **floating-toolbar-polish** (P3) — heading-mark toggle + `#` selection
  extract in the floating editor toolbar.
- **view-toolbar-name-filter** (P3) — quick incremental name filter as the
  view toolbar's first control (Tana-style); needs backend/data-model support.
  Optional follow-ons: `is_not` for options filters; relative-date operands.
- **node-line-editor-unification Phase 2b** (P1) — route trigger application
  through `resolveTargetId` so `#`/`@`/`/` behave identically across the inline
  editor and the trailing line, unify the trigger popover on `NodePanel`, and
  delete the trailing input's bespoke `onApply*Trigger` props. High-risk
  reconciliation of the hot node-creation path; verify with the app running
  against the `outliner-*` Playwright e2e specs. Build contract:
  `docs/plans/node-line-editor-core-design.md` (PR #13). Phase 1 (#11),
  Phase 2a view helpers (#12), and the eager-materialized trailing draft +
  step-1 trigger/keymap extraction (#16) shipped; the `resolveTargetId`
  trigger-application unification remains.
- **checkbox-row-long-text-wrap** (P3) — a done-checkbox row wraps its text onto
  the next line when the text is long (checkbox sits alone on line 1). Root cause:
  in `.row-content-line` (display: block) the `.done-checkbox` and `.row-editor`
  are inline-level siblings, and the editor's `max-width: 100%`
  (`outliner.css:1805-1817`) is relative to the full line width without
  subtracting the ~21px the checkbox takes — so once long text pushes the editor
  to its max-width, `checkbox + editor > 100%` and the editor wraps below.
  Fix options: (a) switch `.row-content-line` to `display: flex; align-items:
  flex-start` with the editor `flex: 1; min-width: 0` (cleanest, but must give
  `TagBar` / `NodeDescription` `flex-basis: 100%` since they currently rely on
  block flow to wrap below); (b) minimal — `.row-content-line:has(> .done-checkbox)
  > .row-editor { max-width: calc(100% - 21px); }`. Prefer (a); verify visually
  with a long-text checkbox row.
- **embed-strategy** (P3) — decide live iframe vs cached-metadata embeds.
- **past-chats-output-polish** (P3) — minor cleanups deferred from PR #7:
  (1) drop the now-redundant `returned_items` / `returned_hits` / `message_count`
  counts in `visiblePastChatsResult` (derivable from the inline arrays);
  (2) avoid `isJsonText` re-parsing on every render in `AgentToolCallBlock`
  (compute once in the memoized `resultParts`); (3) give `visiblePastChatsResult`
  a named return type instead of `unknown`. None affect behavior.

## Recently completed

- **agent-tool-permissions implementation** (codex) — built the full
  `docs/plans/agent-tool-permissions.md`: action descriptors + global JSON
  permission store (`permissions.allow`/`ask`/`deny`) with fail-closed
  load/save validation; platform hard blocks evaluated before any allow rule
  (exfiltration, credential/`.git/hooks`/persistence writes, payment,
  permission self-modification, unknown shell); bash classifier with
  most-restrictive-segment compound handling; classifier-backed `ask` resolver
  gated by `classifierAutoAllowEligible` (default false, can never auto-allow
  high-consequence/outward/sensitive); composer approval card, permission
  center UI, structured `permission_denied` results, and
  `tool.permission.checked`/`resolved` events. Deep multi-agent review found and
  confirmed-fixed 1 critical + 4 high bash-classifier/validator fail-opens
  before merge (`find -exec`/`-delete` & `sed -i` no longer auto-allow;
  `ssh`/`npm`/`pnpm`/`yarn`/`bun`/`npx`/`bunx`/`tsx` allow rules rejected;
  capability deny no longer over-advertised). typecheck clean, permission tests
  30/0. Non-blocking follow-ups remain (sessionApproved ordering,
  `parseGlobalToolPermissionSettings` pre-shaped early-return, interpreter-stdin
  exfil sinks, dual `approval.*`/`tool.permission.*` event vocabulary,
  denied-reason literal naming). (PR #60).
- **agent-tool-permissions plan** (codex) — new authoritative agent permission
  plan (`docs/plans/agent-tool-permissions.md`): one global runtime-owned policy
  (allow/ask/deny by action kind), platform hard blocks, a classifier-backed
  `ask` resolver bounded by a `classifierAutoAllowEligible` descriptor gate,
  fail-closed rule validation (arbitrary-code shell-prefix denylist + agent-spawn
  allow ban), sensitive-data exfiltration redlines, and a defined
  interactive/unattended fail-safe. Supersedes and shelves the two earlier P0
  drafts (`agent-permissions.md`, `agent-reversible-execution.md`). Refined on
  merge against the cited cc-2.1 source (precedence, borrowed validation rules,
  classifier-callable vs auto-allow-eligible terminology). Implemented in #60. (PR #59).
- **macOS window corner radius** (cc) — standard macOS window gets a custom 24pt
  continuous corner (matching Raycast) while keeping native traffic lights, OS
  shadow, vibrancy, and live resize. A zero-dependency Node-API addon
  (`native/window-corner/`) drives the corner via the private `_cornerRadius` /
  `_effectiveCornerRadius` selectors on macOS 26 Tahoe (`_cornerMask` is ignored
  there) with a `_cornerMask` fallback on older macOS; frost rounded via
  `NSVisualEffectView.maskImage`. Loader is a silent no-op off-darwin / unbuilt;
  `app:build` runs `build:native` and ships the `.node` via `extraResources`.
  Inner concentric-corner alignment of design-system surfaces is out of scope
  (separate branch). (#58)
- **native-feel stages 2–5b + renderer perf** (cc) — serially merged the stacked
  native-feel remediation program on top of the stage-1 security shell: startup
  first-frame / window-state restore / single-instance (#45); strict-native
  cursor policy + system-font-first stack (#46); macOS vibrancy / Windows mica
  window material (#47); in-app dialogs replacing `window.prompt`/`confirm` via a
  shared `ConfirmDialog` (#48); settings in their own native window over a
  `?surface=settings` marker (#49); opt-in `LIN_TRACE_IPC` instrumentation that
  proved serialization was cheap (#50), redirecting the perf work to incremental
  O(touched) Core state + projection caches (~770ms→0.27ms keystroke at 1000
  nodes, public contract unchanged) (#52); and a renderer perf line (per-node
  `renderRev` memo, per-row focus memo replacing global `uiGen`, opt-in windowed
  flat view, default OFF) (#54). The stage-4 native right-click `Menu` was
  dropped by decision. #54 was reconciled against the already-merged #53 keyboard
  work (one positional conflict in `OutlinerItem.tsx`, both additions kept). #46
  landed as a direct `main` commit — its PR branch was force-pushed after an
  accidental close during the serial merge, which blocked reopening it. The
  remediation plan doc landed in #44 (`docs/plans/native-feel-remediation.md`,
  still `in-progress` — stage 6 packaging/smoke remains).
- **keyboard-shortcut-parity** (codex) — nodex shortcut audit plus the
  remaining gaps: empty-selection `Cmd/Ctrl+A`, scoped `Cmd/Ctrl+Shift+D`
  go-to-today (vs batch duplicate), panel nav history on `Cmd/Ctrl+[`/`]` and
  `Alt+Arrow` (document undo/redo kept on `Cmd/Ctrl+Z`), and a keyboard-driven
  selected option-reference menu (Arrow/Enter/Escape). Audit confirmed
  drag-select and click-away dismissal already shipped. New/changed bindings
  live in `shortcutRegistry.ts`. See `docs/plans/keyboard-shortcut-parity.md`
  (PR #53).
- **agent permission approvals** (codex) — agent tool permission decisions
  evolved from boolean to `allow | ask | deny`, computed in TypeScript policy.
  High-consequence bash/file actions (external GitHub mutations, package/deploy/
  publish, db migrations, background commands, sandbox overrides, sensitive-path
  access, unscoped recursive deletes) suspend and request approval; machine
  destruction, RCE pipes, shell obfuscation, and sensitive-data exfiltration are
  redline `deny`. `ask` routes through `requestToolApproval` (composer card,
  subagent + skill-shell bubbling, pending-request queue, session-scoped allow
  rules) and is recorded as `approval.requested`/`approval.resolved`. Bundled
  with two same-thread follow-ups: inline Markdown formatting shortcuts while
  typing (`code`/bold/strike/highlight/link + code-boundary arrow nav) and a
  wording/styling cleanup (design-token code styling, simplified agent/tool
  copy keeping the `Lin Agent` identity). Plan: `docs/plans/agent-permissions.md`
  (now `shelved`; superseded by `docs/plans/agent-tool-permissions.md` in #59 —
  the runtime `allow | ask | deny` machinery shipped here is what that plan
  builds on). (PR #51).
- **native-feel stage 1: security shell** (cc) — main process now owns the
  renderer's navigation + capability surface: `setWindowOpenHandler` denies
  child windows (http(s) → OS browser), `will-navigate`/`will-redirect` lock the
  renderer to its own document, permission handlers deny all but
  `clipboard-sanitized-write`, and a strict prod CSP is injected on the
  `file://` main-frame (scoped past the agent web-fetch windows). Stage 1 of a
  multi-stage native-feel remediation program; remaining stages (startup/window
  state, vibrancy/native chrome, native menu, IPC envelope, packaging + smoke
  tests) are scoped in PR #43's description and still need a `docs/plans/` doc.
  (PR #43).
- **config-as-nodes + Node union refactor** (P1, cc) — definition config moved
  off flat `Node` fields into per-definition `defConfig` subtrees (value =
  child node/reference, read via accessors over `buildConfigIndex`, written via
  the `setConfigValue` chokepoint); the ~57-field god-record `Node` became a
  discriminated union of per-type variants over `NodeBase`; done-state two-way
  mapping (#15) + non-blocking min/max warning (#16); `FieldType` slimmed 13 → 8;
  options fields accept free-typed values and render as inline rows; supertag
  color is a token-based swatch picker. Review found and fixed three correctness
  issues pre-merge (stable `defConfig` ids on clone, `searchResult` refRole on
  result refs, `outlinerChildren` config exclusion). See
  `docs/plans/config-as-nodes.md` (PR #18).
- **settings-refactor** (P2) — reorganized the agent Settings dialog into three
  categories (Providers / Skills / Agent Profiles). Providers infer credential
  state automatically ("Set as Active" replaces the enablement toggle from #38;
  status dot green = active / soft = configured), the API key field gains a
  remove action, Base URL moves back into an "Advanced Settings" disclosure, and
  a "Test Connection" button reports classified diagnostics. Skills and Agent
  Profiles tabs add per-item enable/disable (`disabledSkills` / `disabledAgents`,
  enforced at listing + invocation/spawn) plus global behavior switches and a
  read-only agent persona detail card. New IPC: `agent_list_all_skills`,
  `agent_list_all_definitions`, `agent_test_provider_connection`. Post-merge
  follow-up unnested the agent-row toggle from the select button and dropped a
  dead dot rule (PR #42).
- **settings-provider-add-and-search** (P2, cc) — moved the "Custom provider" add
  affordance from a bottom pinned row to a compact "+" button beside the provider
  search (active when the custom draft is open), and made the model search expand
  in place inside the "Models N" header (icon → inline field with close) instead
  of opening a separate row below (PR #40).
- **settings-provider-layout-and-icons** (P2, cc) — provider detail polish: dropped
  the single-field "Advanced" disclosure (Base URL inline), un-collapsed the model
  catalog (inline list with a search-icon toggle next to the "Models N" heading,
  shown only for >1 model), and replaced monogram avatars with vendored brand logos
  (color variant where available, mono mark otherwise; monogram fallback for
  unmapped/custom). Icons MIT-vendored from `@lobehub/icons-static-svg`, no dep
  added (PR #39).
- **settings-provider-enablement-list** (P2, cc) — "Enabled" gated on a credential
  (toggle disabled without a key; pasting a key auto-enables; save persists the
  effective state), provider-list enablement dot (green = on / hollow = off),
  design-system search box, and background-fill selection instead of an outline
  (PR #38).
- **settings-provider-auth-classes** (P2, cc) — OAuth (GitHub Copilot, OpenAI
  Codex) and managed-credential (Bedrock AWS, Vertex ADC) providers show a
  credential note + docs link instead of a misleading "Paste key" field. Full
  OAuth sign-in specced in `docs/plans/agent-oauth-providers.md` (PR #37).
- **settings-provider-declutter** (P2, cc) — design pass: API key is the hero;
  Base URL → collapsed "Advanced" disclosure, read-only models → collapsed
  "Models (N)" disclosure; dropped the dialog subtitle, duplicate "Providers"
  heading + floating caption, and the "ADD KEY" badge. Custom keeps Provider ID +
  Base URL visible (PR #36).
- **settings-provider-detail-polish** (P2, cc) — provider detail feedback: Enabled
  becomes the shared switch toggle, API key moves above Base URL (Optional),
  "Remove key" shows only when a key is saved (danger link), and a read-only
  catalog model list (name/id/reasoning/context + search for large catalogs) is
  added. Per-model enable/fetch deferred (needs backend) (PR #35).
- **settings-provider-list-polish** (P2, cc) — follow-up to the three-pane
  Providers settings for the real ~32-provider catalog: provider search box,
  pinned "Custom provider" entry, acronym-aware display names (Azure OpenAI /
  Cloudflare AI Gateway / GitHub Copilot), and status dots only for meaningful
  states (PR #34).
- **settings-providers-three-pane** (P2, cc) — Providers settings reworked toward
  the shared reference (Cherry Studio): three panes (nav | provider list | detail),
  monogram avatars + status dots, a status badge + data-driven description in the
  detail header, an API-key reveal toggle, a "Get your <provider> API key" docs
  link, and an optional Base URL for every provider (default-endpoint placeholder)
  with Provider ID custom-only. New optional `AgentProviderOption.defaultBaseUrl`.
  Provider search / model fetch / autosave left out of scope (PR #33).
- **settings-provider-choice-cleanup** (P3, cc) — self-review follow-up to #31:
  drop the unread `modelId` / `custom` fields from the Settings dialog's
  `ProviderChoice` (nothing consumed them). Behavior-preserving (PR #32).
- **settings-window restructure** (P2, cc) — the "Agent settings" dialog became
  a "Settings" window with a left category nav: **Providers** (connection only —
  provider row list incl. a Custom OpenAI-compatible entry, one key + status,
  Enabled; Provider ID / Base URL only for custom) and **Agent** (model +
  reasoning defaults, permission mode, skills, directories). Separates "where it
  connects" from "how the agent runs"; nav is extensible for Appearance/General.
  Backend commands and the composer model menu unchanged (PR #31).
- **sidebar system-icon cleanup** (P3, cc) — the workspace tree drops hardcoded
  fallback glyphs for system nodes (calendar on Daily notes, plus library /
  search / trash), rendering only a node's own icon. Top primary-nav shortcuts
  keep their icons (PR #30).
- **day-node title humanization** (P3, cc) — daily-note panel titles show a
  humanized read-only label (`Wed, May 27`, prefixed `Today` / `Tomorrow` /
  `Yesterday` for adjacent days) instead of the raw ISO date, and the date
  header calendar icon is removed. Display-only over the locked `YYYY-MM-DD`
  node; the docked breadcrumb reuses the same label. nodex-style (PR #29).
- **code-fence row shortcut** (P3, cc) — typing a bare `` ``` ``/`~~~` that owns
  a plain row converts it to an empty `codeBlock` (drops the fence text), fired
  the instant the row text equals the fence via a guarded `create_code_block`
  resolver action + `RichTextEditor` `onCodeFenceFire`; gated to plain content
  rows, focuses the new code editor, draft materializes first (PR #28).
- **local-file-mentions** (P1, Codex) — the agent composer `@` menu now mixes
  recent nodes, local files, folders, and live file search (Spotlight `mdfind`
  on macOS, `rg` fallback); selections render as inline tokens with native
  icons/thumbnails/hover previews. Model-facing text keeps position via
  `[[file:<ref>]]` markers, and the hidden `<user-attachments>` table maps each
  `ref` to path/kind/MIME/size; folders are symlinked into the local root for
  `file_glob`. Trashed nodes are excluded from `@` suggestions (PR #21).
- **node-line-editor eager-materialized trailing draft** (P1, cc) — typing in
  the trailing blank line materializes a real node in place (IME-seamless, no
  remount) under a client-proposed id; create + first edits collapse into one
  undo step. Includes step-1 shared trigger detection + structural keymap
  resolvers, draft-mode `OutlinerItem`, and fixes for leading-inline-ref
  backspace and merge-into-reference conversion. Main outliner only (PR #16).
- **node-line-editor-unification Phase 2a** (P1, cc) — shared `nodeLineView.ts`
  view helpers (`caretAnchor`, `selectionTextOffsets`, unified inline-ref-aware
  `selectionForPlacement` / `applyCursorPlacement`); `RichTextEditor` and
  `TrailingInput` both delegate. Behavior-preserving, unit-test-pinned (PR #12).
- **node-line-editor-core-design** (P1, cc) — Phase 2b build contract doc:
  drop the monolithic `useNodeLineEditor` hook in favor of shared pure modules,
  route trigger application through `resolveTargetId` (PR #13).
- **agent-composer-inline-references** (P1, Codex) — replace the agent composer
  textarea with a ProseMirror editor: slash commands, inline node references
  (rendered consistently in user/assistant/tool output with Cmd/Ctrl-click
  open-in-new-tab), inline file references, paste/drop + native-picker file
  attachments (sent inline as base64 to the model via `lin:pick-local-files`;
  distinct from the persisted asset store). Adds `core/nodeReferenceMarkup`
  and tightens agent node-tool visibility/guidance (PR #15).
- **node-line-editor-unification Phase 1** (P2) — shared `classifyMediaPaste`
  classifier for the image / media-URL / link-URL paste front-matter; both
  `RichTextEditor` and `TrailingInput` call it, deleting duplicated paste
  routing. Behavior-preserving (PR #11).
- **media-url-sources** (P1) — `image` nodes now take exactly one of a local
  `assetId` or a remote `mediaUrl`; `mediaSource()` resolves either for the
  view. Pasting a lone http(s) image URL makes a remote image node (with a
  selection it links the text instead). Renamed the protocol `lin-asset://` →
  `asset://` (centralized in `core/assets.ts`; no data migration — only the
  bare id persists). `mediaUrl` is validated http(s) at the core boundary and
  `open_external_url` (PR #10).
- **asset-subsystem + image-rendering** (P0/P1) — local asset store
  (`assetService`: ingest/lookup/serve/delete, MIME sniff, dimension probe,
  path-traversal-safe ids) behind a privileged `asset://` protocol, plus
  inline `image` nodes on a reusable focusable `BlockNodeRow` shell (the
  foundation future media types plug into via `renderBlockBody` +
  `isBlockNodeType`). Clipboard paste + `/image` picker ingest; hover toolbar
  (caption / lightbox / open-original); caption = node description (PR #8).
- **view-toolbar-redesign** (P2) — per-node view toolbar reworked against
  Tana: inline panels → anchored popovers (no row-list shift), removed the
  fake Table/Cards/Calendar "View as" switcher, progressive type-aware filter
  editors (boolean/options/date/number/text), date-aware `rowMatchesFilter`,
  field-semantic group labels / sort directions / active-state summary, plus
  token-correct controls (PR #9).
- **paste-handling** (P2) — structure-aware clipboard paste: inline marks,
  fenced code → `codeBlock`, rich HTML routing, single-line URL linking
  (PR #5).
- **code-block-editor** (P2) — dedicated `codeBlock` editor with Shiki
  highlighting, language picker, horizontal scroll, cross-row selection
  (PR #2).
- **agent-past-chats** groundwork — recall tool + transcript UI (PRs #1, #4).
  past_chats now returns one self-contained JSON; tool-call JSON is
  Shiki-highlighted and renders identically live vs. reloaded (PR #7).
- **dev-workflow** — three-clone hub model (main + cc + codex), merge gating,
  this board.
