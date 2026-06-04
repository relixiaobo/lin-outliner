# browser_tab — focused browser tab via the macOS Accessibility API

A minimal Node-API native addon that reads the **URL + title of the browser
window the user is actually focused on**, targeting a specific process by **PID**
through the Accessibility (AX) API. Used by the global capture launcher
(`docs/plans/lazy-like-global-launcher.md`).

## Why this exists

The AppleScript path (`active tab of front window`) addresses a browser by its
**bundle id** and reads the app's internally-frontmost window. That is wrong in
two real situations:

1. **Multiple windows** — `front window` is not guaranteed to be the window the
   user sees.
2. **Multiple instances of the same browser** (two profiles / `--user-data-dir`)
   — AppleScript can only address one instance per bundle id, so it may read the
   wrong instance's tab entirely.

The AX API fixes both: `AXUIElementCreateApplication(pid)` targets the **exact**
process the user was in (PID comes from `NSWorkspace.frontmostApplication`), and
`kAXFocusedWindowAttribute` is the window with key focus. A shallow, budgeted
depth-first search of that window's subtree finds the first `kAXURLAttribute`
(Chrome's `AXWebArea` and Safari's web area both expose it). This is the approach
reliable launchers (Alfred, Raycast) converge on.

## API

```ts
accessibilityTrusted(): boolean          // AXIsProcessTrusted(), no prompt
promptAccessibility(): boolean           // triggers the system grant prompt
getFocusedTab(pid: number): { url: string | null; title: string | null; error: string | null }
```

`getFocusedTab` never throws; on any failure it returns an `error` code
(`invalid-pid` / `ax-not-trusted` / `ax-app-failed` / `ax-no-window`) and the
orchestrator falls back to the AppleScript path. See
`src/main/context/nativeBrowserTab.ts` for the loader (silent no-op when the addon
is missing / off-darwin / load fails).

## Permission

This addon needs the **Accessibility** TCC grant (System Settings → Privacy &
Security → Accessibility). Without it `AXIsProcessTrusted()` is false and
`getFocusedTab` returns `ax-not-trusted`; capture degrades to AppleScript. It is a
distinct grant from Automation/Apple Events used by the AppleScript path.

## Building

Compiled against the Electron headers, not system Node:

```bash
bun run build:native
```

Runs `node-gyp rebuild` with `--runtime=electron`. Output:
`native/browser-tab/build/Release/browser_tab.node` (gitignored). Not built by
`electron-vite dev`, so run `bun run build:native` once before `bun run dev:*`.
`bun run app:build` runs it automatically before packaging.

## Packaging

`package.json`'s `build.extraResources` copies the `.node` into the bundle's
`Resources/native/` (outside the asar). The loader resolves
`process.resourcesPath/native/browser_tab.node` when packaged and the
`build/Release` path from source.

## Platform

macOS only. Elsewhere the loader returns a no-op and capture uses AppleScript.
