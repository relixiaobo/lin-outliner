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

### One renderer-wide authority

`EpubPreview` will treat `readEpubReadingPosition` as the source of truth whenever
it renders a restore candidate. It will no longer retain a per-component copy of
the first position that the instance observed. The existing keyed store already
updates synchronously and is shared by every preview instance in the renderer,
so a later write from a split-pane reader becomes visible to an older inline
preview before that preview starts another full-reader session.

`persistReadingPosition` will continue to write through
`writeEpubReadingPosition`, and `EpubReader` will keep its animation-frame scroll
reporting. This preserves the current bounded update frequency while removing
the stale second authority.

### Regression coverage

Extend the E2E test titled
`EPUB files render through the inline reader instead of metadata fallback` with
the observed two-surface sequence:

1. Save an early position in the expanded inline reader.
2. Open the same source in a split-pane reader and save a later position.
3. Collapse and re-expand the original inline reader.
4. Assert that restoration remains at the split pane's later section-relative
   position and that the old inline snapshot does not replace it.

Compare section identity and offset ratio with a small tolerance because the two
reader surfaces can have different viewport heights. Do not use `updatedAt` as
the semantic assertion: an automatic restore legitimately reports the restored
position again with a newer timestamp.

### Current-behavior specification

Update `docs/spec/workspace-layout.md` to state that duplicate mounted EPUB
surfaces share one latest position per resolved preview identity and refresh
that value before starting a new full-reader session.

## Implementation Surface

- `src/renderer/ui/preview/EpubPreview.tsx`
- `tests/e2e/file-attachments.spec.ts`
- `docs/spec/workspace-layout.md`

No Core protocol, main-process, dependency, build, task-board, or changelog file
changes are required.

## Risks

- A restore-induced scroll event can rewrite the same logical position with
  slightly different geometry. Regression assertions therefore compare the
  stable section and a bounded ratio delta.
- Refreshing from the shared store must not introduce renderer state or a new
  subscription; reads remain cache-backed and writes remain synchronous.

## Collision Result

The open claims for agent stream resilience, renderer state hygiene, agent
document drift, and file-pane recovery do not touch the implementation surface
above. The active file-preview backlog concerns Office/static URL rendering and
does not overlap EPUB position state.

## Verification

- Focused Playwright E2E for the EPUB reader test title above.
- `bun run typecheck`
- `bun run test:renderer`
- `bun run docs:check`
- `git diff --check origin/main...HEAD`

## Open Questions

None.
