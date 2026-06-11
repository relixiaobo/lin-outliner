# Outliner parity matrix

This matrix tracks the nodex outliner behavior that lin-outliner must preserve.
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

## State Model

| State | Meaning | Current owner |
| --- | --- | --- |
| Editing | A row editor/input owns focus and text shortcuts edit content. | `ui.focusedId` plus DOM focus |
| Single selection | One row is selected, no editor focus. | `ui.selectedIds`, `ui.selectionAnchorId` |
| Multi selection | More than one visible row is selected, no editor focus. | `ui.selectedIds`, `ui.selectionAnchorId` |
| Trigger menu | `#`, `@`, or `/` menu is open for a focused editor/trailing input. | `trigger` |
| Batch tag menu | Multi-selection `#` picker is open and must preserve selection. | `ui.batchTagSelectorOpen` |
| Context menu | Right-click menu operates on selection if opened from a selected row. | `NodeContextMenu` |
| IME composition | Text input is composing and must not fire structural shortcuts or trigger actions. | `isImeComposingEvent` plus editor composition refs |

Selection mode uses the panel-level `buildSelectableRows` order. Visual and
editing navigation keep using the body/reference visible order from
`flattenVisibleRows` / `buildVisualRows`; field value rows render inside their
field row but still appear in the selectable-row order.

## Pointer And Focus

| Event | nodex behavior | lin-outliner rule | Test coverage |
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

| Key | nodex behavior | lin-outliner effect | Test coverage |
| --- | --- | --- | --- |
| Escape | Clear selection and re-enter edit. | `clear_selection`. | `outlinerParity.test.ts` |
| Enter | Edit first selected row. | `enter_edit`. | `outlinerParity.test.ts` |
| Printable char | Edit first selected row and insert/append char. | `type_char`. | `outlinerParity.test.ts` |
| ArrowUp / ArrowDown | Move editing focus before/after selected block. | `navigate_up/down`. | `outlinerParity.test.ts` |
| Shift+ArrowUp / Shift+ArrowDown | Extend selection from anchor. | `extend_up/down`. | `outlinerParity.test.ts` |
| Cmd/Ctrl+A | Select all selectable rows in the current selection root, even when no row is currently selected. Field value rows inherit the panel selection root rather than their nested render root. | `select_all`. | `outlinerParity.test.ts`, `outliner-selection-keyboard.spec.ts` |
| Backspace / Delete | Delete selected root rows by selectable-row policy. Ordinary rows trash; stored field value rows use field-value removal; synthetic rows are disabled. | `batch_delete`. | `outlinerParity.test.ts` |
| Tab / Shift+Tab | Batch indent/outdent selected root rows that are allowed to move structurally. Field value rows are excluded because they may not leave their owning field entry. | `batch_indent/outdent`. | `outlinerParity.test.ts` |
| Cmd/Ctrl+Shift+D | Batch duplicate selected root rows. | `batch_duplicate`. | `outlinerParity.test.ts` |
| Cmd/Ctrl+Enter | Cycle selected target nodes through no checkbox, undone checkbox, and done checkbox. | `batch_checkbox`. | `outlinerParity.test.ts`, `outliner-selection-keyboard.spec.ts` |
| # | Open batch tag selector. | `batch_apply_tag`. | `outlinerParity.test.ts`, `outliner-selection.spec.ts` |
| Cmd/Ctrl+C / Cmd/Ctrl+X | Copy/cut selected rows in selectable order. | `batch_copy/cut`. | `outlinerParity.test.ts` |
| Selection printable char | Focus first selected row and insert/append char. | `type_char` followed by row focus. | `outliner-selection-keyboard.spec.ts` |
| Selection ArrowUp/Down | Focus adjacent row outside selected block. | `navigationTarget`. | `outliner-selection-keyboard.spec.ts` |
| IME composition | Do not run selection shortcuts while browser reports composition, `Process`, or legacy key code `229`. | `isImeComposingEvent`. | `rowInteractions.test.ts` |

## Global Keyboard

| Key | nodex behavior | lin-outliner effect | Test coverage |
| --- | --- | --- | --- |
| Cmd/Ctrl+Shift+D with no row selection | Go to today's daily note. | `global.go_to_today` ensures today's date node and navigates the active panel. With a selection, `selection.duplicate` keeps owning the same chord. | `rowInteractions.test.ts`, `outliner-navigation-title.spec.ts`, `outliner-selection-keyboard.spec.ts` |
| Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z / Cmd/Ctrl+Y | nodex overloads no-editor Cmd/Ctrl+Z for page history. | Lin keeps these as document undo/redo globally and in editors. | `rowInteractions.test.ts`, `outliner-navigation-title.spec.ts` |
| Cmd/Ctrl+[ / Cmd/Ctrl+] | Not the nodex binding. | Navigate the active panel back/forward through page history. | `rowInteractions.test.ts` |
| Alt+ArrowLeft / Alt+ArrowRight | Not the nodex binding. | Navigate the active panel back/forward through page history only outside editable text; inside editors it remains platform word-navigation. | `rowInteractions.test.ts`, `outliner-navigation-title.spec.ts` |

## Row Editing

| Event | nodex behavior | lin-outliner rule | Test coverage |
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

| Operation | nodex behavior | lin-outliner rule | Test coverage |
| --- | --- | --- | --- |
| Duplicate | Operate on top-level selected rows only. Plain field values may clone; reference/option-style values are filtered out instead of creating duplicate targets. | `selectedRootIds`, `selectionBatchActions`. | `outlinerParity.test.ts` |
| Trash | Operate on top-level selected rows only. Field value rows route to `remove_field_value`, not generic trash, so option-pool cleanup still runs. A single ref-clicked ordinary reference may hard-delete the reference row even if locked; a ref-clicked reference field value still uses `remove_field_value`. | `selectedRootIds`, `selectionBatchActions`. | `outlinerParity.test.ts`, `outliner-selection.spec.ts` |
| Move up/down and drag | Reorder selected rows inside their current sibling list or drag selected structural roots to one drop target. Field value rows may reorder only inside their owning field entry. | Core batch move commands via selectable-row policy; selected block drag uses `batch_move_nodes` as one undoable operation. | core tests, `outliner-drag-drop.spec.ts` |
| Done | For references, toggle the target node, not the display reference row. | `targetIdsForRows`. | `outlinerParity.test.ts`, `outliner-selection-keyboard.spec.ts` |
| Add tag | Batch apply to selected target nodes; create tag then apply if needed. | `batch_apply_tag`. | core + renderer + E2E tests |
| Nested selected rows | Parent selection suppresses child duplicate/trash/move. | `selectedRootIds`. | `outlinerParity.test.ts` |
| Duplicate references to same target | Target operations are deduped. | `targetIdsForRows`. | `outlinerParity.test.ts` |
| Batch duplicate | Duplicate all selected rows after sources. | `batch_duplicate_nodes`. | `outliner-selection-keyboard.spec.ts` |
| Batch indent/outdent | Move selected structural rows and preserve focus/expanded target. Field value rows are filtered out. | `batch_indent_nodes`, `batch_outdent_nodes`, `selectionBatchActions`. | `outliner-selection-keyboard.spec.ts` |
| Batch copy/cut | Clipboard text uses selectable selected row order. A copied field entry includes an inline value summary only when its value children are not separately selected; cut removes selected roots through selectable-row delete policy. | `serializeSelectedRows`, `selectionBatchActions`. | `outliner-selection-keyboard.spec.ts` |

## Trigger Inputs

| Input | nodex behavior | lin-outliner rule | Test coverage |
| --- | --- | --- | --- |
| `>` in trailing input | Create inline field row. | `create_field`. | `rowInteractions.test.ts`, `outliner-triggers.spec.ts` |
| `#` in trailing/editor | Open tag trigger selector. | `create_trigger_node` / editor trigger. | `rowInteractions.test.ts`, `outliner-triggers.spec.ts` |
| `@` in trailing/editor | Split tree reference vs inline reference by context. | reference resolver. | `rowInteractions.test.ts`, `outliner-triggers.spec.ts` |
| `/` in empty row | Open slash command menu. | slash command resolver. | `rowInteractions.test.ts`, `outliner-triggers.spec.ts` |
| IME composition in trigger inputs | Do not treat composing text as a committed trigger/command. | `isImeComposingEvent` guards trailing/editor/menu key handlers. | `rowInteractions.test.ts` |

## Trailing Input And Expansion

Since PR #64 (node-line-editor-unification Phase 2b) the trailing line is no
longer a separate `TrailingInput` component — it is the unified `OutlinerItem`
draft row (`OutlinerView` appends it via `showDraft`). The behaviors below are
preserved; they are now handled inline in the draft branches of `OutlinerItem`'s
keymap, not the removed `resolveTrailingRow*` / `*EffectiveParent` /
`shouldShowTrailingInput` helpers.

| Event | nodex behavior | lin-outliner rule | Test coverage |
| --- | --- | --- | --- |
| Plain character in empty trailing draft | Eager-create a real node and focus it. | `OutlinerItem.applyTextPatch` (draft eager-materialize). | `outliner-trailing-expand.spec.ts` |
| Empty Enter in trailing draft | Create an empty node in the current scope. | `OutlinerItem.handleEnter` draft branch (`materializeDraftAndAdvance`). | `outliner-trailing-expand.spec.ts` |
| Tab in trailing draft | Shift effective parent to the last visible child and expand it. | `OutlinerItem.handleTab` draft branch. | `outliner-trailing-expand.spec.ts` |
| Shift+Tab in trailing draft | Return effective parent to the original scope. | `OutlinerItem.handleTab` draft branch (shiftKey). | `outliner-trailing-expand.spec.ts` |
| Backspace in empty trailing draft | Focus last visible row, or collapse empty expanded parent. | `OutlinerItem.handleBackspaceAtStart` draft branch. | `outliner-trailing-expand.spec.ts` |
| Chevron on leaf node | Expand leaf to show child trailing draft and focus it. | `toggleExpandOrSelect`. | `outliner-trailing-expand.spec.ts` |
| Parent with content child | Do not render another child trailing draft under that parent. | `OutlinerView.showDraft`. | `outliner-trailing-expand.spec.ts` |
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
