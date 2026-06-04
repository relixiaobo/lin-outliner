# Global Launcher

Current shipped behavior of the Spotlight/Raycast-style global launcher. The
forward-looking design and the deferred features live in
[`../plans/lazy-like-global-launcher.md`](../plans/lazy-like-global-launcher.md)
and its split plans (`launcher-ai-actions.md`,
`launcher-capture-destinations.md`, `launcher-provider-expansion.md`,
`browser-extension-integration.md`). This document describes only what exists.

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
- **macOS NSPanel** (`type: 'panel'`, `alwaysOnTop`, `visibleOnAllWorkspaces`
  incl. full-screen): a non-activating floating overlay that can take key focus
  for typing without activating the app.
- **Fixed golden rectangle** (760 × ~470), top-biased placement (0.18 of the
  work area) on the display under the cursor; never resizes to its result count
  (the body scrolls). Native 16px corner via the `window_corner` addon.
- **Liquid-glass** surface: transparent window over `vibrancy: 'hud'`; the
  renderer keeps the surface transparent and tints it with functional fills.
  Reduce-Transparency drops to an opaque elevated surface (see `design-system.md`).
- **Show sequence** (`showLauncherWindow`): `showInactive()` first (so the
  previously-frontmost app keeps focus while context is read), run the
  `beforeFocus` hook, then `show()` + `focus()` and send `LAUNCHER_SHOWN_CHANNEL`.
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
  (`clipboard-sanitized-write` only).
- **No remote-content webContents.** Capture reads basic info via JXA / AppleScript
  / the Accessibility addon — no web page is ever loaded into an Electron
  webContents, so there is no remote-content surface to harden.

## Hotkey (`src/main/launcher/launcherHotkey.ts`)

Registers the first free accelerator of `LIN_LAUNCHER_HOTKEY` (env) →
`CommandOrControl+Shift+Space` → `Control+Alt+Space`. The winner is surfaced to
the renderer via `launcher:getInitialState().hotkey` (or `null` if none was free).
Released on quit.

## The modeless model (`src/renderer/launcher/`)

ONE always-focused input is simultaneously a **command filter**, a **live node
search**, and a **live capture draft** — there is no mode and no "pick New Capture
first" step. The result list is built purely by `buildLauncherItems` (in
`launcherModel.ts`, unit-tested without a DOM) from `(query, context, nodes,
commands)`, rendered as a single **flat** list of uniform rows
(`glyph · title · subtitle · right-aligned type label` — `Command` or `Node`). No
section headers.

Ordering is **capture-first**:

- **Page context + typed text** → a `capture-page` row (title "Capture") that
  captures the page with the typed text riding along as a comment, then a
  `capture-note` row ("New node") as the escape hatch to make the text its own node.
- **Page context, no text** → a single `capture-page` row.
- **No context, typed text** → a `capture-note` row ("New node") in Today.
- Then matching document nodes, then the filtered commands.

Each row has exactly **one** action today (`actions[0]`, what Enter runs). The
`actions[]` array shape is kept so secondary actions return additively; there are
no disabled "coming soon" placeholders. Selection is tracked by row **identity**
(not index), resets to the top row on typing, scrolls into view on arrow nav, and
is single-shot (a re-entrancy lock prevents double-fire). The input is an ARIA
combobox over the result `listbox` (`aria-activedescendant` follows selection).

## Capture (basic-info only)

Capture reads URL + title + frontmost app and classifies the provider **from the
URL** — no in-page body/transcript/selection extraction (that returns with the
browser-extension backend). Orchestrated by `captureExternalContext`
(`src/main/context/contextCapture.ts`): frontmost app via JXA NSWorkspace, the
active tab via the Accessibility addon (authoritative, by PID) with an AppleScript
front-tab fallback.

Providers produced today (`selectSiteProvider`): `generic-webpage`, `youtube`
(watch/Shorts → `video`), `x-twitter` (status → `tweet`), `github`
(repo/profile), `substack` (article), and `unknown-app` (non-browser fallback).
The captured YouTube URL is the clean canonical `watch?v=<id>` (the `t`/`start`
player-position anchor is stripped).

`Enter` on a capture row calls `launcher:createContextCapture` /
`launcher:createCapture`, which ensures today's date node and runs the
`create_capture` document command under it. The main process holds the
authoritative `ExternalContext`; the renderer supplies only an optional note, so
it can't tamper with the saved source. The node carries a hidden `capture`
provenance sidecar plus an outline projection (capture-kind tag + URL/Author/
Published fields). See [`commands.md`](commands.md) (`create_capture`).

A first browser capture without Accessibility prompts for it once. When the active
tab can't be read at all (Automation denied), the launcher shows a quiet
remediation banner pointing at System Settings.

## Inline node search

There is **no** "Search notes" command — typing IS the search. The renderer
debounces (120ms) and calls `launcher:searchNodes`; main runs the `search_nodes`
document command and resolves the top hits (limit 8) into `LauncherNodeMatch`
views (single-line title + parent text + emoji icon), since the locked-down
launcher renderer can't read the document. `Enter` on a node calls
`launcher:openNode` → `navigateMainToNode`, which brings up / creates the main
window and sends `LAUNCHER_NAVIGATE_TO_NODE_CHANNEL` so the main renderer runs
`navigateRoot + focusNode` (the same jump the in-app command palette uses). A
navigate that arrives before the main window's renderer has loaded is deferred and
flushed on `did-finish-load`.

## Commands

`getStaticLauncherCommands()` ships only **Open main window** and **Open
Settings** — both runnable. AI, capture destinations (Inbox / picker), and
navigation (Go to Today / Library, recents) are deferred to the split plans and
will appear here when they work, never as disabled rows.

## IPC surface

- Renderer → main (`ipcMain.handle`): `launcher:getInitialState`, `launcher:hide`,
  `launcher:executeCommand`, `launcher:createCapture`,
  `launcher:createContextCapture`, `launcher:searchNodes`, `launcher:openNode`.
- Main → launcher renderer: `LAUNCHER_SHOWN_CHANNEL`, `LAUNCHER_CONTEXT_CHANNEL`.
- Main → main renderer: `LAUNCHER_NAVIGATE_TO_NODE_CHANNEL`.

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
