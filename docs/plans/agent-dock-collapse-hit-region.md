# Agent Dock Header Interactions

## Goal

Restore the top-right agent toggle's click behavior in the native macOS Electron
window, and make the adjacent Thread-list trigger legible without hover. Clicking
the fixed control must collapse and reopen the agent dock; the Thread title must
read as a list trigger through a persistent chevron rather than a decorative
agent glyph.

## Non-goals

- Redesigning the top strip, moving the agent toggle, or changing header geometry.
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

This deliberately gives up native dragging and double-click zooming across the
rest of the dock-open header band: at the canonical 344px dock width, only the
roughly 53px fixed right `WindowChrome` zone remains draggable and about 290px
does not. Restoring that area would require a separate inner drag spacer bounded
to the header's content box so it ends before the sibling toggle zone. That is a
valid follow-up, but not part of this behavior fix: the smaller ownership model
matches the shell contract and keeps every dock-header control on an ordinary
pointer surface.

### Thread-list affordance

The fixed agent toggle already identifies the dock, while the selected Thread
title identifies its content. A second agent glyph inside the title trigger adds
no information and pushes the actual disclosure cue farther away. Remove the
root Thread's leading `AgentIcon`; child Threads keep their parent-back arrow,
which is functional navigation rather than decoration.

The existing downward chevron becomes visible at rest with its established
muted opacity. Hover and keyboard focus still deepen the parent control's colour,
and the chevron still rotates 180 degrees while the list is open. The control's
accessible name and `aria-expanded` state remain unchanged.

### Regression coverage

Add a focused renderer E2E file that checks both halves of the contract:

- no computed `drag` region outside the fixed `WindowChrome` ownership subtrees
  geometrically intersects the agent toggle;
- clicking the fixed toggle changes the dock from `open` to `collapsed` and back;
- the root Thread list trigger has no redundant leading glyph and exposes its
  downward chevron in the default closed state.

The computed-style geometry assertion catches the native-only failure mechanism
that a plain Chromium click cannot reproduce, including a future overlapping
sibling under a different selector. The behavior assertion keeps the existing
React state path covered without coupling the test to animation timing.

### Specification alignment

Clarify the shell and workspace-layout specifications: the Thread header shares
the top strip's visual centreline, but it is not itself a native drag region. The
fixed right window-chrome zone owns dragging around the agent toggle. The agent
surface specification also records the title-plus-persistent-chevron trigger and
the absence of redundant agent chrome. This makes the specifications match the
existing shell contract and the restored runtime behavior.

## Open questions

None.

## Verification

- [x] `bun run typecheck`
- [x] Focused agent-toggle E2E coverage
- [x] Relevant renderer tests
- [x] `bun run docs:check`
- [ ] Native macOS click verification when an isolated Electron instance is
      available
