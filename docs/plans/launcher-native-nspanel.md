---
title: Launcher native NSPanel — keep the dock icon while floating over fullscreen
status: draft
priority: P1
owner: relixiaobo
executor: cc
created: 2026-06-09
updated: 2026-06-09
---

# Launcher native NSPanel (root fix: dock icon + ⌘Q + fullscreen float)

## Goal

The global launcher must satisfy **all of** the following at once:

1. App keeps its **dock icon** (and ⌘Tab entry) — Tenon is a regular foreground app.
2. **First ⌘Q quits** the app (the `before-quit` flush fires on the first press).
3. Launcher **floats over other apps' full-screen spaces** and across all Spaces.
4. Launcher is **non-activating** — summoning it does not steal focus / activate the app.

Today we get at most three of these because the mechanism we use to achieve (3),
Electron's `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`, breaks
(1) and (2). This plan replaces that mechanism with a **native NSWindow
collectionBehavior** set, which keeps all four.

## Non-goals

- No change to the launcher's product behavior, layout, hotkey, or capture
  pipeline. This is purely the window's macOS space/float mechanism.
- No new npm dependency. We extend the **existing** native addon, not pull in
  `electron-nspanel`/`electron-window-nspanel` (read them only for reference).
- Non-macOS platforms: the native call is a no-op (as the corner addon already is).

## Execution (complete-per-PR)

Shape **(a): one complete PR.** Dock icon + ⌘Q + fullscreen float + non-activating
all land together and are verified together — none ships as a partial slice. This
PR **supersedes PR #170's** show/hide toggle of `setVisibleOnAllWorkspaces` and
**reconciles** the `cbcbf71` activation-policy line (both were partial mitigations
of the same root cause). Executor: **cc** (`cc/launcher-native-nspanel`).

## Background — the confirmed root cause

Both prior launcher bugs share **one** root: the launcher window joined all Spaces
via Electron's `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`.

- **`visibleOnFullScreen: true` hides the macOS dock icon** — a known, still-open
  Electron bug introduced in Electron 10.x
  ([electron#26350](https://github.com/electron/electron/issues/26350)). Once
  triggered, `app.dock.show()` and `app.setActivationPolicy('regular')` do **not**
  bring the icon back, and setting the flag back to `false` does not restore it
  either.
- The **permanent all-Spaces** collection behavior made AppKit skip
  `applicationShouldTerminate:` on the first ⌘Q (the original PR #170 bug).

Electron's built-in `type: 'panel'` adds the non-activating panel style mask, but
its `setVisibleOnAllWorkspaces({visibleOnFullScreen})` path is the only built-in
way to float over fullscreen — and that path is the dock-killer. Electron's
NSWindow does not otherwise expose the panel/collection knobs we need
([electron#35815](https://github.com/electron/electron/issues/35815)). So the fix
must set the collection behavior **natively**, bypassing the Electron API.

Why native works: setting `NSWindow.collectionBehavior` directly to
`canJoinAllSpaces | fullScreenAuxiliary` gives the cross-Space + over-fullscreen
float **without** whatever extra Electron does in `visibleOnFullScreen` that hides
the dock. This is the technique the native nspanel packages use.

## Design

The launcher window stays an Electron `type: 'panel'` BrowserWindow (keeps the
non-activating mask) with `setAlwaysOnTop(true, 'pop-up-menu')` (keeps the float
level). We **remove** every `setVisibleOnAllWorkspaces(...)` call and replace it
with a native collection-behavior toggle that mirrors PR #170's proven,
⌘Q-safe lifecycle (set while visible, clear while hidden) — but via the native
addon, so it no longer hides the dock.

### 1. Native addon — add one function to the existing window-corner addon

Reuse `native/window-corner/` (it already turns a `getNativeWindowHandle()` buffer
into an `NSWindow*`), so **no `package.json` / `build:native` change** is needed
(the addon already builds; that script is infra). Add to
`native/window-corner/src/window_corner.mm`:

```objc
// setWindowSpaceBehavior(handle: Buffer, joinAllSpaces: boolean) -> boolean
// Set the NSWindow collectionBehavior natively so the launcher panel floats across
// Spaces + over other apps' fullscreen WITHOUT Electron's
// setVisibleOnAllWorkspaces({visibleOnFullScreen:true}) — that Electron path hides
// the dock icon (electron#26350). Setting collectionBehavior directly does not.
static napi_value SetWindowSpaceBehavior(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  napi_value result;

  void* handleData = NULL;
  size_t handleLen = 0;
  if (argc < 1 || napi_get_buffer_info(env, args[0], &handleData, &handleLen) != napi_ok ||
      handleData == NULL || handleLen < sizeof(void*)) {
    napi_get_boolean(env, false, &result);
    return result;
  }
  bool joinAllSpaces = false;
  if (argc >= 2) napi_get_value_bool(env, args[1], &joinAllSpaces);

  NSView* view = *reinterpret_cast<NSView**>(handleData);
  bool ok = false;
  if (view != nil) {
    NSWindow* window = [view window];
    if (window != nil) {
      NSWindowCollectionBehavior bits =
          NSWindowCollectionBehaviorCanJoinAllSpaces |
          NSWindowCollectionBehaviorFullScreenAuxiliary;
      if (joinAllSpaces) window.collectionBehavior |= bits;
      else               window.collectionBehavior &= ~bits;
      ok = true;
    }
  }
  napi_get_boolean(env, ok, &result);
  return result;
}
```

Register it in `Init` next to `setWindowCornerRadius`:

```objc
napi_create_function(env, "setWindowSpaceBehavior", NAPI_AUTO_LENGTH,
                     SetWindowSpaceBehavior, NULL, &fn);
napi_set_named_property(env, exports, "setWindowSpaceBehavior", fn);
```

### 2. TS wrapper

In `src/main/nativeWindowCorner.ts` (reuse its existing addon loader), add:

```ts
export function setLauncherSpaceBehavior(window: BrowserWindow, joinAllSpaces: boolean): boolean {
  const addon = /* the same loaded addon */;
  if (!addon?.setWindowSpaceBehavior) return false;     // no-op off macOS / unbuilt
  return addon.setWindowSpaceBehavior(window.getNativeWindowHandle(), joinAllSpaces);
}
```

(If the file's addon handle is private, either export a small accessor or add a
sibling `src/main/nativeLauncherPanel.ts` that loads the same `window_corner.node`
via `nativeAddon.ts` — reversible local choice, cc decides.)

### 3. launcherWindow.ts — swap the Electron API for the native toggle

- **`createLauncherWindow`** — keep `type: 'panel'` and
  `setAlwaysOnTop(true, 'pop-up-menu')`. Update the comment block (it currently
  explains why `setVisibleOnAllWorkspaces` is omitted at creation).
- **`showLauncherWindow`** — replace
  `win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` with
  `setLauncherSpaceBehavior(win, true)`.
- **`hideLauncherWindow`** — replace `win.setVisibleOnAllWorkspaces(false)` with
  `setLauncherSpaceBehavior(win, false)` (keep the early-return + `.hide()` from
  #170). Clearing while hidden keeps the common path free of any ⌘Q risk.

Net: the launcher floats over fullscreen **while visible**; while hidden it carries
no cross-Space behavior (dock icon present, ⌘Q safe); and because the behavior is
set natively, the dock icon stays even while the launcher is open.

### 4. Reconcile the prior mitigations

- **PR #170 toggle** — fully replaced by §3 (same lifecycle, native call). No
  `setVisibleOnAllWorkspaces` should remain in `launcherWindow.ts`.
- **`cbcbf71` `app.setActivationPolicy('regular')` (main.ts ~2076)** — its comment
  wrongly claims it fixes the packaged dock issue. Test whether it is still needed
  for the **dev-from-terminal** accessory case: if yes, keep it and correct the
  comment to scope it to that case; if the native fix makes it unnecessary
  everywhere, remove it. Decide by testing both a packaged launch and `dev:cc`.

### 5. Spec

Update `docs/spec/launcher.md` — the macOS NSPanel bullet: the panel floats over
fullscreen via a **native `collectionBehavior` (canJoinAllSpaces |
fullScreenAuxiliary)** set while visible, explicitly chosen over Electron's
`setVisibleOnAllWorkspaces({visibleOnFullScreen})` because that hides the dock icon
(electron#26350). Note the dock icon + ⌘Q are preserved by this choice.

## Open questions (resolve empirically during build — defaults given)

1. **Does `canJoinAllSpaces | fullScreenAuxiliary` actually float over another
   app's fullscreen?** Some reports say the level matters. **Default:** keep
   `setAlwaysOnTop(true, 'pop-up-menu')`; if it still doesn't appear over a
   fullscreen app, set the window level natively to `NSPopUpMenuWindowLevel` /
   `NSStatusWindowLevel` in the same native function.
2. **Permanent vs toggled.** Default is the **toggle** (§3) because it provably
   keeps ⌘Q safe (matches #170). If you confirm a panel with permanent
   `canJoinAllSpaces` does **not** swallow ⌘Q, you may set it once at creation and
   drop the show/hide toggle (simpler) — but only with that verification.
3. **`cbcbf71` keep-or-remove** — per §4, decided by testing the dev-terminal case.

## Verification (packaged build — all five must pass; no headless substitute)

1. Tenon shows its **dock icon**.
2. **⌘Tab** lists Tenon.
3. **First ⌘Q quits** (single press).
4. Launcher **floats over** another app in full-screen when summoned by hotkey.
5. Summoning the launcher **does not activate** Tenon / steal focus from the
   frontmost app (the `showInactive` behavior is intact).

Run both the packaged `.dmg` and `dev:cc`. Light + dark for the launcher UI.

## Gate (main agent)

`/code-review` (includes the native `.mm` change) + the five-point manual packaged
verification above. Not an agent-permissions/security change, so no
`/security-review` required.

## Subtasks

- [ ] Native `setWindowSpaceBehavior` in `window_corner.mm` + `Init` registration.
- [ ] TS wrapper `setLauncherSpaceBehavior` (reuse the addon loader).
- [ ] `launcherWindow.ts`: remove both `setVisibleOnAllWorkspaces` calls; wire the
      native toggle into show/hide; update the creation comment.
- [ ] Reconcile `cbcbf71` activation-policy line (keep+fix-comment or remove).
- [ ] `docs/spec/launcher.md` updated (native collectionBehavior rationale).
- [ ] `bun run build:native` + `bun run typecheck`; package and run the five-point
      verification (packaged + `dev:cc`, light + dark).
