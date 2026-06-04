---
status: in-progress
priority: P2
owner: relixiaobo
created: 2026-06-03
updated: 2026-06-04
---

# Field Value Rows Join the Node Selection Model

## Goal

Make field value rows participate in the same node selection model as ordinary
outliner rows. A user can Shift/Cmd-click across body rows and field value rows,
use keyboard selection commands, and run batch actions such as delete, move, and
duplicate without the value column becoming a special field-only selection scope.

This follows PM decision #2 / reading (a): a field entry is a node and each stored
value is its child node. The value data model remains append-only and
node-backed. This plan changes selection and batch routing, not cardinality or
value creation.

## Non-goals

- Reintroducing single-value/cardinality replacement.
- Changing how values are added through option popovers, reference pickers, date
  pickers, or free-text drafts.
- Making computed system field values mutable. Synthetic `sysref:*` rows remain
  read-only computed presentation.
- Rewriting the whole outliner renderer or landing flat outliner as part of this
  work.

## Pre-change Reality

This is not a one-line `flattenVisibleRows` patch.

- `flattenVisibleRows(rootId, ...)` is the canonical visible-row order used by
  pointer selection, keyboard selection, drag selection, navigation, and
  clipboard paths. It currently emits body `content` rows and `field` rows, then
  descends only into expanded row children.
- Editable field values render through a nested `OutlinerView` with
  `parentId={entryId}` and `rootId={entryId}`. That makes field-value selection
  work inside the field's local value scope, but it prevents one selection range
  from spanning a body row and a value row.
- Selection state already has `selectionRootId`, but row interactions currently
  set it to the render view's `rootId`. Render root and selection root are
  effectively the same concept today.
- Existing e2e coverage encodes the old scoped behavior:
  `Cmd+A selects visible field value rows in their own value scope`.
- `buildVisualRows` is parity-pinned to `flattenVisibleRows`; changing the
  canonical visible ordering must update both producers or deliberately split
  selectable-row order from visual-row order.
- Empty field-value deletion already routes through `removeFieldValue`, which
  cleans up or promotes auto-collected option values. Selection delete currently
  routes through `batchTrashNodes`, which does not do field-value cleanup.
- Node-reference system fields synthesize locked `sysref:*` rows in an augmented
  renderer index. They are presentation rows, not stored value nodes, and cannot
  participate in destructive batch commands.

Collision check, 2026-06-03:

- Open PRs #92-#95 are scoped to agent OAuth/provider work. No overlap with this
  selection/model/UI area.
- This plan touches shared renderer interaction surfaces, so it is plan-track
  significant and needs PM scope GO before implementation.

## Design

### 1. Add A Panel-Level Selectable Row Model

Introduce a pure selectable-row producer, for example
`buildSelectableRows(panelRootId, byId, options)`, that answers one question:
which real or presentational rows are selectable in this panel, in what order,
and what actions are allowed for each row?

Each returned row should carry enough metadata for interaction code to avoid
re-deriving special cases:

```ts
interface SelectableRow {
  id: NodeId;
  parentId: NodeId | null;
  panelRootId: NodeId;
  kind: 'content' | 'fieldEntry' | 'fieldValue' | 'syntheticSystemValue';
  stored: boolean;
  mutable: boolean;
  actionPolicy: {
    delete: 'node-trash' | 'field-value-remove' | 'disabled';
    move: 'node-reorder' | 'disabled';
    duplicate: 'node-clone' | 'disabled';
    tag: 'target-node' | 'disabled';
    checkbox: 'target-node' | 'disabled';
  };
}
```

The exact shape can vary, but the model must be explicit about:

- Body rows and field entry rows.
- Stored field value rows, including plain content values and reference values.
- Reference-transcluded rows, with the same cycle guard as today's row flattening.
- Hidden fields and grouped rows: group/header rows are not selectable; hidden
  field reveal rows are not normal node selection rows.
- Synthetic `sysref:*` rows: selectable only if useful for focus/reference
  affordances, but destructive actions are disabled.

The producer should live near the existing row-ordering code and be unit tested
before interaction rewiring. Implementation choice: `flattenVisibleRows` remains
the legacy visual/editing row-order helper, while selection entrypoints consume
`buildSelectableRows` directly. The key rule is one canonical panel-level
selection order, not one order per nested `OutlinerView`.

### 2. Split Render Root From Selection Root

Keep rendering field values in the value column with `parentId=entryId`; that is
layout. Selection scope must instead inherit the outer panel root.

Thread a separate `selectionRootId` / `selectionScopeRootId` through:

- `OutlinerView`
- `FieldValueOutliner`
- `SystemReferenceValues`
- `OutlinerItem`
- `OutlinerFieldRow`
- `useOutlinerRowInteraction`

For normal panel rows, `selectionRootId === rootId`. For field value rows,
`rootId` may stay `entryId` for local rendering/focus mechanics, while
`selectionRootId` is the panel root. All code that writes
`ui.selectionRootId` should use the selection root, not the render root.

This is the minimum architectural seam. Without it, changing only
`flattenVisibleRows(panelRootId)` still leaves value-row click and Escape paths
anchored to the field-entry scope.

### 3. Rewire Selection Entrypoints To The Same Model

Move these paths to the panel-level selectable-row model:

- Pointer selection: click, Cmd/Ctrl-click, Shift-click.
- Keyboard selection: Cmd/Ctrl+A, Shift+Arrow, Arrow navigation from selection,
  Enter/type-to-edit, copy/cut/delete/duplicate/move/tag/checkbox.
- Drag selection.
- Context-menu batch resolution.
- Clipboard serialization.

The implementation should avoid component-specific row lists. Component handlers
can pass the row id and selection root; shared interaction code resolves order
and policy from the same selectable model.

### 4. Make Batch Actions Field-Value-Aware

Do not route every selected field value through generic node batch commands.

Delete semantics:

- Stored field value rows must use field-value removal semantics equivalent to
  `removeFieldValue`, so auto-collected options are cleaned up or promoted.
- A single ref-clicked ordinary reference may still hard-delete the reference row
  itself, matching the pre-existing reference-row affordance. If that reference
  is a field value, field-value removal wins so field cleanup still runs.
- Mixed selections may include body rows, field entries, and value rows. The
  batch delete planner should partition the selected roots by action policy and
  run the correct command(s) in one user gesture.
- If the selection contains a field entry and one of its value children, selected
  root de-duping should collapse to the field entry, preserving today's parent
  suppression rule.

Move semantics:

- Moving selected field values should reorder siblings inside their owning field
  entry.
- Cross-parent moves for field values are not part of this plan unless explicitly
  approved. The initial implementation should disable or no-op move for mixed
  selections where a value row would need to leave its field entry.
- Moving normal body rows remains the existing node reorder behavior.

Duplicate semantics:

- Plain field values can clone as sibling values.
- Reference field values need a deliberate decision: either clone the reference
  value as another reference row if the field permits duplicates, or keep today's
  dedupe semantics and no-op when the target already exists in that field.
- Auto-collected option values need a deliberate decision: cloning the local value
  should not create orphaned or duplicate option-pool state. Prefer a
  field-value-aware duplicate path over raw `cloneSubtreeDirect`.

Synthetic/read-only system values:

- Destructive batch actions are disabled.
- Reference affordances may still navigate/edit the target where existing
  read-only behavior allows it.

### 5. Keep Visual And Selection Ordering Separate

`flattenVisibleRows` and `buildVisualRows` stay parity-pinned for visual/editing
navigation. Field value rows render inside their field row, so they are not
ordinary body rows in that projection. `buildSelectableRows` is the selection
projection and includes field value rows in panel order. Tests must compare each
producer to its intended projection instead of forcing selection and visual order
to match.

### 6. Spec And Test Migration

Update `docs/spec/ui-behavior.md` and `docs/spec/outliner-parity-matrix.md` in
the same change as the behavior.

Required tests:

- Unit tests for selectable-row order:
  - body row -> field entry -> field value rows -> following body row
  - nested field value rows
  - collapsed/expanded reference rows with cycle guard
  - hidden field reveal rows excluded
  - synthetic `sysref:*` rows policy
- Unit tests for batch planning:
  - parent + value child collapses to parent
  - field value delete routes to field-value removal
  - synthetic values are disabled
  - mixed body/value selection partitions correctly
- E2E:
  - Shift-click body row to value row selects the full cross-container range
  - Cmd/Ctrl-click toggles body and value rows in the same selection
  - Cmd/Ctrl+A from a selected field value selects the panel visible scope, not
    just the value scope
  - Delete on selected auto-collected value preserves option-pool invariants
  - Duplicate/move behavior matches the approved field-value policy
- Update or replace the old value-scope e2e that currently asserts field-only
  Cmd/Ctrl+A.

Run `bun run typecheck`, `bun run test:renderer`, `bun run test:core`, and the
relevant Playwright e2e selection tests before marking the implementation PR
ready.

## Implementation Sequence

PM decision, 2026-06-03: complete the foundation and the Phase 2 behavior change
in the same PR so the PR is a complete feature, not a partial foundation.

The PR should still keep the build sequence disciplined:

- Thread `selectionRootId` separately from render `rootId`.
- Include stored field value rows in the panel-level selectable order.
- Keep `flattenVisibleRows` as the visual/editing row-order helper.
- Rewire pointer, keyboard, drag, context-menu, and clipboard paths to consume
  the selectable-row model.
- Implement field-value-aware batch planning/commands.
- Apply the approved `sysref:*` synthetic value policy.
- Update specs and replace the old value-scope e2e expectation with
  cross-container selection coverage.
- Verify with `bun run typecheck`, `bun run test:renderer`,
  `bun run test:core`, and the relevant Playwright selection tests.

## Decisions

1. **Scope:** full panel-level selection unification is approved for this PR.
2. **Move:** selected field values may reorder only within their owning field
   entry; cross-parent `Move to`, indent, and outdent filter them out.
3. **Duplicate:** plain field values may clone as sibling values. Reference and
   option-style field values preserve field dedupe and no-op when cloning would
   create a duplicate target/value.
4. **Synthetic system values:** synthetic `sysref:*` rows may participate in
   reference/navigation affordances, but destructive and mutable batch actions
   are disabled.

## Files

Expected primary implementation files:

- `src/renderer/state/document.ts`
- `src/renderer/state/visualRows.ts`
- new or updated selectable-row model module under `src/renderer/state/`
- `src/renderer/ui/outliner/useOutlinerRowInteraction.ts`
- `src/renderer/ui/outliner/OutlinerView.tsx`
- `src/renderer/ui/outliner/FieldValueOutliner.tsx`
- `src/renderer/ui/outliner/SystemReferenceValues.tsx`
- `src/renderer/ui/outliner/OutlinerItem.tsx`
- `src/renderer/ui/outliner/OutlinerFieldRow.tsx`
- `src/renderer/ui/useWorkspaceKeyboard.ts`
- `src/renderer/ui/interactions/dragSelection.ts`
- `src/renderer/ui/interactions/contextMenuSelection.ts`
- `src/renderer/ui/interactions/selectionBatchActions.ts`
- `src/renderer/ui/interactions/selectionActions.ts`
- `src/renderer/ui/interactions/selectionKeyboard.ts` if action policy changes
- `src/renderer/api/client.ts` and `src/main/documentService.ts` only if a new
  field-value-aware batch command is needed
- `src/core/core.ts` only if renderer-side partitioning cannot preserve cleanup
  semantics with existing commands

Expected tests:

- `tests/renderer/outlinerParity.test.ts`
- `tests/renderer/visualRows.test.ts`
- new renderer tests for selectable rows / batch planning
- `tests/core/core.test.ts` if new core batch command or duplicate semantics are
  added
- `tests/e2e/outliner-selection-keyboard.spec.ts`
- possibly `tests/e2e/outliner-selection.spec.ts`

## Rollout Checklist

- [x] PM confirms the decisions above.
- [x] Build selectable-row model and unit-test row order/policy.
- [x] Split render root from selection root in row components and interaction
      hooks.
- [x] Include stored field value rows in the panel-level selectable order.
- [x] Rewire pointer, keyboard, drag, context-menu, and clipboard selection paths
      to the panel-level model.
- [x] Implement field-value-aware batch planning/commands.
- [x] Handle or exclude synthetic read-only system value rows.
- [x] Update recursive/flat row-order parity tests for the intentional visual vs
      selectable projection split.
- [x] Update e2e coverage for cross-container selection and old value-scope
      Cmd/Ctrl+A behavior.
- [x] Update specs in `docs/spec/`.
- [x] Verify with `bun run typecheck`, `bun run test:renderer`,
      `bun run test:core`, and relevant Playwright selection tests.
