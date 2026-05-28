---
status: draft
priority: P2
owner: relixiaobo
created: 2026-05-28
updated: 2026-05-28
---

# Keyboard Shortcut Parity

Close the keyboard-shortcut gap between Lin and the nodex reference
(`~/Coding/nodex`). Lin already shares nodex's registry shape
(`src/renderer/ui/interactions/shortcutRegistry.ts`), selection-keyboard, and
IME handling, but several global/navigation shortcuts and one selection edge
case are not implemented. This plan catalogs the gaps, the proposed Lin
bindings, and the conflicts to resolve before binding them.

## Goal

Make Lin's keyboard model feel complete for daily outlining: select-all that
works from a clean state, jump-to-today, navigation history, drag-select, and
keyboard control of reference option menus — without blindly copying nodex
bindings that conflict with Lin's existing ones.

## Non-goals

- No progressive/escalating `Cmd+A` (text → node → all, Tana/Workflowy style).
  Neither nodex nor Lin do this today; it stays out of scope unless requested.
- No user-facing rebinding UI. Bindings stay in `shortcutRegistry.ts`.
- No multi-panel navigation model change. Nav history (below) must adapt to
  Lin's workspace-tab + `WorkspaceCanvas` model, not import nodex's `Panel` /
  `NavigationEvent` shape (see `nodex-parity-decisions.md`).

## Current State

Lin's `OUTLINER_SHORTCUTS` global scope = `command_palette` (Cmd+K),
`open_agent_panel` (Cmd+M), `undo` (Cmd+Z), `redo` (Cmd+Shift+Z / Cmd+Y).
Editor structural keys (Enter/Tab/Backspace/arrows) live in
`nodeLineKeymap.ts`, not the registry — so they are present, just organized
differently from nodex. The gaps below are features Lin genuinely lacks
(confirmed absent by source search on 2026-05-28).

## Gap Items

### 1. `Cmd+A` from a clean/empty selection (P1 within this plan)

- **Current Lin:** `useWorkspaceKeyboard.ts:204` bails when
  `currentUi.selectedIds.size === 0`, so `selection.select_all` only runs when
  a row is already selected and no editor is focused. From a fresh panel
  (nothing selected) `Cmd+A` does nothing; while editing it falls through to
  native text select-all.
- **nodex:** `OutlinerRow.tsx` runs `select_all` whenever focus is not in an
  input/contentEditable and no node is focused — *even with zero current
  selection* — selecting all top-level content children of the root.
- **Proposed:** allow `select_all` to proceed when nothing is selected (select
  all visible rows in the current root scope, matching the existing
  description). Keep the `focusedId` (edit-mode) guard — `Cmd+A` while editing
  stays native text select-all, same as nodex.
- **Files:** `useWorkspaceKeyboard.ts` (relax the `select_all` branch so an
  empty selection still resolves rows). **Tests:** `outlinerParity.test.ts`,
  `outliner-selection-keyboard.spec.ts`.

### 2. Go to today

- **nodex:** `global.go_to_today`, `Cmd/Ctrl+Shift+D`, navigates to today's
  journal day node (`use-today-shortcut.ts`).
- **Lin mapping:** navigate to today's daily note (`DAILY_NOTES_ID` /
  `PanelDateNavigation.tsx`).
- **Conflict:** Lin already binds `Cmd+Shift+D` to `selection.duplicate`
  (batch duplicate). nodex disambiguates by scope: in selection mode it is
  duplicate; only when no node is focused/selected does it mean go-to-today.
  Mirror that scope split, or pick a non-conflicting key for Lin.
- **Files:** new `global.go_to_today` in `shortcutRegistry.ts`, handler in
  `useWorkspaceKeyboard.ts`, wired to the daily-notes/today navigation API.

### 3. Navigation history back / forward

- **nodex:** `global.nav_undo` (`Cmd/Ctrl+Z`) / `global.nav_redo`
  (`Cmd/Ctrl+Shift+Z`) move through node-view history when focus is not
  editable (`use-nav-undo-keyboard.ts`).
- **Conflict (design decision):** Lin maps `Cmd+Z` to *document undo* globally.
  nodex overloads `Cmd+Z` outside editors to mean *navigate back*. Adopting
  nodex's mapping changes Lin's undo semantics — needs an explicit decision
  (see Open Questions). Lin also has no node-view navigation history stack
  today; this item requires building one over the workspace-tab /
  `WorkspaceCanvas` model first.
- **Files:** navigation-history store + `WorkspaceCanvas` integration, then
  `shortcutRegistry.ts` + `useWorkspaceKeyboard.ts`. Larger than the others.

### 4. Drag-select (rubber-band multi-row selection)

- **nodex:** `use-drag-select.ts` — document-level mousedown/move/up with a
  5px threshold, text-area special handling (same-node-on-text → let native
  text selection run; moved to padding or another node → drag-select), and a
  `justDragged` flag so the trailing click is suppressed.
- **Current Lin:** only `Cmd/Ctrl+click` toggle and `Shift+Arrow` range; no
  mouse drag selection.
- **Files:** new `useDragSelect` hook + suppression hook in `OutlinerItem`,
  reuse `flattenVisibleRows` + a range-selection helper. **Tests:** new e2e.

### 5. Click-empty-space to clear selection

- **nodex:** `use-global-selection-dismiss.ts` clears selection on a click
  outside any row.
- **Files:** small global pointer hook in the workspace shell.

### 6. Reference options menu keyboard navigation

- **nodex:** `selected_ref.options_up/down/confirm/cancel` drive the option
  dropdown of a selected reference with Arrow/Enter/Escape.
- **Current Lin:** `selected_reference` scope has only `delete`,
  `convert_arrow_right`, `convert_printable`, `escape` — no option-menu keys.
- **Files:** extend the `selected_reference` scope + the reference options
  popup component.

## Open Questions

- **Cmd+Z overload:** keep `Cmd+Z` = document undo (Lin today) and bind nav
  history to a different key, or follow nodex and make `Cmd+Z` = nav-back when
  not editing? Recommend keeping document undo on `Cmd+Z` and choosing a
  distinct nav-history binding to avoid surprising undo behavior.
- **Cmd+Shift+D dual meaning:** reuse the key with a selection/no-selection
  scope split (nodex's approach) or give go-to-today its own key?
- **Nav history scope:** does navigation history need to exist as a first-class
  store before item 3 is worth doing, and how does it interact with zoom/focus
  vs workspace tabs?

## Implementation Order

1. Item 1 — `Cmd+A` empty-selection fix (smallest, highest daily value).
2. Item 5 — click-away dismiss (small, complements selection ergonomics).
3. Item 2 — go-to-today (after resolving the key conflict).
4. Item 4 — drag-select (medium; needs the suppression dance).
5. Item 6 — reference options keyboard nav (scoped to the options popup).
6. Item 3 — navigation history (largest; depends on a nav-history model).

Each item ships as its own `cc/`, `cc-2/`, `codex/`, or `anti/` branch + PR
with focused tests. Update `spec/outliner-parity-matrix.md` as items land.
