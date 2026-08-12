# Table Field Column Semantics

**Shape:** (a) ONE complete feature in one PR. The value projection fix,
first-entry column defaults, expanded-record behavior, picker ordering, current
specification updates, and regression coverage ship together because they define
one Table field model.

## Goal

Make Table treat authored fields consistently as columns. A user switching an
outline or saved search to Table should immediately see columns for the authored
fields used by its current records, see the corresponding target-backed values
for reference results, and configure hidden columns from the header instead of
finding duplicate field rows inside expanded records.

## Non-goals

- Do not change the command protocol or persisted view/display-field node shape.
- Do not add every derived system field by default.
- Do not materialize missing field entries or values merely to populate headers.
- Do not add live schema-following while a view remains in Table; defaults are
  reconsidered only on a later transition into Table.
- Do not change Outline rendering or the semantics of sort, filter, and group
  rules.

## Design

### Entering Table

`set_view_mode` remains the single mutation for every entry path. On a real
transition from Outline to Table, core inspects the current direct record rows,
resolves reference chains to their final targets, and collects the active custom
field definitions used by those targets. For each collected definition that has
never had a display-field node in this view, the same transaction creates a
visible display field after the existing configured columns.

Existing display-field nodes are authoritative. Visible columns keep their
order and settings; hidden columns remain hidden; a view whose user hid every
column remains Title-only. New defaults follow Schema order for deterministic
placement. System fields are never defaulted. Repeating Table mode without an
Outline transition performs no initialization.

### Reference-backed values

All view reads resolve a reference chain to one final display target with cycle
and missing-target degradation. Table cell lookup, display text, sort, filter,
group, field-choice discovery, and edit targeting therefore agree for ordinary
records, direct references, and saved-search results that reference another
reference. A broken or cyclic chain renders an empty value rather than blocking
the table.

### Expanded records

Within Table, authored field entries are represented only by columns. Expanding
a record renders its ordinary child nodes and independently configured nested
views, but no field-entry rows, including entries for hidden or not-yet-added
columns. Hiding a column does not delete its data: the field remains discoverable
and restorable through Display and Add column.

The rendered tree, disclosure child count, keyboard navigation, and selectable
row model use the same suppression rule so invisible field rows cannot remain
focusable or affect disclosure state.

### Column configuration

The Table header exposes Hide as its one column-removal action. The existing
remove command remains protocol-compatible, but Table does not offer a second
destructive-looking `Remove from view` action whose deleted configuration would
be defaulted again on the next Table transition.

Add column is searchable and grouped in this order:

1. custom fields currently used by at least one record;
2. other active reusable custom fields;
3. supported system fields.

Each custom group follows Schema order; system fields keep their established
order. Already visible fields are omitted. A hidden field remains available and
restores its existing width, order, label, and placement. New field remains a
separate final command.

### Current specification

Rewrite the current Table contracts in `docs/spec/ui-behavior.md` and
`docs/spec/design-system/surfaces.md`: first-entry custom-column defaults,
reference-chain value resolution, field-free expansion, Hide-only header
removal, and custom-first Add ordering replace the previous Title-only default
and hidden-field expansion behavior.

### Verification

- Core tests prove the first transition creates only missing used custom
  display fields, preserves hidden configuration, follows Schema order, and
  leaves system fields absent.
- Renderer tests prove reference-chain value/field discovery and field-free
  expanded row/selectable models degrade safely on broken cycles.
- Table E2E covers ordinary and saved-search records, automatic headers and
  values, hide persistence across Outline/Table switching, expanded records,
  Add ordering/search/restoration, and the absence of Remove from view.
- Run typecheck, core and renderer suites, the focused Table E2E suite,
  `docs:check`, and light/dark visual verification of the saved-search Table.

### Affected files

- `src/core/core.ts` and `tests/core/core.test.ts` own transition-time default
  column materialization.
- `src/renderer/state/outlinerRows.ts` and
  `src/renderer/state/selectableRows.ts` own reference-chain reads and the
  shared field-free Table expansion model.
- `src/renderer/ui/outliner/OutlinerTableView.tsx` owns cells, header actions,
  and the grouped Add column surface.
- `tests/renderer/rowInteractions.test.ts` and `tests/e2e/table-view.spec.ts`
  pin projection and complete interaction behavior.
- `docs/spec/ui-behavior.md` and `docs/spec/design-system/surfaces.md` replace
  the previous Table contracts in the same change.

### Risks and collision result

- Defaulting must distinguish a missing display-field node from an existing
  hidden node; otherwise switching views would undo an explicit user choice.
- Reference chains may be missing or cyclic at runtime. Reads must degrade to
  empty values and must never block rendering or a user action.
- Suppression must cover visual rows, disclosure, keyboard selection, and child
  counts together so a field cannot become invisible but focusable.
- Open Draft PRs #531 and #532 have no file overlap. Draft PR #533 is expected
  to touch `src/core/core.ts` for persistence internals, but not `setViewMode` or
  view configuration. This branch keeps its core change local to those symbols
  and rebases after #533 if merge ordering requires it.

## Open Questions

None. The PM ratified the behavior above on 2026-08-12.
