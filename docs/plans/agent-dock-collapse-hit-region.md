# Agent Dock Collapse Hit Region

## Goal

Restore the top-right agent toggle's click behavior in the native macOS Electron
window. Clicking the control must collapse and reopen the agent dock without
changing its geometry, animation, focus behavior, or state model.

## Non-goals

- Redesigning the top strip or moving the agent toggle.
- Adding a new window-drag surface inside the agent dock.
- Changing agent state, renderer-to-main contracts, keyboard shortcuts, or dock
  resize behavior.
- Broadening native-shell smoke coverage beyond this hit-region regression.

## Design

This is shape (a): one complete behavior fix in one PR.

### Native hit-region ownership

The right `WindowChrome` zone remains the native drag-region owner. Its agent
toggle is a DOM descendant with `no-drag`, which is the Electron-supported shape
for carving a clickable control out of a drag region.

The visually aligned `ThreadDock` header belongs to a separate DOM subtree. It
must not declare `-webkit-app-region: drag`: that sibling drag region overlaps the
toggle's complete hit box and macOS consumes the pointer input as title-bar drag
input before React receives `onClick`. Remove the declaration from
`.thread-dock-header`; keep its dimensions and spacing unchanged.

### Regression coverage

Add a focused renderer E2E file that checks both halves of the contract:

- the computed app region for `.thread-dock-header` is not `drag`;
- clicking the fixed toggle changes the dock from `open` to `collapsed` and back.

The computed-style assertion catches the native-only failure mechanism that a
plain Chromium click cannot reproduce. The behavior assertion keeps the existing
React state path covered without coupling the test to animation timing.

### Specification alignment

Clarify the shell and workspace-layout specifications: the Thread header shares
the top strip's visual centreline, but it is not itself a native drag region. The
fixed right window-chrome zone owns dragging around the agent toggle. This makes
the specifications match the existing shell contract and the restored runtime
behavior.

## Open questions

None.

## Verification

- [ ] `bun run typecheck`
- [ ] Focused agent-toggle E2E coverage
- [ ] Relevant renderer tests
- [ ] `bun run docs:check`
- [ ] Native macOS click verification when an isolated Electron instance is
      available
