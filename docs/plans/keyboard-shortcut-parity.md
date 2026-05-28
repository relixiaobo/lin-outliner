---
status: done
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

## Audit Result

Completed against `~/Coding/nodex` on 2026-05-28.

Lin already had these originally-listed gaps on `main`:

- Drag-select via `useDragSelection`, including 5px threshold, same-editor text
  selection preservation, and post-drag click suppression.
- Click-empty-space selection dismissal via `useSelectionDismissal` and
  `[data-preserve-selection]` exemptions.
- Workspace panel page history via `useWorkspaceTabs` and top-chrome
  back/forward controls.
- Trigger and trailing-input option popover keyboard handling.

This PR implemented the remaining real gaps:

- `Cmd/Ctrl+A` now selects all visible rows in the current root even when the
  current selection is empty. Native text select-all still owns focused editors.
- `Cmd/Ctrl+Shift+D` goes to today's daily note only when no row selection is
  active. With a selection, the same chord remains batch duplicate.
- Panel navigation history keeps `Cmd/Ctrl+Z` as document undo and uses distinct
  navigation bindings: `Cmd/Ctrl+[` / `Cmd/Ctrl+]` and `Alt+ArrowLeft` /
  `Alt+ArrowRight`.
- Selected option-reference values in options fields open a keyboard-owned
  option menu. `ArrowUp`, `ArrowDown`, `Enter`, and `Escape` map through the
  `selected_reference` shortcut scope; Escape closes the menu before clearing
  the row selection.

## Decisions

- Do not copy nodex's `Cmd/Ctrl+Z` navigation-history overload. Lin keeps
  document undo/redo on `Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`, and `Cmd/Ctrl+Y`.
- Keep nodex's scoped `Cmd/Ctrl+Shift+D` behavior for Today vs duplicate because
  Lin already has a clear selection/no-selection mode split.
- Keep editor structural keys in `nodeLineKeymap.ts`/editor handlers; the
  registry records the shared shortcuts but does not need to own every editor
  keymap implementation detail.

## Validation

- `bun run typecheck`
- `bun test --path-ignore-patterns 'tmp/**' tests/renderer tests/core`
- Targeted e2e for Today/nav history, empty-selection `Cmd+A`, duplicate
  conflict, selected option-reference menu, and drag-select.

The full `outliner-triggers.spec.ts` file still contains pre-existing tests that
look for the old `[data-trailing-parent-id]` trailing-input surface after the
eager draft row work. The options-field tests added by this PR pass when run
directly.
