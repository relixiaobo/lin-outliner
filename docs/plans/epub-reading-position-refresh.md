# EPUB Reading Position Refresh

## Goal

Make the most recently persisted EPUB reading position authoritative across
multiple mounted previews of the same source. Re-entering a full reader from an
older preview must restore the latest position instead of overwriting it with
that preview's stale initial snapshot.

This plan has shape (a): one complete feature in one PR.

## Non-goals

- Change the persisted EPUB reading-position schema or preview identity key.
- Change PDF position behavior.
- Synchronize reader state across separate Electron windows.
- Add migration or compatibility code.

## Design

### One renderer-wide authority, captured per session

`EpubPreview` will treat `readEpubReadingPosition` as the source of truth at each
full-reader session boundary. Its restore snapshot is keyed by target, display
mode, and loaded file, rather than lasting for the component's entire lifetime.
A mounted full-reader session keeps that snapshot fixed so another surface cannot
silently move it; collapsing and re-expanding captures the shared latest value and
starts a new session from there.

`EpubReader` will mark a full session with no initial position as restored. This
closes the null-position case instead of leaving the session able to adopt a
position that another surface writes later.

`persistReadingPosition` will continue to write through
`writeEpubReadingPosition`, and `EpubReader` will keep its animation-frame scroll
reporting. `writeEpubReadingPosition` will update the module cache before checking
for browser storage, preserving the latest position for later sessions in the
same renderer even when `localStorage` is unavailable. This keeps writes bounded
without adding React state or a store subscription.

### Regression coverage

Add a focused E2E test titled
`EPUB readers refresh the shared position only when a new full session starts`
with the observed two-surface sequence:

1. Save an early position in the expanded inline reader.
2. Open the same source in a split-pane reader, wait for its restore layout to
   settle, and save a later position.
3. Re-render and reflow the still-open inline surface and assert that its current
   session remains in the early section rather than jumping to the split reader's
   later section.
4. Save the later split position again, then collapse and re-expand the inline
   reader.
5. Assert that the new inline session restores the split pane's later
   section-relative position and that the persisted record still matches it.

Compare section identity and offset ratio with a small tolerance because the two
reader surfaces can have different viewport heights. Attribute writes by matching
the unique persisted key to the scrolled reader's live section-relative position;
do not use shared `updatedAt` alone, because any mounted reader may advance it.
Wait for mounted section heights and the reader scroll position to settle before
scrolling or asserting a restored value.

Add a renderer unit test that denies `localStorage` access, writes an EPUB
position, and reads it back from the module cache.

### Current-behavior specification

Update `docs/spec/workspace-layout.md` to state that duplicate mounted EPUB
surfaces share one latest position per resolved preview identity and refresh
that value before starting a new full-reader session.

## Implementation Surface

- `src/renderer/ui/preview/EpubPreview.tsx`
- `src/renderer/ui/preview/readingPositionStore.ts`
- `tests/e2e/file-attachments.spec.ts`
- `tests/renderer/readingPositionStore.test.ts`
- `docs/spec/workspace-layout.md`

No Core protocol, main-process, dependency, build, task-board, or changelog file
changes are required.

## Risks

- A restore-induced scroll event can rewrite the same logical position with
  slightly different geometry. Regression assertions therefore compare the
  settled reader DOM and persisted section with a bounded ratio delta.
- Refreshing from the shared store must happen at session boundaries, not on
  every render. The snapshot remains ref-backed and writes remain synchronous.

## Collision Result

The open claims for agent stream resilience, renderer state hygiene, agent
document drift, and file-pane recovery do not touch the implementation surface
above. The active file-preview backlog concerns Office/static URL rendering and
does not overlap EPUB position state.

## Verification

- Focused Playwright E2E for the existing inline-renderer test and the
  shared-position test above.
- Focused renderer test for the storage-unavailable fallback.
- `bun run typecheck`
- `bun run test:renderer`
- `bun run docs:check`
- `git diff --check origin/main...HEAD`

## Open Questions

None.
