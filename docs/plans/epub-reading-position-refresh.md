# EPUB and PDF Reading Position Refresh

## Goal

Make the most recently persisted PDF or EPUB reading position authoritative
across multiple mounted previews of the same source. Re-entering a full reader
from an older preview must restore the latest position instead of overwriting it
with that preview's stale initial snapshot.

This plan has shape (a): one complete feature in one PR.

## Non-goals

- Change the persisted PDF or EPUB reading-position schema or preview identity
  key.
- Synchronize reader state across separate Electron windows.
- Add migration or compatibility code.

## Design

### One renderer-wide authority, captured per session

`useReadingPositionSession` will capture the relevant keyed store at each reader
session boundary. The snapshot identity includes the target, display mode,
loaded document resource, and store reader. `EpubPreview` will provide its loaded
`File`; `PdfPreview` will provide its loaded `PDFDocumentProxy`. The snapshot
therefore lasts for one mounted reader session rather than the component's entire
lifetime.

A mounted full-reader session keeps that snapshot fixed so another surface cannot
silently move it. Collapsing and re-expanding captures the shared latest value and
starts a new session from there. Position writes update only the shared store, not
the current session snapshot.

`EpubReader` and `PdfPages` will mark a full session with no initial position as
restored. This closes the null-position case instead of leaving the session able
to adopt a position that another surface writes later. In `PdfPages`, an explicit
summary-page jump remains ahead of that null-session lock and is consumed first.

Each reader will keep its animation-frame scroll reporting and write through its
format-specific keyed store. Both `writePdfReadingPosition` and
`writeEpubReadingPosition` will update and prune the module cache before checking
for browser storage, preserving the latest position for later sessions in the
same renderer even when `localStorage` is unavailable. This keeps writes bounded
without adding React state or a store subscription.

### Regression coverage

Add focused E2E tests titled
`PDF readers refresh the shared position only when a new full session starts`
and
`EPUB readers refresh the shared position only when a new full session starts`,
each with the observed two-surface sequence:

1. Save an early position in the expanded inline reader.
2. Open the same source in a split-pane reader, wait for its restore layout to
   settle, and save a later position.
3. Re-render and reflow the still-open inline surface without treating the shared
   position as a live synchronization target for that session.
4. Save the later split position again, then collapse and re-expand the inline
   reader.
5. Assert that the new inline session restores the split pane's later relative
   position and that the persisted record still matches it.

Compare page or section identity and relative offset with a small tolerance
because the two reader surfaces can have different viewport sizes. Attribute
writes by matching the unique persisted key to the scrolled reader's live
position; do not use shared `updatedAt` alone, because any mounted reader may
advance it. Wait for page or section layout and the reader scroll position to
settle before scrolling or asserting a restored value.

Add renderer unit tests that deny `localStorage` access, write PDF and EPUB
positions, and read them back from their module caches.

### Current-behavior specification

Update `docs/spec/workspace-layout.md` to state that duplicate mounted PDF and
EPUB surfaces share one latest position per resolved preview identity and
refresh that value before starting a new full-reader session.

## Implementation Surface

- `src/renderer/ui/preview/EpubPreview.tsx`
- `src/renderer/ui/preview/previewRenderers.tsx`
- `src/renderer/ui/preview/readingPositionStore.ts`
- `tests/e2e/file-attachments.spec.ts`
- `tests/renderer/readingPositionStore.test.ts`
- `docs/spec/workspace-layout.md`

No Core protocol, main-process, dependency, build, task-board, or changelog file
changes are required.

## Risks

- A restore-induced scroll event can rewrite the same logical position with
  slightly different geometry. Regression assertions therefore compare the
  settled reader DOM and persisted page or section with a bounded ratio delta.
- Refreshing from the shared store must happen at session boundaries, not on
  every render. The snapshot remains ref-backed and writes remain synchronous.

## Collision Result

The open claims for agent document drift and file-pane recovery do not touch the
implementation surface above. File-pane recovery also edits
`docs/spec/workspace-layout.md`, but in a separate pane-recovery section rather
than the reader-position section. The active file-preview backlog concerns
Office/static URL rendering and does not overlap PDF or EPUB position state.

## Verification

- Focused Playwright E2E for the PDF and EPUB shared-position tests above.
- Focused renderer tests for both storage-unavailable fallbacks.
- `bun run typecheck`
- `bun run test:renderer`
- `bun run docs:check`
- `git diff --check origin/main...HEAD`

## Open Questions

None.
