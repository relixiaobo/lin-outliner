---
status: in-progress
priority: P1
owner: relixiaobo
created: 2026-05-27
updated: 2026-05-28
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
- [ ] **2 — Startup + window semantics.** `show: false` + `ready-to-show`
  first-frame (no white flash); persist + restore window bounds (size/position,
  per-display); single-instance lock + focus-existing on second launch
  (Windows); per-OS title bar (`titleBarOverlay` on Windows alongside macOS
  `hiddenInset`).
- [ ] **3 — Material + font + cursor.** macOS `vibrancy` / Windows
  `backgroundMaterial: 'mica'`; system font first (drop the `Inter` lead);
  strict-native cursor pass (remove `cursor: pointer` from chrome, keep hover
  backgrounds, restore visible focus rings); **rewrite
  `cursor-affordances.spec.ts`** to the new contract in the same PR.
- [ ] **4 — Native interactions.** Native right-click `Menu` (replace the DOM
  context menu for the actual right-click); replace `window.prompt`
  (`NodeContextMenu` icon/banner) and `window.confirm` (`AgentChatPanel`
  delete) with real in-app UI or native dialogs; move settings into its own
  window.
- [ ] **5 — IPC envelope + perf (T6).** IPC envelope
  (`requestId`/`schemaVersion`/`kind`/`payload`); payload-size + duration
  tracing in dev; move from full-projection-per-command to delta projection;
  drop the needless `flushSync` on every projection apply in `shared.ts`. (The
  real T6 cost is the full projection + `flushSync` per command, not
  per-keystroke IPC, which is already batched.)
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
  submenus/icons the native `Menu` can't easily match). Likely: native for the
  bare right-click, DOM for the command-driven menus — confirm during the
  stage.
- Stage 6: do we ship Linux at all, or is the README's three-OS claim trimmed
  to macOS + Windows?
