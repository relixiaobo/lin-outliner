# Table View

## Purpose And Reader

This plan is the product and implementation contract for PM ratification and for
the dev agent that will build Table view after approval. It records what was
learned from Tana, which parts fit Tenon's existing model, and the observable bar
for the complete feature.

## Goal

Let a user render any node's direct children as a compact, editable table without
changing the underlying outline data. The table must feel like another view of
the same nodes: switching back to Outline preserves content, fields, expansion
state, filters, sort rules, and the configured columns.

This is shape **(a): one complete user-visible feature in one PR**. The PR ships
view switching, table rendering and editing, column configuration, keyboard and
accessibility behavior, persistence, documentation, and tests together. There is
no independently shipped scaffold.

## Non-goals

- Cards and Calendar rendering, even though their protocol values already exist.
- Grouped table sections. A table ignores a saved group rule without deleting it;
  Outline uses it again after switching back.
- Multi-cell ranges, copy/paste matrices, fill handles, spreadsheet formulas,
  numeric summaries, pagination, frozen columns beyond Title, or column pinning.
- Drag-reordering columns. The first version uses explicit Move left / Move right
  commands; the stored order leaves room for drag reordering later.
- Inferring columns from every child or bulk-creating empty field entries.
- Promoting a table configuration into a supertag template or propagating it to
  other nodes.
- A migration or legacy reader. Existing development data already has compatible
  view and display-field nodes.

## Objective, Constraints, And Decision

- **OBJ-1:** Make structured child nodes scannable and editable across columns
  while preserving the outliner's node-first model.
- **CON-1:** All document writes remain Core commands; table UI does not mutate a
  projection locally or introduce renderer-only document state.
- **CON-2:** The persisted mode remains `list | table | cards | calendar`.
  Product copy says **Outline** for `list`; Cards and Calendar stay hidden until
  they have complete renderers.
- **CON-3:** Existing display-field nodes remain the only column configuration.
  Title is a fixed, synthetic first column and is not stored as a display field.
- **CON-4:** The table must use the existing alpha-on-ink tokens, neutral
  functional states, focus-visible treatment, native scrolling, light/dark
  themes, and accessibility-preference fallbacks.
- **CON-5:** Large outlines must retain windowed rendering. Table mode cannot
  mount every row merely because cells share a grid.
- **DEC-1:** Implement a dedicated table renderer over the shared row projection
  and command surface. Do not make each row an independent HTML table and do not
  retrofit spreadsheet semantics into `OutlinerItem`.
- **DEC-2:** Offer Outline / Table from a node's **View as** submenu and from a
  compact mode control in the revealed view toolbar. Changing mode does not
  automatically reveal the toolbar.
- **DEC-3:** Table columns are Title plus visible display fields in stored order.
  A view with no display fields is a valid Title-only table.
- **DEC-4:** Add column can select an existing active field definition or create
  a new definition with the existing field-type choices. Creating a column never
  adds empty entries to all rows.
- **DEC-5:** An absent field entry remains absent while its cell is merely
  hovered, focused, or selected. The entry is attached to the row only when the
  user starts editing it.

## Evidence And Reference Findings

- **EVD-1:** Local inspection used Tana Outliner 1.523.0 and the supplied table
  screenshot. Tana treats Outline and Table as views over the same child nodes,
  entered through **View as**, rather than as separate copied data.
- **EVD-2:** Tana's table fixes Title as the first column, maps rows to direct
  children, maps additional columns to fields, and provides a trailing empty row
  for child creation.
- **EVD-3:** Tana keeps the view toolbar hidden by default. In Table it exposes
  Filter, Sort, and Display; Group is not offered. Sort rule order defines
  precedence.
- **EVD-4:** Tana's table is a dense, unframed content surface: approximately
  32px rows, quiet separators, compact anchored menus, inline editors, and no
  decorative outer card. Tenon should reproduce that information architecture,
  not Tana's blue functional-state color.
- **EVD-5:** Tana creates a child from the bottom row or from Enter at the end of
  the Title cell. Empty field cells do not need eager materialization.
- **EVD-6:** Official reference:
  [Views](https://outliner.tana.inc/learn/features/views.md) and
  [Fields](https://outliner.tana.inc/learn/features/fields).
- **EVD-7:** Tenon already persists `viewMode`, `displayVisible`, `displayWidth`,
  `displayOrder`, and `displayLabel`; already implements view filters, ordered
  sort rules, display-field projection, typed field editors, and trailing draft
  materialization. The missing work is rendering, interaction integration, and
  reading stored display order.

## Product Model

### Rows

- A table owned by node `P` renders `P`'s direct content and reference children
  after applying the existing filter and ordered-sort projection.
- `P`'s own direct field-entry children remain ordinary field rows outside the
  table. They describe `P`; they are not records in `P`'s child table.
- A reference row edits the same target-backed values that Outline currently
  exposes. Reference identity and cycle protection remain unchanged.
- Expanded child nodes may own their own independent Outline or Table view. A
  nested table has its own label, columns, horizontal scroll area, selection
  scope, toolbar visibility, filters, and sort rules.
- Filtered-out children remain recoverable through the existing disclosure. When
  expanded in Table, they render under the same column grid and remain visually
  distinguished without changing their data.
- A search node may render results in Table, including filters and sorting, but
  does not show a create-child draft row because search results are derived.

### Columns

- Title is always visible, first, non-removable, and wide enough to remain the
  primary node identity. It contains the node bullet/disclosure affordance,
  editable title, reference treatment, and existing row context-menu entry.
- Each visible display-field node contributes one column. Duplicate field
  definitions are rejected in Add column and remain deterministic if old data
  already contains duplicates.
- Columns sort by finite `displayOrder`, then by their child order under the view
  definition, then by id. Missing orders are normalized only after the user
  reorders; merely opening a table does not rewrite data.
- `displayLabel` overrides the field definition's current title. Otherwise the
  live field title is used.
- `displayWidth` is clamped to a usable token-derived minimum and a documented
  maximum. Dragging a header divider previews locally and persists one final
  width on pointer release; double-click restores automatic width.
- The header menu exposes Rename for this view, Hide, Move left, Move right, and
  Remove from view. Renaming changes `displayLabel`, never the field definition.
- **Add column** opens an anchored searchable menu of active field definitions,
  excluding fields already displayed. Its create path asks for a name and an
  existing field type, atomically creates the definition and display-field node,
  and focuses the new header.

### Cells

- Existing field entries reuse the current type-aware field value behavior:
  plain text, number, URL, email, date, checkbox, options, references, and the
  current system-field display rules.
- Missing field entries render as quiet empty cells. Enter, double-click, or a
  printable key creates an entry attached to the selected field definition and
  enters the correct editor. Escape before a meaningful value is committed
  removes a newly created empty entry when the existing draft semantics allow it.
- Read-only system fields remain read-only. Done retains its existing direct
  toggle behavior; table view does not invent editors for Created, Updated, or
  other derived values.
- Selecting or hovering a cell is UI state only. It does not create an undo step,
  update timestamps, or dirty the document.
- Title editing keeps existing rich-text and trigger behavior. Field cells keep
  the existing value model rather than accepting arbitrary rich text.

## Flows And Screens

### FLOW-1: Switch A Node To Table

1. Open the node context menu and choose **View as > Table**, or choose Table in
   the revealed view toolbar.
2. The command persists `table` on that node's view definition.
3. The same direct children render immediately as rows. Existing filters, sort
   rules, and display fields apply; a view without display fields shows Title
   only.
4. Switching back through **View as > Outline** restores the previous outline
   presentation and any saved grouping.

### FLOW-2: Configure Columns

1. Reveal the view toolbar and open Display, or use **Add column** in the header.
2. Toggle an existing display field, add an active field definition, or create a
   new field definition and column.
3. Reorder through the header menu, resize from the divider, rename for this
   view, or remove the column.
4. The table updates without mutating any row that lacks that field.

### FLOW-3: Edit An Existing Or Empty Cell

1. Click a cell to establish a single active grid cell.
2. Enter or double-click starts editing; a printable key starts editing and
   seeds the editor with that key.
3. If the field is absent, one command attaches an entry to the existing field
   definition before the editor opens.
4. Commit and cancellation reuse the field editor's existing semantics. Focus
   returns to the same logical cell after projection refresh.

### FLOW-4: Create Rows

1. Focus the bottom Title draft cell and type, or press Enter from the last
   editable Title cell.
2. Existing eager draft materialization creates one direct child in current
   visible order and focuses its Title cell.
3. Enter in a non-final Title cell moves to the next row; it does not insert a
   sibling in the middle unless the existing row command explicitly requests it.
4. Derived search-result tables omit this draft row.

### SCREEN-1: Table Surface

```text
 [Outline | Table]   Filter   Sort   Display
 ───────────────────────────────────────────────────
 Title                         Status        Due   +
 ───────────────────────────────────────────────────
 ▸ Prepare launch              In progress   Jul 20
   Review copy                 Done          Jul 18
   Write a new item...
```

The toolbar appears only when the stored toolbar flag is on. The table itself is
full-width within the panel content area, unframed, and horizontally scrolls in
that panel when columns exceed available width. The panel's vertical scroller
remains authoritative.

## Functional Requirements

- **FR-1:** Every eligible node shall switch between Outline and Table through
  one persisted view-mode command without copying, reparenting, or rewriting its
  child nodes.
- **FR-2:** Table shall render direct content/reference children as rows and
  visible display fields as columns after existing sort and filter rules.
- **FR-3:** Title shall remain the first visible column when all optional columns
  are hidden or absent.
- **FR-4:** Table shall honor `displayOrder`, `displayWidth`, `displayLabel`, and
  `displayVisible`, with deterministic fallback ordering for old configurations.
- **FR-5:** A user shall add an existing active field definition as a column or
  create a new typed definition and column without creating entries on rows.
- **FR-6:** A user shall resize, restore automatic width, relabel, hide, remove,
  and explicitly move an optional column left or right.
- **FR-7:** Existing typed field values shall remain editable through their
  established validation and command paths.
- **FR-8:** Starting to edit an absent field cell shall attach exactly one entry
  to the selected definition; focusing or hovering it shall attach none.
- **FR-9:** The trailing Title draft shall create a normal direct child and shall
  be absent for derived search results.
- **FR-10:** Filtered-out disclosure shall remain available and shall display
  disclosed rows with the same columns.
- **FR-11:** Table shall ignore, but never clear or overwrite, a stored group
  field. The Group control shall be absent while the active mode is Table.
- **FR-12:** Nested expanded nodes shall independently honor their own persisted
  view mode and configuration.
- **FR-13:** A table shall retain windowed vertical rendering and stable scroll
  anchoring for large row sets.
- **FR-14:** The active cell shall survive projection refresh by logical
  `(table owner, row id, field id)` identity whenever that cell still exists.
- **FR-15:** All visible copy, menu labels, tooltips, and accessibility names
  shall ship in English and Simplified Chinese.
- **FR-16:** Switching to Table shall widen the root content surface to the
  panel's usable width; overflowing columns shall use a local native horizontal
  scrollbar without widening sibling panels.

## Keyboard And Accessibility

- **BR-1:** A table uses `role="grid"`; headers use `columnheader`; data cells use
  `gridcell`; each logical record uses `row`. Nested tables are separately named
  grids rather than one invalid nested row set.
- **BR-2:** Exactly one cell participates in the tab order. Arrow keys move the
  active cell without entering edit mode. Home/End move to first/last cell in a
  row; Cmd/Ctrl+Home and Cmd/Ctrl+End move to the first/last available cell.
- **BR-3:** Tab and Shift+Tab commit the current edit and move forward/backward
  through editable cells. At the final cell, Tab reaches the next normal UI
  control instead of trapping keyboard focus.
- **BR-4:** Enter starts editing an inactive cell, commits an active editor, or
  moves vertically according to the current editor contract. Escape cancels an
  editor first; a second Escape returns focus to the owning table surface.
- **BR-5:** A printable key on an editable inactive cell starts editing with that
  character. Command shortcuts, dead keys, and IME composition are not consumed
  by the grid resolver.
- **BR-6:** Column resize handles are keyboard operable in fixed increments and
  expose current width; header menus provide every resize/reorder action that is
  otherwise pointer accessible.
- **NFR-1:** Rows use a stable minimum height near Tana's dense 32px rhythm while
  allowing wrapped titles and field values to grow without overlap.
- **NFR-2:** All fills, separators, text, focus, shadows, and materials use design
  tokens. Functional state is neutral, never Tana blue or the rose brand accent.
- **NFR-3:** Hover shall not alter row, column, icon, or control geometry.
- **NFR-4:** Light, dark, increased contrast, reduced motion, and reduced
  transparency presentations shall remain legible and coherent.

## Edge Cases And Recovery

- Deleting or deactivating a displayed field definition keeps the view
  recoverable: the column resolves to its stored label/identity where possible
  and can be removed; it never crashes the renderer.
- Removing the active row or column moves focus to the nearest surviving cell.
  Removing the final row moves focus to the draft Title cell when available.
- Concurrent column changes converge through the stored display-field nodes.
  Duplicate or missing order values use the deterministic fallback rather than
  triggering a write loop.
- Invalid stored widths clamp at render time. They are normalized on the next
  explicit user resize, not on read.
- A failed command leaves the prior projection and active logical cell intact
  and uses the existing command error path; the UI does not synthesize success.
- A reference cycle preserves the current cycle guard and does not recursively
  mount a nested table.
- A narrow panel keeps Title usable and scrolls optional columns horizontally;
  header and body share one width model so they cannot drift.

## Acceptance Criteria

- **AC-1:** Given a node with children and no display fields, when the user
  chooses View as > Table, then a Title-only table shows the same children and a
  refresh preserves Table mode.
- **AC-2:** Given a table with configured fields, when the user switches between
  Outline and Table, then node content, field values, filters, sort rules,
  toolbar visibility, column order/width/labels, and the saved group rule remain
  unchanged.
- **AC-3:** Given ordered sort rules and a filter, when Table renders, then rows
  match the existing view projection and expanded filtered-out rows use the same
  column alignment.
- **AC-4:** Given an absent row field, when the cell is hovered, clicked, or
  reached with arrow keys, then no command runs and no field entry appears.
- **AC-5:** Given that same absent field, when the user presses Enter,
  double-clicks, or types a printable key, then exactly one field entry attaches
  to the selected definition and the correct typed editor receives focus.
- **AC-6:** Given an existing active field, when it is added as a column, then no
  child row is mutated and the column is available after restart.
- **AC-7:** Given a newly named typed field in Add column, when creation commits,
  then one field definition and one display-field node are created atomically;
  no row entries are created.
- **AC-8:** Given optional columns, when a user moves, resizes, auto-resets,
  relabels, hides, or removes one, then the table updates immediately and the
  result survives restart.
- **AC-9:** Given a stored group field, when Table is active, then no grouped
  sections or Group control appear; when Outline is restored, then the previous
  grouping reappears.
- **AC-10:** Given keyboard-only use, when focus traverses cells, editors,
  headers, resize handles, and menus, then every command is reachable, focus is
  visible, and Tab can leave the table.
- **AC-11:** Given 5,000 text-only child rows, when the user scrolls through Table,
  then only a bounded window plus required focus rows is mounted and scroll
  anchoring does not jump after row measurement.
- **AC-12:** Given an expanded child configured as Table, when its owner is shown
  inside an Outline or another Table, then the nested grid has independent
  columns, controls, horizontal scrolling, and an accessible name.
- **AC-13:** Given a derived search-result node in Table mode, when results
  render, then filtering/sorting/editing work but no new-row draft is offered.
- **AC-14:** Given light/dark and accessibility preference variants at desktop
  and narrow split-panel widths, when visually inspected, then the table is
  unframed, dense, token-correct, aligned, non-overlapping, and locally scrollable.

## Suggested Implementation Boundaries

### Shared projection and commands

- Teach `readViewConfig` to retain `displayOrder` and expose a deterministic
  ordered visible-column projection.
- Keep `set_view_mode`, `add_display_field`, `update_display_field`, and
  `create_inline_field` as the command names. Extend existing payload handling
  only where atomicity is required:
  - `create_inline_field` accepts an optional existing `targetDefId` so a missing
    cell attaches directly without creating then merging definitions;
  - `add_display_field` accepts an optional create-definition input so definition
    plus display node is one Core mutation.
- Do not edit the command-name registry or add a new `ViewMode`; avoid
  `src/core/commands.ts` and `src/core/types.ts` unless implementation proves an
  unavoidable typed contract gap, in which case stop for coordination first.

### Renderer

- Add an `OutlinerTableView` and small table-cell/header/navigation modules. It
  consumes the same row projection, UI state, command runner, field renderers,
  context menus, and draft materialization as Outline.
- Make `OutlinerFlatView` / fallback `OutlinerView` dispatch each owner scope by
  its view mode. Extend `visualRows` and `selectableRows` so table-owned rows do
  not also appear as outline rows and selection actions resolve the correct row
  identity.
- Keep cell navigation as a pure resolver over row/column identities, separately
  tested from DOM focus effects. Store only ephemeral active/editing cell state
  in renderer UI state.
- Add Outline/Table switching to `NodeContextMenu` and `ViewToolbar`; suppress
  Group in Table while keeping its stored value.
- Let root tables opt out of the 720px prose-content maximum and consume the
  panel's usable width. Keep nested grids contained by their owner scope.

### Expected files

- `src/renderer/state/outlinerRows.ts`
- `src/renderer/state/visualRows.ts`
- `src/renderer/state/selectableRows.ts`
- `src/renderer/ui/outliner/OutlinerTableView.tsx` and focused table helpers
- `src/renderer/ui/outliner/OutlinerFlatView.tsx`
- `src/renderer/ui/outliner/OutlinerView.tsx`
- `src/renderer/ui/outliner/OutlinerItem.tsx`
- `src/renderer/ui/outliner/FieldValueOutliner.tsx`
- `src/renderer/ui/outliner/ViewToolbar.tsx`
- `src/renderer/ui/outliner/NodeContextMenu.tsx`
- `src/renderer/ui/PanelShared.tsx`
- `src/renderer/ui/NodePanel.tsx`
- `src/renderer/styles/outliner.css`
- `src/core/core.ts`
- `src/main/documentService.ts`
- `src/renderer/api/client.ts`
- Renderer English/Chinese localization modules
- Focused Core, renderer, and Electron E2E tests, including `outlinerMock.ts`
- `docs/spec/ui-behavior.md`
- `docs/spec/outliner-parity-matrix.md`
- `docs/spec/design-system/surfaces.md`

Development agents do not edit main-owned `docs/TASKS.md` or `CHANGELOG.md`.

## Verification

- Pure tests: view configuration ordering, row projection by mode, logical-cell
  navigation, focus recovery, width clamping, and command atomicity.
- Renderer tests: view menus/toolbars, table DOM/ARIA, typed existing and absent
  cell editing, filter/sort/display behavior, draft/search differences, nested
  tables, reference cycles, selection integration, and bounded windowing.
- E2E: switch/persist mode; add/create/reorder/resize/relabel/remove columns;
  keyboard traversal; create rows; edit representative field types; return to
  Outline with grouping preserved.
- Visual verification in light and dark at full panel, split panel, and narrow
  widths; include increased contrast and reduced motion/transparency checks.
- Required repository gates: `bun run typecheck`, `bun run test:core`,
  `bun run test:renderer`, relevant `bun run test:e2e`, `bun run docs:check`, and
  `git diff --check`.

## Risks

- **R-1:** The flat outliner's one-dimensional focus and selection model can
  conflict with two-dimensional grid navigation. Mitigation: stable logical cell
  identities, a pure navigation resolver, and one integration point for DOM
  focus.
- **R-2:** Reusing field editors may import outline indentation or nested-row
  geometry into cells. Mitigation: separate table-cell presentation from the
  shared value/editing behavior and add wrapped/empty/validation visual fixtures.
- **R-3:** Header/body widths can drift under virtualization. Mitigation: one
  column-width model shared by header and every mounted row; resize tests cover
  horizontal and vertical scrolling together.
- **R-4:** Materializing a missing cell through two commands can leave an orphan
  definition or duplicate entry. Mitigation: extend the existing command payload
  and perform attachment in one Core mutation.
- **R-5:** Nested tables can defeat windowing or create invalid nested grid
  semantics. Mitigation: each expanded owner is an independent labelled grid and
  the visual-row producer remains the authority for mounted vertical scopes.

## Collision Result

Checked on 2026-07-17 against `origin/main`, `docs/TASKS.md`, and open PR claims.
Open PR #407 covers event-sourced Issue persistence; #408 covers persistent
preview translation cache. Neither claims the outliner renderer, field/view
commands, table styles, localization, or the specs listed above. **No current
file or behavioral overlap was found.** Re-run the check immediately before the
Draft PR claim because command and outliner surfaces are shared areas.

## Open Questions

- **OQ-1:** Ratify the proposed complete first-release boundary: Add column
  includes both existing-field selection and new typed field creation, while
  multi-cell spreadsheet behavior and summaries remain deferred.
- **OQ-2:** Ratify that Enter in the last Title cell creates the next row, while
  Enter elsewhere moves vertically. This follows Tana and avoids introducing a
  second mid-list insertion rule into field cells.
- **OQ-3:** Ratify the naming split: user-facing **Outline**, persisted protocol
  value `list`. This avoids a protocol migration and aligns the menu with Tana's
  familiar language.

## Implementation Tasks

- [ ] Settle ordered column and atomic command payload contracts first.
- [ ] Add pure projection, grid navigation, width, and focus-recovery tests.
- [ ] Implement table/header/cell rendering with bounded windowing.
- [ ] Integrate typed editing, missing-entry materialization, drafts, selection,
      nested owners, filters, and sorting.
- [ ] Add view switching and column menus with English/Chinese copy.
- [ ] Finish tokenized responsive styling, ARIA, and accessibility preferences.
- [ ] Update current-behavior specs in the same change.
- [ ] Run full automated and visual verification before marking the PR ready.
