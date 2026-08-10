# Global Launcher

Current shipped behavior of the Spotlight/Raycast-style global launcher. The
forward-looking design and the deferred features live in
[`../plans/archive/lazy-like-global-launcher.md`](../plans/archive/lazy-like-global-launcher.md)
and its split plans (`launcher-ai-actions.md`,
`launcher-capture-destinations.md`, `launcher-provider-expansion.md`,
`reference/browser-extension-integration.md`). This document describes only what exists.

## What it is

A separate, locked-down renderer (`launcher.html` → `src/renderer/launcher/`)
running in its own prewarmed `BrowserWindow`, talking to the main process over a
small IPC surface. It is NOT the editor — the launcher bundle never loads
ProseMirror/Shiki/markdown. One global hotkey toggles it; it captures what the
user was looking at, searches document nodes inline, and runs a couple of
navigation commands.

## Window (`src/main/launcher/launcherWindow.ts`)

- **Prewarmed singleton.** Created hidden at startup and shown/hidden on the
  hotkey — never recreated, so the hotkey-to-visible path is a native `show()`.
  `backgroundThrottling: false` keeps the hidden renderer painting-ready.
- **macOS NSPanel** (`type: 'panel'`, `alwaysOnTop` at `'floating'`): a
  non-activating floating overlay that can take key focus for typing without
  activating the app. It joins all Spaces (incl. other apps' full-screen) via
  `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true,
  skipTransformProcessType: true })`. The all-Spaces behavior would otherwise
  transform the app's process type to `UIElementApplication` (accessory), which
  **hides the macOS dock icon** (and the ⌘Tab entry) — electron#26350;
  `skipTransformProcessType: true` is Electron's purpose-built option to suppress
  that transform, so the **dock icon + ⌘Tab entry survive** while the launcher
  floats over fullscreen.
  The level is `'floating'`, **not** `'pop-up-menu'`: macOS presents the
  **input-method candidate window** at about the pop-up-menu level, so a launcher
  pinned there sat at the same level and — `alwaysOnTop` continually re-asserting
  the front — covered it. A CJK user saw the composition underline with no
  candidate list to choose from (only a sliver of the highlighted first candidate
  escaped past the panel's left edge), which made Chinese/Japanese/Korean input
  unusable. `'floating'` still sits above ordinary app windows, and the
  all-Spaces / over-fullscreen behavior comes from `setVisibleOnAllWorkspaces`,
  not from this level. The behavior is toggled **only while visible** — set on
  `show`, cleared on `hide`. (The separate "first ⌘Q needs two presses" bug is NOT
  caused by the launcher — it is the app's `before-quit` flush handler in
  `main.ts`, which now `process.exit(0)`s after the flush instead of re-issuing a
  graceful `app.quit()` that lingered for seconds.)
- **Fixed golden rectangle** (760 × ~470), top-biased placement (0.18 of the
  work area) on the display under the cursor; never resizes to its result count
  (the body scrolls). Native 16px corner via the `window_corner` addon.
- **Liquid-glass** surface: transparent window over `vibrancy: 'hud'`; the
  renderer keeps the surface transparent and tints it with functional fills.
  Reduce-Transparency drops to an opaque elevated surface (see
  [`design-system/foundations.md`](./design-system/foundations.md#materials--liquid-glass)).
- **Show sequence** (`showLauncherWindow`): `showInactive()` first (so the
  previously-frontmost app keeps focus while context is read), run the
  `beforeFocus` hook, then `show()` + `focus()` and send `LAUNCHER_SHOWN_CHANNEL`.
  The captured context lands **after** that, over `LAUNCHER_CONTEXT_CHANNEL`, so
  the window is already interactive before the top row becomes the capture row.
  Enter in that gap runs whatever row is showing — see *Known gap* below.
- **Dismiss.** The hotkey toggles; Esc, clicking away (window `blur`), running a
  command, capturing, or opening a node all hide it. Every hide routes through
  `dismissLauncher()` in `main.ts`, which also forgets the captured context and
  bumps the open-sequence (so a slow in-flight capture for a dismissed open is
  dropped). Dev escape hatch: `LIN_LAUNCHER_NO_BLUR_HIDE=1` keeps it open while
  devtools steal focus.

## Security posture (A3 — must not regress)

- Launcher `webPreferences`: `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, the shared locked-down preload bridge.
- `hardenWebContents` is applied: `setWindowOpenHandler` denies popups and routes
  only `^https?://` to `shell.openExternal`; `will-navigate`/`will-redirect` are
  fenced to app-document URLs.
- Packaged launcher loads via `loadFile` (`file://`), so the renderer CSP applies.
- It shares `defaultSession`, inheriting the permission allow-list
  (`clipboard-sanitized-write` and `fullscreen` only).
- **No remote-content webContents.** Capture reads basic info via JXA / AppleScript
  / the Accessibility addon — no web page is ever loaded into an Electron
  webContents, so there is no remote-content surface to harden.

## Hotkey (`src/main/launcher/launcherHotkey.ts`)

Registers the first free accelerator of `LIN_LAUNCHER_HOTKEY` (env) →
`CommandOrControl+Shift+Space` → `Control+Alt+Space`. The winner is surfaced to
the renderer via `launcher:getInitialState().hotkey` (or `null` if none was free).
Released on quit.

The registered accelerator is **shown**, in two places, both formatted by
`formatHotkey` (`src/core/launcher/commands.ts` — one formatter, two surfaces):

- the launcher footer's identity zone, so a user who arrived by mouse (the
  sidebar's Search row) learns the keystroke;
- **Settings → General → Shortcuts**, a read-only "Global launcher" row fed by
  `window.lin.getLauncherHotkey()` over `ipcMain.handle('lin:launcher-hotkey')`.
  When registration failed (`null` — every candidate is taken by another app) the
  row states that, quietly, in secondary text with the fix ("Quit the conflicting
  app and relaunch Tenon"), and the footer simply shows no keystroke. Registration
  itself stays main's; neither surface can rebind.

## The modeless model (`src/renderer/launcher/`)

ONE always-focused input is simultaneously a **command filter**, a **live node
search**, and a **live capture draft** — there is no mode and no "pick New Capture
first" step. The result list is built purely by `buildLauncherItems` (in
`launcherModel.ts`, unit-tested without a DOM) from `(query, context, nodes,
commands)`, rendered as a single **flat** list of uniform rows
(`glyph · title · subtitle · right-aligned type label`, such as `Node`, `File`,
`Page`, or `App`). No section headers.

Ordering is **capture-first**:

- **Page context + typed text** → a `capture-page` row (title "Capture") that
  captures the page with the typed text nested **under** the captured node as a
  child bullet (not the node description), then a `capture-note` row ("New node")
  as the escape hatch to make the text its own standalone node instead.
- **Page context, no text** → a single `capture-page` row.
- **No context, typed text** → a `capture-note` row ("New node") in Today.
- Then matching document nodes, then the filtered commands.

Each row has exactly **one** action today (`actions[0]`, what Enter runs). The
`actions[]` array shape is kept so secondary actions return additively; there are
no disabled "coming soon" placeholders. Selection is tracked by row **identity**
(not index), resets to the top row on typing, scrolls into view on arrow nav, and
is single-shot (a re-entrancy lock prevents double-fire). The input is an ARIA
combobox over the result `listbox` (`aria-activedescendant` follows selection).
The list is never empty — a query always synthesizes a capture row and an empty
query always lists the static commands — so there is no empty state.

**Composition keys never drive the launcher.** While an IME composition is
active (`isImeComposingEvent`, the shared guard in
`src/renderer/ui/interactions/imeKeyboard.ts`), Enter, ArrowUp/Down and Escape
belong to the IME: committing a pinyin candidate with Enter does not run the
active row, arrows do not move the selection, and Escape does not hide the
window. A second Escape after the composition ends still hides.

**The input keeps focus through every click.** Both the result rows and the
footer's primary hint `preventDefault` on `mousedown`, so clicking a row never
blurs the always-focused input — visible on the capture-failure path, where the
launcher stays open for a retry.

### Enter is synchronous, and the top row is never the wrong subject

Enter runs the row that is showing. That is safe because main creates the
invocation **synchronously** for each summon, with its empty-query generation
already `ready` and its ambient slot `pending`: the stable objects are legal
subjects before the first keystroke, and the page arrives later as its own chip
rather than by reordering what Enter would hit.

The earlier renderer-side wait for context was built and removed — holding Enter
across an await opens a window in which the user can dismiss, click another row,
re-open or keep typing, and the resumed continuation knows none of it. The fix
belongs where the ambiguity is created, and it is now there. See
[`action-registry.md`](action-registry.md).

## Capture (basic-info only)

Capture reads URL + title + frontmost app and classifies the provider **from the
URL** — no in-page body/transcript/selection extraction, and **no network access on
this path at all**: `captureExternalContext` runs on every hotkey press, so a fetch
here would be one silent outbound request for whatever page the user is looking at.
Reading page content is **not built**; when it is, it will be a separate explicit
API invoked only after the user picks an action, never on this path
(`docs/plans/unified-command-surface.md`). No browser extension is involved.
Orchestrated by `captureExternalContext`
(`src/main/context/contextCapture.ts`): frontmost app via JXA NSWorkspace, the
active tab via the Accessibility addon (authoritative, by PID) with an AppleScript
front-tab fallback. The AppleScript spawn is skipped when the AX read already
returned both URL + title (its output would be unused); it runs whenever either is
missing. The provider is classified from `axUrl ?? tabUrl`, so a YouTube/X/GitHub/
Substack page is still recognized when Accessibility isn't granted (rather than
downgrading to a generic `#webpage`).

Providers produced today (`selectSiteProvider`): `generic-webpage`, `youtube`
(watch/Shorts → `video`), `x-twitter` (status → `tweet`), `github`
(repo/profile), `substack` (article), and `unknown-app` (non-browser fallback).
The captured YouTube URL is the clean canonical `watch?v=<id>` (the `t`/`start`
player-position anchor is stripped).

`Enter` on the page chip runs `capture(page)` through the action registry:
`ensure_date_node` supplies `create_capture`'s destination as a BOUND reference,
and the typed text rides along as the note. The main process holds the
authoritative `ExternalContext` and the renderer never receives it — it names an
action and main resolves the source itself, so there is nothing to tamper with. A **page
capture** node carries a hidden `capture` provenance sidecar plus an outline
projection (capture-kind tag + URL/Author/Published fields); a typed note nests
**under** it as a child bullet (the outliner metaphor — "this source, and my note
on it"), never the node's `description`. A **plain manual note** (`capture-note`
row, no source) is just a node under Today — no sidecar, no `#capture` tag, since
it isn't a capture of anything. See [`commands.md`](commands.md) (`create_capture`).

Capture-kind tags (`#article`/`#video`/…) roll up to `#capture` only when the
launcher **creates** them. A pre-existing user tag of the same name is reused
as-is — its `extends` is never rewritten — so a personal `#video` is not silently
re-parented under `#capture`.

A first browser capture without Accessibility prompts for it once. When the active
tab can't be read at all (Automation denied), the launcher shows a quiet
remediation banner pointing at System Settings.

## Inline node search

There is **no** "Search notes" command — typing IS the search. The renderer
debounces (120ms) and calls `ObjectQueryRequest`; main runs the same ranked
retrieval and returns the top hits (limit 8) as node OBJECTS whose presentation
carries the single-line title, the parent's text as subtitle and the node's own
emoji, since the locked-down launcher renderer can't read the document.
Attachment hits remain node objects but carry a file glyph and localized File
type label, so a file named like an ordinary note remains visibly distinct.
Resolution looks up only the hit nodes
(+ their parents) by id via `Core.projectionNodesByIds`, never materializing the
whole-document projection per keystroke. `search_nodes` is a transient lookup
surface. It uses the same document-derived reference-authority boost as saved
searches, then opts into per-user personal access ranking; both affect ordering
only and never change saved search rules or materialized saved-search results.
`Enter` on a node runs `open`; main focuses the main window and sends the action
registry's renderer navigation step. The main renderer's `navigateRoot` opens
the existing file preview for attachment/image nodes and otherwise performs the
ordinary in-place outliner landing. A navigation that arrives before the main
window's renderer has loaded is queued and flushed after load (re-armable, so it
survives a renderer reload).
Only the resulting main-window landing records human access after a short dwell;
typing, hovering, selection movement, and raw search hits do not.

## Objects, not commands

The result list is an **object** list. Every row is a `SurfaceItemPresentation`
main resolved for the opening — five system nodes (Today, Library, Schema, Saved
searches, Trash), two app surfaces (Main window, Settings), ranked node matches,
the ambient page chip, and a single no-match draft — and what Enter does lives in
the action bar, never in the row title.

The legacy `LauncherCommandView` rows are gone: *Open main window* and *Open
Settings* were app surfaces with their verb fused into the noun. The row is
*Main window*; its action is *Open*. Locale guards reject the compound strings in
BOTH roles — as a row title and as an action label.

**Action labels are verbs, and the bar never restates a row title.** The primary
label is the resolved `ActionPresentation` for the active object, so *Capture
page to Today* and *New node in Today* are gone too: the page chip's action is
*Capture* and the draft row's is *Create node*, with Today carried as a bound
destination OBJECT rather than prose inside an action id.

The catalog, the admission path and the candidate policies live in
[`action-registry.md`](action-registry.md).

## Footer

A slim hint bar, divider-free, with two zones (the anatomy ratified in
`unified-command-surface.md` D6a):

The launcher entry loads `button.css` / `input.css` alongside its own sheet: it
renders the shared `Button` and `Input` primitives, and without their styles the
classes resolve to nothing and the browser's default control chrome shows
through.

- **Left — identity and status.** At rest, the app mark plus the formatted summon
  hotkey as quiet meta text (not a key chip). During execution the same zone
  carries the status: a failure (`--status-danger`), or "Saving…" while a capture
  is in flight. The live region wraps the status text only — the identity is
  permanent content and must not be announced when a status clears.
- **Right — the hint cluster.** The active object's primary action label plus the
  `↵` chip, then `Actions ⌘K`. Both are real buttons (click = the keystroke,
  `mousedown` preventDefault) styled as hints, not controls: meta type, secondary
  ink, no control-height bulk. The primary states the **action only** — never an
  error, never "Saving…" — and is disabled while one is in flight. When the
  active object has no safe blind-Enter action, the cluster shows only
  `Actions ⌘K`.

## IPC surface

The launcher window is given a narrow bridge (`src/preload/launcher.ts`, built
into the single preload bundle and selected by a role flag): the generic
`lin:invoke` surface is never exposed to it, and main additionally refuses it
for this sender before dispatch. See [`action-registry.md`](action-registry.md) →
*Renderer capabilities*.

- Launcher renderer → main: `launcher:getInitialState`, `launcher:hide`, and the
  action seam (`action:objectQuery`, `action:parameterQuery`, `action:request`,
  `action:event`). It cannot create an invocation from a seed.
- Main → launcher renderer: `LAUNCHER_SHOWN_CHANNEL`, `ACTION_OPENED_CHANNEL`,
  `ACTION_AMBIENT_CHANGED_CHANNEL`, `LAUNCHER_REMEDIATION_CHANNEL`. The raw
  `ExternalContext` never crosses.
- Main renderer → main: `lin:show-launcher`, so the sidebar Search row and the
  `/`-menu row summon the same panel the hotkey does.
- Main → main renderer: `LAUNCHER_NAVIGATE_TO_NODE_CHANNEL`.
- Settings renderer → main: `lin:launcher-hotkey` (read-only, no args) for the
  Settings row above.

The channel constants and serializable view types live in
`src/core/launcher/commands.ts`; the capture data model in
`src/core/launcher/sources.ts`; the context contract in
`src/core/launcher/context.ts`.

## Not built yet (tracked, not placeheld)

Rich per-provider extraction, native-app providers, preview / open-original,
local-file capture, AI actions, capture destinations + the ⌘K secondary-action
menu, recent destinations, and a fuller permission-remediation UI are all
deferred. They are owned by the plans listed at the top — nothing ships as a
disabled placeholder.
