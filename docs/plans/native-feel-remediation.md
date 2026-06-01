---
status: in-progress
priority: P1
owner: relixiaobo
created: 2026-05-27
updated: 2026-06-01
---

# Native-Feel Remediation (Electron)

## Goal

Make the Electron app feel like a real macOS/Windows application rather than a
themed web page, **without leaving Electron**. Triggered by two reviews under
the `native-feel-cross-platform-desktop` skill (Claude + Codex). Target OS:
**macOS + Windows**.

## Non-goals

- **No native shell rewrite.** The skill's ideal (Swift/AppKit + C#/WPF host
  owning the window, embedding only the WebView) is explicitly out of scope:
  the repo forbids Rust/Tauri and ships TS/Electron. We adopt the skill's
  *tenets* (T3 adopt the platform, T4 perception, T6 intentional IPC, T8
  baseline vs margin), not its architecture.
- **No Liquid Glass / per-pixel material control.** Electron can reach
  vibrancy (macOS) and mica (Windows) but not `NSGlassEffectView`; that gap is
  the accepted ceiling of staying in Electron.

## Design

The cross-platform seam already sits where the skill wants it (main process =
host + Node backend, renderer = React). The work is to make the host behave
like a native host and the renderer stop telegraphing "web app". Each stage is
an independent, shippable unit; each is its own `cc/native-feel-NN-*` branch +
PR. Stages are ordered so the security/shell foundation lands first and the
visible polish builds on a stable window.

### Decisions (fixed)

- **Cursor policy = strict native.** Chrome controls (buttons, rows, bullets,
  tabs) keep the arrow cursor — no `cursor: pointer`; the hand cursor is
  reserved for content hyperlinks only. Hover *backgrounds* stay; focus rings
  are restored. ⚠️ `tests/e2e/cursor-affordances.spec.ts` currently asserts
  `pointer` on chrome controls and must be rewritten in the same change
  (stage 3), or it pulls the implementation back to web behavior.
- **Stay Electron; adopt the platform where the OS does it better** (materials,
  scrollbars, dark mode, accent, context menus, dialogs).

## Stages

- [x] **1 — Security shell.** `setWindowOpenHandler` (deny + http(s) →
  `shell.openExternal`), `will-navigate`/`will-redirect` guards, permission
  request/check handlers (deny all but `clipboard-sanitized-write`), strict
  prod CSP injected on the `file://` main-frame document. **Shipped in PR #43**
  (merged 2026-05-27); prod CSP verified end-to-end against the built bundle
  (handler fires for `file://`, renderer loads, zero violations).
- [x] **2 — Startup + window semantics.** `show: false` + `ready-to-show`
  first-frame (no white flash); persist + restore window bounds (size/position,
  per-display); single-instance lock + focus-existing on second launch
  (Windows); per-OS title bar (`titleBarOverlay` on Windows alongside macOS
  `hiddenInset`). **Shipped in PR #45.**
- [x] **3 — Material + font + cursor.** macOS `vibrancy` / Windows
  `backgroundMaterial: 'mica'`; system font first (drop the `Inter` lead);
  strict-native cursor pass (remove `cursor: pointer` from chrome, keep hover
  backgrounds, restore visible focus rings); **rewrite
  `cursor-affordances.spec.ts`** to the new contract in the same PR. **Material +
  font shipped in PR #46/#47; the cursor/focus-ring pass + the
  `cursor-affordances.spec.ts` rewrite shipped in PR-C #65** (audit findings
  A1/A5/A6/A7/D4 — the sub-items the index previously over-claimed).
- [x] **4 — Native interactions.** Native right-click `Menu` (replace the DOM
  context menu for the actual right-click); replace `window.prompt`
  (`NodeContextMenu` icon/banner) and `window.confirm` (`AgentChatPanel`
  delete) with real in-app UI or native dialogs; move settings into its own
  window. **Dialogs + settings-window shipped in PR #48/#49; the native
  application menu (`Cmd+,` → settings), native right-click menu, and
  inactive-window state shipped in PR-D #68** (audit A2a/A2b/A4).
  `window.prompt`/`window.confirm` are gone from the renderer (grep-clean).
- [x] **5 — IPC envelope + perf (T6).** IPC envelope
  (`requestId`/`schemaVersion`/`kind`/`payload`); payload-size + duration
  tracing in dev; move from full-projection-per-command to delta projection;
  drop the needless `flushSync` on every projection apply in `shared.ts`. (The
  real T6 cost is the full projection + `flushSync` per command, not
  per-keystroke IPC, which is already batched.) **IPC tracing + incremental core
  shipped in PR #50/#52; renderer perf in PR #54.** (Per audit X1/X2: the
  versioned envelope and `flushSync` removal were deliberately deferred — pure-TS
  host wants shared types over an envelope, and `flushSync` is an intentional
  latency trade to measure before removing.)
- [ ] **6 — Packaging + smoke tests.** electron-builder manifests for Windows
  (and Linux if targeted); protocol / file-association decisions; Electron /
  packaged smoke tests (first frame, native menu + accelerators, CSP
  enforcement, external-link routing, per-clone `userData` isolation). Promote
  the stage-1 prod CSP to a formally smoke-tested enforcing policy here.

## Coordination

Most stages re-touch `src/main/main.ts`, so they serialize: land one, rebase,
do the next, rather than stacking conflicting PRs. Stage 5 also touches
`src/core/commands.ts` + the IPC layer and stage 6 touches `package.json` —
both coordination-required files; open isolated and let other clones rebase.
`README.md` (dev-script / cross-platform claims) and `AGENT.md`/`CLAUDE.md` are
main-agent-owned.

## Open questions

- Stage 4: native context menu vs keeping the richer DOM menu (the DOM menu has
  submenus/icons the native `Menu` can't easily match). **Resolved (native-feel-
  ui-audit PR-D, A2a):** native for the bare right-click, DOM for the
  command-driven menus. The split is automatic — the renderer's command menus
  already `preventDefault()` the DOM `contextmenu` event in the regions they own,
  and Electron only emits the main-process `webContents 'context-menu'` event
  when the renderer did *not* `preventDefault` (verified on Electron 42), so the
  native menu fires only for the bare right-clicks the DOM menus leave alone
  (editable fields → text menu, a selection → Copy, inert chrome → nothing). No
  per-region suppression flag is needed. **Stage 4 is now fully shipped:**
  `window.prompt` / `window.confirm` are replaced (grep-clean), settings has its
  own window, and the native menus / right-click landed in PR-D #68.
- Stage 6: do we ship Linux at all, or is the README's three-OS claim trimmed
  to macOS + Windows?
