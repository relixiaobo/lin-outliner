---
status: draft
priority: P2
owner: relixiaobo
created: 2026-06-03
updated: 2026-06-03
---

# Field Value Rows Join the Node Selection Model

## Goal

Make **field value rows behave like normal outliner nodes for selection** (PM
decision #2, reading (a)): you can shift/cmd-click to select multiple field value
rows and then act on them (delete / move / duplicate) through the same selection
+ batch-command path as ordinary nodes. Today field value rows render but do not
participate in the global multi-selection model, so multi-select on them does
nothing.

This is **not** a change to the value data model: field values stay
"everything-is-a-node, values always append" (the cardinality concept stays
removed). We are only adding **selection** participation.

## Non-goals

- Reintroducing single-value/cardinality replacement (that was reading (b), which
  the PM did NOT choose).
- Changing how values are *added* (option popover, references, free text all keep
  appending).
- Changing batch commands themselves (`batchTrashNodes`, `batchMoveNodesUp/Down`,
  `batchDuplicateNodes`) — they already accept arbitrary `nodeIds`.

## Design

> **Step 0 (required): reproduce and confirm the real blocker.** Code-only
> analysis was inconclusive — within a single field the value `OutlinerView` uses
> `rootId={entryId}`, so selection *might* partly work there, while the clear gap
> is cross-container selection (a body row ↔ a field value row) because
> `flattenVisibleRows(bodyRoot)` does not descend into field-entry children.
> Before editing, reproduce in a dev run (`bun run dev:cc`): try shift/cmd-click
> across multiple value rows of one field, and across a body row and a value row.
> Record exactly which cases fail, then apply the fix below to those cases.

**Selection data-flow (normal rows):** UI selection lives in `UiState`
(`src/renderer/state/document.ts`): `selectedIds: Set`, `selectedId`,
`selectionAnchorId`, `selectionRootId`, `selectionSource`. `selectFromPointer`
(`useOutlinerRowInteraction.ts`) resolves single/toggle/range from modifiers,
builds the next set via `selectionActions.ts` against the row list from
`flattenVisibleRows(rootId, …)`, scoped by `selectionRootId`.

**The gap:** `flattenVisibleRows` (`document.ts`) walks `field` + `content` rows
and recurses into *expanded* children, but does **not** emit a field entry's
value children. So when selection is scoped to a body/panel root, field value
rows are absent from the row list → range/toggle can't include them.

**Leading fix (confirm against Step 0):** in `flattenVisibleRows`, when a row is
a `fieldEntry` (`type === 'field'`), also emit its value children into the flat
list (in order), so they become selectable alongside body rows. Keep
reference-path cycle tracking intact. This makes both within-field and
cross-container selection work through the existing machinery.

**Batch actions:** already generic over `nodeIds` and have no node-type guards
(`core.ts` `batchTrashNodes` etc. iterate any ids). Field values are real
`content`/`reference` nodes whose parent is the field entry; trashing/moving them
shrinks the entry's children without violating invariants. The context menu's
`resolveActiveNodeSelection` / `selectedRootIds` dedupe (parents collapse to
roots) should be checked to ensure it behaves sensibly when the selection mixes
body rows and value rows.

**Risks to verify (Step 0 + review):**
- Cross-root selection: `selectionRootId` scopes a selection; confirm value rows
  inherit the body root so a body↔value range stays in one scope.
- Reference values: a `reference`-type value node trashed/moved must not corrupt
  the option pool or backlinks.
- Field on a transcluded/reference node: selecting across the reference boundary
  must respect the existing cycle guard.

## Open questions

1. After multi-selecting value rows, which actions must work — delete + move +
   duplicate (full parity), or just delete? (Assume full parity; confirm.)
2. Should a body↔value mixed selection be allowed (one range spanning both), or
   should value-row selection be scoped to its own field? (Leading design allows
   mixed within the same panel root; confirm desired.)

## Files (scope)

Primary: `src/renderer/state/document.ts` (`flattenVisibleRows`). Verify (likely
no change): `useOutlinerRowInteraction.ts`, `FieldValueOutliner.tsx`,
`OutlinerFieldRow.tsx`, `interactions/contextMenuSelection.ts`. No core/protocol
change expected (batch commands already exist).

## Checklist

- [ ] Step 0: reproduce; record which selection cases fail.
- [ ] `flattenVisibleRows`: include field-entry value children.
- [ ] Verify shift/cmd multi-select on value rows (within field + cross-container).
- [ ] Verify delete/move/duplicate on a value-row selection; no invariant breaks
      (references, dedupe, backlinks).
- [ ] Unit test the new flatten behavior; e2e if a selection guard exists.
- [ ] `bun run typecheck` + `test:renderer` + `test:core`.
