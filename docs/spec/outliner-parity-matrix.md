# Outliner parity matrix

This matrix tracks the nodex outliner behavior that Tenon must preserve.
Every implemented row should pass through shared interaction resolvers before
component-specific code handles the effect.

Reference sources:

- `/Users/lixiaobo/Documents/Coding/nodex/src/components/outliner/OutlinerRow.tsx`
- `/Users/lixiaobo/Documents/Coding/nodex/src/lib/selection-keyboard.ts`
- `/Users/lixiaobo/Documents/Coding/nodex/src/lib/row-pointer-selection.ts`
- `/Users/lixiaobo/Documents/Coding/nodex/src/hooks/use-drag-select.ts`
- `/Users/lixiaobo/Documents/Coding/nodex/src/components/tags/BatchTagSelector.tsx`
- `/Users/lixiaobo/Documents/Coding/nodex/src/components/editor/RichTextEditor.tsx`
- `/Users/lixiaobo/Documents/Coding/nodex/src/components/editor/TrailingInput.tsx`
- `/Users/lixiaobo/Documents/Coding/nodex/src/components/outliner/BulletChevron.tsx`
- `/Users/lixiaobo/Documents/Coding/nodex/src/lib/ime-keyboard.ts`

## Public Capability Parity

Every persisted behavior below has one actor-neutral Runtime path. Desktop
intents, CLI porcelain, built-in Agent workflows, and external automation lower
to the same public Change union; only presentation and causation differ.

| Behavior domain | Public contract | Porcelain / capability | Evidence |
| --- | --- | --- | --- |
| Deterministic read and discovery | exact ID/ID-list/query/live-search `Selector`, `TargetSpec`, bounded `Projection` | `get`, `find`, `search run`, `export`; exact and named batch counts | Revisioned `ProjectionResult`, count results, and resumable export records |
| Tree and content creation | `ensure`, `create`, typed `NodeDraft`, `update` | semantic `create`, `edit`, `daily ensure`, `capture create` | Committed-state verified receipt; one durable `Operation` |
| Structure and batch order | placement-based `create`, `move`, `duplicate`, and `merge` | first/last/index/before/after plus move/duplicate previous/next | Affected before/after digests, one Operation, exact revert, and projection Event |
| Done, tags, fields, and definitions | typed `update`, `create`, `merge`, `template` instructions | `edit`, `define create|ensure|edit`, `template apply` | Schema validation plus atomic Operation |
| References, views, and searches | typed reference/view/search update instructions and exact executable query-rule union | `edit`, `view get|set`, `search create|edit|run` | Same Node identities across every View; registry/schema/executor parity |
| View-backed collection creation and verification | ordinary owner/items/Field values plus declarative View configuration | one mode-neutral `create --input -`; receipt-backed verification and `view get` when independently requested | One atomic Operation; no table/row/card/event persistence type |
| Trash and permanent removal | `lifecycle` | `trash`, `restore`, `purge` | Destructive Diff binding; retained recovery patch |
| History and exact recovery | Operation ID and recovery state | `history`, `revert`, `undo`, `redo` | Reversal is another linked Operation |
| Asset-backed media | `AssetLease` plus ordinary Node and built-in URI-Field mutations | `asset ingest`, `asset get`, `asset export`; Source changes use semantic `edit` | Host-verified exact revisions behind opaque anchors; live/lease/recovery reachability |
| Bulk import | ordinary bindings plus `ensure`/`create`/`update` | `import inspect`, `import plan`, exact `apply`, and `import verify` | Coverage evidence, ChangeSet hash, Diff hash, Operation ID |
| Complete single resource | typed `NodeDraft` or resource-specific create/update union | one porcelain invocation; complex state uses that command's `--input` | Final-state golden, one mutation invocation, one Operation, returned IDs, exact revert |
| Dependent or bounded bulk resources | one ChangeSet with bindings and `many + max` | one `transact`, or `preview` plus exact `apply` when reviewed; no shell loop or intermediate ID lookup | Golden ChangeSet/Diff/Operation counts and exact revert |
| Bounded literal text transform | bounded Projection plus ordinary text-patch updates at one base revision | `replace text` with exact target or query `many + max`, replacement bound, and reviewed Diff | Rich marks/reference preservation, stale-plan rejection, convergence, one Operation, exact revert |
| CLI discovery | per-command capability schema plus help/completion metadata | Skill, matching example, exact help, narrow `schema --path`, full schema only when needed | Parser/help/completion drift guard and bounded disclosure goldens |

`src/outline/contract/capabilities.ts` owns the executable mapping from every
persisted Core command to one public capability and each command's exact CLI
schema, help, completion metadata, mutation semantics, and examples. Guard tests
fail on a missing or duplicate owner, parser/help/schema drift, a parallel
document authority, or a retired Agent/import write surface. Workflow goldens
also cover complete Search/table/definition/date/capture/media creation, bounded
query mutation, binding cross-reference, template backfill, merge/purge/Empty
Trash review, bounded literal replacement, idempotent convergence, visible
Operation settlement, and revert.

## State Model

| State | Meaning | Current owner |
| --- | --- | --- |
| Editing | A row editor/input owns focus and text shortcuts edit content. | `ui.focusedId` plus DOM focus |
| Single selection | One row is selected, no editor focus. | `ui.selectedIds`, `ui.selectionAnchorId` |
| Multi selection | More than one visible row is selected, no editor focus. | `ui.selectedIds`, `ui.selectionAnchorId` |
| Trigger menu | `#`, `@`, or `/` menu is open for a focused editor/trailing input. | `trigger` |
| Batch tag menu | Multi-selection `#` picker is open and must preserve selection. | `ui.batchTagSelectorOpen` |
| Context menu | Right-click menu operates on selection if opened from a selected row. | `NodeContextMenu` |
| Active table cell | One logical `(table owner, row id, column id)` address owns the grid tab stop outside an editor. | `OutlinerTableView` local state + `nearestTableCell` recovery |
| IME composition | Text input is composing and must not fire structural shortcuts or trigger actions. | `isImeComposingEvent` plus editor composition refs |

Selection mode uses the panel-level `buildSelectableRows` order. Visual and
editing navigation keep using the body/reference visible order from
`flattenVisibleRows` / `buildVisualRows`; field value rows render inside their
field row but still appear in the selectable-row order.

## Pointer And Focus

| Event | nodex behavior | Tenon rule | Test coverage |
| --- | --- | --- | --- |
| Plain click row editor | Enter editing for that row and leave block selection. | Plain click does not create block selection. | `rowInteractions.test.ts` |
| Cmd/Ctrl click row | Toggle row in block selection. | `resolveRowPointerSelectAction -> toggle`. | `rowInteractions.test.ts` |
| Shift click row | Select selectable range from anchor. | `resolveRowPointerSelectAction -> range` over `buildSelectableRows`. | `rowInteractions.test.ts` |
| Mouse drag row range | Select selectable rows between drag start and hover row; preserve browser text selection when dragging within the same text area. | `useDragSelection` owns document-level drag state and writes `ui.selectedIds`. | `outliner-selection.spec.ts` |
| Right-click selected row | Preserve existing multi-selection and open menu for batch actions. | Context click blocks editor focus before the menu opens. | `outlinerParity.test.ts`, `outliner-selection.spec.ts` |
| Click outside outliner | Clear block selection. | Global dismiss clears unless modifier/row/preserved popup. | `outlinerParity.test.ts` |
| Focus preserved popup | Do not clear selection. | `[data-preserve-selection]` is exempt. | `outlinerParity.test.ts` |
| Click context menu item | Do not clear selection before the menu action runs. | Context menu root uses `[data-preserve-selection]`. | `outlinerParity.test.ts` |
| Bullet click | Drill into the node page. | Bullet calls `onRoot(targetId)`. | `outliner-navigation-title.spec.ts` |
| Page title edit | Title editor writes to the root node. | `NodePanel` uses the same rich text editor semantics as rows. | `outliner-navigation-title.spec.ts` |
| Inspector panel | Not part of nodex outliner surface. | Main panel renders without inspector. | `outliner-navigation-title.spec.ts` |

## Selection Keyboard

| Key | nodex behavior | Tenon effect | Test coverage |
| --- | --- | --- | --- |
| Escape | Clear selection and re-enter edit. | `clear_selection`. | `outlinerParity.test.ts` |
| Enter | Edit first selected row. | `enter_edit`. | `outlinerParity.test.ts` |
| Printable char | Edit first selected row and insert/append char. | `type_char`. | `outlinerParity.test.ts` |
| ArrowUp / ArrowDown | Move editing focus before/after selected block. | `navigate_up/down`. | `outlinerParity.test.ts` |
| Shift+ArrowUp / Shift+ArrowDown | Extend selection from anchor. | `extend_up/down`. | `outlinerParity.test.ts` |
| Cmd/Ctrl+A | Select all selectable rows in the current selection root, even when no row is currently selected. Field value rows inherit the panel selection root rather than their nested render root. | `select_all`. | `outlinerParity.test.ts`, `outliner-selection-keyboard.spec.ts` |
| Backspace / Delete | Delete selected root rows by selectable-row policy. Ordinary rows trash; stored field value rows use field-value removal; synthetic rows are disabled. | `batch_delete`. | `outlinerParity.test.ts` |
| Tab / Shift+Tab | Batch indent/outdent selected root rows that are allowed to move structurally. A direct field value may indent under its previous direct sibling, but cannot outdent above its owning field entry. Descendants below a value are ordinary structural rows. | `batch_indent/outdent`. | `outlinerParity.test.ts`, `selectionBatchActions.test.ts`, `outliner-selection-keyboard.spec.ts` |
| Cmd/Ctrl+Shift+D | Batch duplicate selected root rows. | `batch_duplicate`. | `outlinerParity.test.ts` |
| Cmd/Ctrl+Enter | Cycle selected target nodes through no checkbox, undone checkbox, and done checkbox. | `batch_checkbox`. | `outlinerParity.test.ts`, `outliner-selection-keyboard.spec.ts` |
| # | Open batch tag selector. | `batch_apply_tag`. | `outlinerParity.test.ts`, `outliner-selection.spec.ts` |
| Cmd/Ctrl+C / Cmd/Ctrl+X | Copy/cut selected rows in selectable order. | `batch_copy/cut`. | `outlinerParity.test.ts` |
| Selection printable char | Focus first selected row and insert/append char. | `type_char` followed by row focus. | `outliner-selection-keyboard.spec.ts` |
| Selection ArrowUp/Down | Focus adjacent row outside selected block. | `navigationTarget`. | `outliner-selection-keyboard.spec.ts` |
| IME composition | Do not run selection shortcuts while browser reports composition, `Process`, or legacy key code `229`. | `isImeComposingEvent`. | `rowInteractions.test.ts` |

## Global Keyboard

| Key | nodex behavior | Tenon effect | Test coverage |
| --- | --- | --- | --- |
| Cmd/Ctrl+Shift+D with no row selection | Go to today's daily note. | `global.go_to_today` ensures today's date node and navigates the active panel. With a selection, `selection.duplicate` keeps owning the same chord. | `rowInteractions.test.ts`, `outliner-navigation-title.spec.ts`, `outliner-selection-keyboard.spec.ts` |
| Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z / Cmd/Ctrl+Y | nodex overloads no-editor Cmd/Ctrl+Z for page history. | Lin keeps these as document undo/redo globally and in editors. | `rowInteractions.test.ts`, `outliner-navigation-title.spec.ts` |
| Cmd/Ctrl+[ / Cmd/Ctrl+] | Not the nodex binding. | Navigate the active panel back/forward through page history. | `rowInteractions.test.ts` |
| Alt+ArrowLeft / Alt+ArrowRight | Not the nodex binding. | Navigate the active panel back/forward through page history only outside editable text; inside editors it remains platform word-navigation. | `rowInteractions.test.ts`, `outliner-navigation-title.spec.ts` |

## Table View

Table uses the same nodes, typed field editors, commands, and trailing-draft
materialization as Outline, but owns a two-dimensional focus surface. It does not
replace or reinterpret the panel-level block-selection model.

| Event | Tenon rule | Test coverage |
| --- | --- | --- |
| View as > Table / Outline | Persist `table` / `list` on the owner's view definition; never copy or reparent children. The Node context menu's **View as** submenu is the single view-mode entry point; the shared configuration toolbar does not duplicate it. On any real non-Table-to-Table transition, refresh Search results with the shared query evaluator, then append missing columns for current-record custom fields in Schema order while preserving hidden configuration and existing finite order and never defaulting system fields. An unevaluable Search keeps its last results but still changes mode. A saved group rule is ignored in Table and restored in Outline. | `search-query-builder.spec.ts`, `table-view.spec.ts`, `core.test.ts`, `searchQueryOutline.test.ts`, `rowInteractions.test.ts` |
| Arrow keys on inactive cell | Move within the logical row/column matrix and clamp at edges. | `tableNavigation.test.ts`, `table-view.spec.ts` |
| Home / End | Move to the first/last cell in the row; Cmd/Ctrl adds first/last row. | `tableNavigation.test.ts` |
| Tab / Shift+Tab | Move through logical cells. Inside an editor, blur commits before movement and outline indent/outdent is suppressed. Native Tab leaves at the first/last boundary. | `tableNavigation.test.ts`, `table-view.spec.ts` |
| Enter on inactive Title | Focus the ordinary rich title editor. Enter at the end of the final stored Title creates the next record; otherwise existing row-editing rules apply. | `table-view.spec.ts` |
| Enter / printable key on absent field | Atomically attach one entry to the configured definition and focus the typed editor; reference-backed rows write to the final target. Broken or cyclic chains stay empty and read-only. Hover, focus, click, and arrows perform no document write. | `table-view.spec.ts`, `rowInteractions.test.ts`, core tests |
| Column resize / move / rename / hide | Persist one display-field update; move normalizes the sibling display order atomically. The header offers Hide, not Remove from view. | `table-view.spec.ts`, core tests |
| Responsive geometry | Fill the available content width with a flexible Title track, stable readable field tracks, and trailing Add field; preserve minimum tracks through Table-local horizontal overflow in a narrow pane. Header UI text and row content retain their design-system typography roles. | `table-view.spec.ts` |
| Add / Display field order | Present current-record custom fields and other custom fields before supported system fields; restore hidden display fields without replacing their persisted configuration. In Table, Add field is the in-grid column entry point. | `table-view.spec.ts`, core tests |
| Expanded record in Table mode | Keep visible-column values selectable in their cells and omit active field entries from the expanded tree, disclosure count, keyboard model, and agent-visible outline. Restore an orphaned entry whose definition is missing or in Trash to every structural model so its values remain reachable. A nested Table remains one independent visual scope instead of flattening into the owning Outline. | `selectableRows.test.ts`, `userViewContext.test.ts`, `visualRows.test.ts`, `table-view.spec.ts` |
| Long table | Mount a bounded measured row window plus focus/draft rows and preserve the viewport anchor while estimates settle. | `table-view.spec.ts` |
| Search outline | Use the same full ViewToolbar as every other Node, default it open only while `toolbarVisible` is unset, and honor explicit Show/Hide choices. Omit query chips, result count, and manual refresh. The title query action temporarily replaces a visible toolbar with the query editor and restores only the effective configured state. | `search-query-builder.spec.ts`, `visualRows.test.ts`, `rowInteractions.test.ts`, `actionRegistry.test.ts` |
| Search table | Render derived results without a writable trailing draft; resolve complete reference chains for column values and edit attachment; use the same ViewToolbar structure and state as Search Outline above the pure field header, with column recovery in Add field. | `table-view.spec.ts`, `search-query-builder.spec.ts`, `rowInteractions.test.ts` |

## Row Editing

| Event | nodex behavior | Tenon rule | Test coverage |
| --- | --- | --- | --- |
| Enter at row end | Create an empty sibling after current row and focus it. | `handleEnter` + `create_node`. | `outliner-row-editing.spec.ts` |
| Backspace at start of empty row | Trash/delete row and keep focus on the previous visible row, next visible row, or trailing draft if it was the only body row. | `resolveContentRowBackspaceAtStartIntent`. | `outliner-row-editing.spec.ts` |
| Tab while editing | Indent current row under previous sibling and keep editor focus. | `indent_node` with focus offset restore. | `outliner-row-editing.spec.ts` |
| Shift+Tab while editing | Outdent current row and keep editor focus. | `outdent_node` with focus offset restore. | `outliner-row-editing.spec.ts` |
| ArrowUp/Down at editor boundary | Move focus to previous/next visible row. | `moveFocus`. | `outliner-row-editing.spec.ts` |
| Escape while editing | Exit to single selected-row mode. | `exitToSelection`. | `outliner-row-editing.spec.ts` |
| Multiline paste in row editor | Replace selected text with first pasted row, create parsed child rows under the current node, and create remaining parsed rows as following siblings. | `paste_nodes_into_node` keeps the paste as one core undo step. | `rowInteractions.test.ts`, `outliner-row-editing.spec.ts`, core tests |
| Inline markdown on paste | Pasted `**bold**`, `*italic*`, `~~strike~~`, `==highlight==`, `` `code` `` and `[text](url)` become the matching marks. Underscore variants are intentionally ignored to keep snake_case intact. | `parseInlineMarkdown` maps to `TextMarkKind`. | `pasteParser.test.ts`, `outliner-paste-format.spec.ts` |
| Inline formatting while typing | Typing low-ambiguity closing syntax converts `` `code` ``, `**bold**`, `~~strike~~`, `==highlight==`, and `[text](url)` into matching marks, drops the markdown delimiters, and leaves the caret outside the mark. `*italic*` and underscore variants are intentionally ignored while typing to avoid accidental conversion. ArrowLeft/ArrowRight at the start/end of an inline code mark can move the caret out of the mark even when there is no neighbouring plain text. | `RichTextEditor` handles closing input with `inlineMarkShortcuts`; the `code` mark is non-inclusive and boundary arrow handling chooses the outside DOM side. | `inlineMarkShortcuts.test.ts`, `outliner-row-editing.spec.ts` |
| Fenced code on paste | A ` ``` ` fence (markdown or HTML `<pre>`) becomes a `codeBlock` row; the fence language is normalized through the shared language alias map. | `parseMarkdownBlocks` / `htmlToTrees` emit a typed `CreateNodeTree`; `insertNodeTreeDirect` materializes it. | `pasteParser.test.ts`, `core.test.ts`, `outliner-paste-format.spec.ts` |
| Rich HTML on paste | When the clipboard carries genuine HTML structure (and the plain text is not strong markdown), headings, lists, paragraphs, `<pre>` and inline formatting are mapped into rows. | `parseClipboardPaste` routes to `htmlToTrees` via `DOMParser`; falls back to markdown when no DOM. | `outliner-paste-format.spec.ts` |
| Single-line URL on paste | A lone URL wraps the current selection as a link, or inserts a link-marked URL when there is no selection. | `detectSingleLineUrl` + `link` mark with `href`. | `pasteParser.test.ts`, `outliner-paste-format.spec.ts` |
| IME composition in row editor | Do not convert `>` into fields or open trigger menus until composition ends. | Rich text editor defers trigger/update actions during composition. | `rowInteractions.test.ts` |

## Context And Batch Operations

| Operation | nodex behavior | Tenon rule | Test coverage |
| --- | --- | --- | --- |
| Duplicate | Operate on top-level selected rows only. Plain field values may clone; reference/option-style values are filtered out instead of creating duplicate targets. | `selectedRootIds`, `selectionBatchActions`. | `outlinerParity.test.ts` |
| Trash | Operate on top-level selected rows only. Field value rows route to `remove_field_value`, not generic trash, so option-pool cleanup still runs. A single ref-clicked ordinary reference may hard-delete the reference row even if locked; a ref-clicked reference-valued field child still uses `remove_field_value`. | `selectedRootIds`, `selectionBatchActions`. | `outlinerParity.test.ts`, `outliner-selection.spec.ts` |
| Move up/down and drag | Reorder selected rows inside their current sibling list or drag selected structural roots to one drop target. Field value rows may reorder only inside their owning field entry. | Core batch move commands via selectable-row policy; selected block drag uses `batch_move_nodes` as one undoable operation. | core tests, `outliner-drag-drop.spec.ts` |
| Done | For references, toggle the target node, not the display reference row. | `targetIdsForRows`. | `outlinerParity.test.ts`, `outliner-selection-keyboard.spec.ts` |
| Add tag | Batch apply to selected target nodes; create tag then apply if needed. | `batch_apply_tag`. | core + renderer + E2E tests |
| Nested selected rows | Parent selection suppresses child duplicate/trash/move. | `selectedRootIds`. | `outlinerParity.test.ts` |
| Duplicate references to same target | Target operations are deduped. | `targetIdsForRows`. | `outlinerParity.test.ts` |
| Batch duplicate | Duplicate all selected rows after sources. | `batch_duplicate_nodes`. | `outliner-selection-keyboard.spec.ts` |
| Batch indent/outdent | Move selected structural rows and preserve focus/expanded target. Direct field values are eligible for indent, excluded from outdent at the field boundary, and still excluded from arbitrary move-to; ordinary descendants follow the normal policy. | `batch_indent_nodes`, `batch_outdent_nodes`, `selectionBatchActions`. | `selectionBatchActions.test.ts`, `outliner-selection-keyboard.spec.ts` |
| Batch copy/cut | Clipboard text uses selectable selected row order. A copied field entry includes an inline value summary only when its value children are not separately selected; cut removes selected roots through selectable-row delete policy. | `serializeSelectedRows`, `selectionBatchActions`. | `outliner-selection-keyboard.spec.ts` |

## Trigger Inputs

| Input | nodex behavior | Tenon rule | Test coverage |
| --- | --- | --- | --- |
| `>` in trailing input | Create inline field row. | `create_field`. | `rowInteractions.test.ts`, `outliner-triggers.spec.ts` |
| `#` in trailing/editor | Open tag trigger selector. | `create_trigger_node` / editor trigger. | `rowInteractions.test.ts`, `outliner-triggers.spec.ts` |
| `@` in trailing/editor | Split tree reference vs inline reference by context. | reference resolver. | `rowInteractions.test.ts`, `outliner-triggers.spec.ts` |
| `/` in empty row | Open slash command menu. | slash command resolver. | `rowInteractions.test.ts`, `outliner-triggers.spec.ts` |
| IME composition in trigger inputs | Do not treat composing text as a committed trigger/command. | `isImeComposingEvent` guards trailing/editor/menu key handlers. | `rowInteractions.test.ts` |

## Trailing Input And Expansion

Since PR #64 (node-line-editor-unification Phase 2b) the trailing line is no
longer a separate `TrailingInput` component — it is the unified `OutlinerItem`
draft row (`OutlinerFlatView` appends it from the visual-row projection). The behaviors below are
preserved; they are now handled inline in the draft branches of `OutlinerItem`'s
keymap, not the removed `resolveTrailingRow*` / `*EffectiveParent` /
`shouldShowTrailingInput` helpers.

| Event | nodex behavior | Tenon rule | Test coverage |
| --- | --- | --- | --- |
| Plain character in empty trailing draft | Eager-create a real node and focus it. | `OutlinerItem.applyTextPatch` (draft eager-materialize). | `outliner-trailing-expand.spec.ts` |
| Empty Enter in trailing draft | Create an empty node in the current scope. | `OutlinerItem.handleEnter` draft branch (`materializeDraftAndAdvance`). | `outliner-trailing-expand.spec.ts` |
| Mod+Enter in trailing draft | Create an empty unchecked checkbox row; an empty field-value draft does nothing. | `OutlinerItem.handleModEnter` materializes a body draft before cycling checkbox state and aborts the cycle when materialization fails. | `outliner-trailing-expand.spec.ts` |
| Tab in trailing draft | Shift effective parent to the last visible child and expand it. | `OutlinerItem.handleTab` draft branch. | `outliner-trailing-expand.spec.ts` |
| Shift+Tab in trailing draft | Return effective parent to the original scope. | `OutlinerItem.handleTab` draft branch (shiftKey). | `outliner-trailing-expand.spec.ts` |
| Backspace in empty trailing draft | Focus last visible row, or collapse empty expanded parent. | `OutlinerItem.handleBackspaceAtStart` draft branch. | `outliner-trailing-expand.spec.ts` |
| Chevron on leaf node | Expand leaf to show child trailing draft and focus it. | `toggleExpandOrSelect`. | `outliner-trailing-expand.spec.ts` |
| Parent with content child | Do not render another child trailing draft under that parent. | `buildVisualRows` trailing-draft projection. | `outliner-trailing-expand.spec.ts` |
| Empty trailing draft in a definition Default-content / Pre-determined-options block | Show an "add here" placeholder on the draft editor (`Add default content…` / `Add an option…`) so the section is not a label over a ghost bullet; the generic body draft stays unlabeled. | `definitionOutlinerPlaceholder` → `NodePanel` `draftPlaceholder` → `OutlinerItem` editor placeholder (root draft only). | `definition-config.spec.ts` |

## Implementation Rules

1. Do not implement row-specific shortcuts directly in components first.
2. Add or update a pure resolver test before changing UI behavior.
3. Keep keyboard, context menu, and popup actions sharing the same selected row and target resolution.
4. Reference rows must distinguish display row operations from target-node operations.
5. Selectable-row action policy is the source of truth for synthetic/read-only rows and field value batch behavior.
6. Any popup used during multi-selection must carry `data-preserve-selection`.
7. Any parity claim that depends on browser focus or pointer ordering should have E2E coverage, not only pure resolver coverage.
8. IME/composition handling must use `isImeComposingEvent`; do not check only `event.isComposing` in individual components.
