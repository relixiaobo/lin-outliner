# Command Surface Discoverability

> **Merged, not shipped (2026-08-06).** Folded into
> [`../launcher-interaction-hardening.md`](../launcher-interaction-hardening.md)
> (its D7/D8) before any build started, PM-directed — one PR removes the
> shared-file choreography and the two-step `formatHotkey` move. Kept for
> provenance; the design below is superseded by that plan.

## Goal

The command surface is keyboard-only knowledge today: the in-app palette hangs
off `⌘K` with no visible entry point, and the global launcher's hotkey
(`⌘⇧Space` when free) is displayed **nowhere** — main passes the registered
accelerator to the launcher renderer (`launcher:getInitialState().hotkey`) and
nothing renders it; if both candidate accelerators are taken, registration
fails silently and the launcher is unreachable with zero indication. Search is
fused into these surfaces, so a mouse-first user cannot discover search at all
(2026-08-06 launcher review; PM-raised).

Ship the two discoverability affordances:

1. a **Search** entry at the top of the sidebar's primary nav that opens the
   in-app command palette and shows its real shortcut, and
2. a **Settings → General** row that shows the global launcher's registered
   hotkey — including the "not registered" failure state.

**Shape (a): ONE complete feature in one PR.**

## Non-goals

- **No content/behavior changes to the palette or launcher** — what the
  surfaces contain is `unified-command-surface`'s domain. This plan only adds
  ways to reach them and see their shortcuts.
- No shortcut customization / rebinding UI.
- No menu-bar or tray affordance.
- No launcher-footer hotkey display (no discovery value inside the surface
  itself).

## Design

### D1 — Sidebar Search entry

- **Placement:** first row of the primary nav group, above Today
  (`primaryNavItems`, `src/renderer/ui/Sidebar.tsx:32-37`). Search is the
  universal entry point (Notion/Linear convention: topmost). Note
  `primaryNavItems` maps keys to `navTargets` node ids — Search is an *action*,
  not a nav target, so render it as its own row above the mapped loop rather
  than forcing a pseudo-target into the record.
- **Row anatomy:** existing sidebar-row primitive + `SearchIcon`
  (`src/renderer/ui/icons.ts` already exports it), label from new
  `t.shell.sidebar.search` (en "Search", zh-Hans "搜索"), and a right-aligned
  shortcut hint.
- **Shortcut hint:** derived from the shortcut registry, never hardcoded —
  format the first binding of `global.command_palette`
  (`shortcutRegistry.ts:139`, `binding('k', { mod: true })` → `⌘K` on macOS).
  If the registry already has a display formatter, reuse it; otherwise add a
  small formatter next to the registry (mod → `⌘`, shift → `⇧`, alt → `⌥`,
  key uppercased) so future rebinds flow through. Rendered as quiet meta text
  (`--text-tertiary`, `--font-meta`), always visible — visibility is the
  point. Not a `.kbd` chip box: sidebar rows keep their flat look; the chip
  treatment stays in overlays.
- **Wiring:** `App.tsx` owns the palette state (`setCommandOpen(true)` on
  `global.command_palette`, `useWorkspaceKeyboard.ts:220-224`). Thread one new
  callback `onOpenSearch` into `Sidebar` alongside `onOpenSettings` and route
  the row through it. **Single call site is a requirement:** when
  `unified-command-surface` PR 2 retires `⌘K` and deletes the palette, this
  row retargets to the unified surface summon and the hint re-derives from
  whatever binding remains — a two-line change. Record that in PR 2's sweep
  when it lands (its D3 already deletes `global.command_palette`).
- **A11y:** same semantics as the other nav rows (button, focus-visible ring);
  the hint is `aria-hidden` (the row's accessible name stays "Search").

### D2 — Settings shows the global launcher hotkey

- **Data path:** main already holds the winner in `launcherHotkeyAccelerator`
  (`src/main/main.ts:1671`, set at `main.ts:4076-4077`, `null` when both
  candidates were taken). Expose it read-only to the settings renderer the same
  way the General pane reads theme state (`window.lin.*`,
  `SettingsGeneralSection.tsx:49-68`): a preload method
  `getLauncherHotkey(): Promise<string | null>` over a new
  `ipcMain.handle('lin:launcher-hotkey')`. Read-only, no args, no secrets —
  keep the preload surface minimal and typed like its neighbors.
- **Rendering:** a "Global launcher" row in `SettingsGeneralSection.tsx`:
  - registered → the formatted accelerator, e.g. `⌘⇧␣`, via `formatHotkey`;
  - `null` → quiet warning copy (en: "Not available — the candidate shortcuts
    are in use by other apps. Quit the conflicting app and relaunch Tenon.";
    zh-Hans equivalent), `--text-secondary` with a status icon, not a red
    banner (informational, not destructive).
- **`formatHotkey` moves to core.** It lives unused-by-UI in
  `src/renderer/launcher/launcherModel.ts:268` (exported + unit-tested). Move
  it to `src/core/launcher/commands.ts` next to the channel/view types so both
  the settings renderer and the launcher share one formatter; move
  its test block from `launcherModel.test.ts` into the core test suite, and
  update the launcher-footer usage `launcher-interaction-hardening.md` adds
  (its D4 identity zone imports from the old location until this move).
  (`src/core/launcher/commands.ts` is launcher-IPC shared surface, not the
  A4-protected document protocol — still, it's an additive pure function;
  note it in the PR body.)
- i18n: new strings in both `en.ts` and `zh-Hans.ts` (settings row label,
  value fallback, warning copy).

### Spec updates (A6, same PR)

- `docs/spec/workspace-layout.md` (sidebar section): the Search row, its
  position, and the registry-derived hint.
- `docs/spec/launcher.md` (Hotkey section): the registered accelerator is now
  surfaced in Settings → General, including the registration-failure state.

### Collision check (run at claim time, 2026-08-06 snapshot)

Open PRs: #494 (`cc-2/whats-new-user-notes`) — no overlap.
`launcher-interaction-hardening.md` edits the head of `launcherModel.ts` and
the same i18n message files — disjoint regions/keys; **land that PR first**,
then rebase. `unified-command-surface` PR 2 (unclaimed) later retargets the
sidebar row per D1's single-call-site note; nothing here blocks or is blocked
by it.

## Verification

- `bun run typecheck`; renderer tests:
  - Sidebar renders the Search row first with the registry-derived hint text
    (assert it changes when the registry binding is stubbed differently — the
    no-hardcoding guard);
  - clicking the row fires `onOpenSearch`;
  - settings General row renders the formatted hotkey, and the warning state
    when the IPC returns `null`.
- Core test move for `formatHotkey` (cases carry over unchanged).
- Manual: dev run — sidebar row opens the palette; Settings shows the hotkey;
  `LIN_LAUNCHER_HOTKEY` set to a taken accelerator → warning state. Light +
  dark visual verification at the gate.

## Open questions

None — copy detail and exact row placement within the General pane are
reversible implementer calls.
