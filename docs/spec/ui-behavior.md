# UI And Interaction Spec

The outliner should follow nodex-style behavior while using the new Rust
core. This file is the parity checklist for future UI changes: any outliner
keyboard or pointer change should be checked against this matrix.

## Layout

- Single primary outliner panel.
- Top bar contains navigation context, command palette, new node, undo, and redo.
- Rows use a compact bullet/chevron leading control, restrained hover/focus
  states, and no right inspector.
- Page titles are editable rich text.
- The root scope always renders a trailing input so typing can continue at the
  end of the page.
- Field entries are ordinary outline rows with field-specific value rendering.

## Row State Model

- `focusedId` means the row is in edit mode.
- `selectedId` and `selectedIds` mean row selection mode.
- `expanded` controls visible children and trailing child inputs.
- `focusOffset` preserves cursor position across remounting structural moves.

## Content Row Matrix

| Interaction | Expected behavior |
| --- | --- |
| `Enter` at text end on collapsed/leaf row | Create next sibling and focus it. |
| `Enter` in the middle | Split the row, preserving rich text before/after the cursor. |
| `Enter` on expanded row with children | Create the first child and focus it. |
| `Tab` | Indent under previous sibling; pre-expand that sibling and restore cursor offset. |
| `Tab` on first child | No-op. |
| `Shift+Tab` | Outdent after parent and restore cursor offset. |
| `Backspace` at start with text | Merge into the previous visible content row when possible, then restore the cursor at the join offset. |
| `Backspace` on empty leaf row | Trash the row and focus the previous visible row. |
| `Backspace` on empty row with children | Block deletion so a subtree is not removed by accident. |
| `ArrowUp` at text start | Focus previous visible row at end. |
| `ArrowDown` at text end | Enter expanded child scope first, then next visible row/trailing row. |
| `Escape` | Leave edit mode and select the current row. |
| `Mod+Enter` | Toggle done state. |

## Trailing Input Matrix

| Interaction | Expected behavior |
| --- | --- |
| Printable text on empty trailing row | Create an eager child and keep editing that node. |
| `Enter` with text | Create content, then create/focus a new empty row in the same parent. |
| Empty `Enter` | Create/focus an empty child. |
| `Tab` | Move trailing input under the last child and expand that child. |
| `Shift+Tab` | Move trailing input one parent level up. |
| Empty `Backspace` after depth shift | Reset the trailing input to its original parent. |
| Empty `Backspace` when parent has no children | Collapse the parent and focus it. |
| Empty `Backspace` when parent has children | Focus the last visible child. |
| `ArrowUp` | Focus the last visible child above the trailing row. |
| `ArrowDown` at panel boundary | Navigate out only if the parent view supplies that callback. |
| `#`, `@`, `/`, `>` | Create the matching trigger/field row and open its menu. |

## Field Row Matrix

| Interaction | Expected behavior |
| --- | --- |
| `Enter` in field name | Commit name and focus value. |
| `Enter` in field value | Commit field and create a sibling row after the field entry. |
| `Tab` / `Shift+Tab` | Same structural indentation rules as content rows. |
| `ArrowUp` / `ArrowDown` | Move through visible outline rows. |
| `Escape` | Leave edit mode and select the field row. |

## Selection Mode Matrix

| Interaction | Expected behavior |
| --- | --- |
| Click row body | Select row. |
| Click editable text | Enter edit mode. |
| `Escape` in edit mode | Select current row. |
| `Enter` on selected row | Enter edit mode. |
| Printable key on selected row | Append that character and enter edit mode. |
| `Shift+ArrowUp/Down` | Extend visible row selection. |
| `Tab` / `Shift+Tab` | Batch indent/outdent selected root rows and preserve selection anchor. |
| `Backspace` / `Delete` | Trash selected root rows. |

## Leading Control Matrix

| Interaction | Expected behavior |
| --- | --- |
| Hover any row | Show chevron affordance. |
| Click chevron on row with children | Toggle expanded state. |
| Click chevron on leaf row | Expand an empty child scope and focus its trailing input. |
| Hover indent guide line | Thicken only the guide line, without expanding into child chevron hit targets. |
| Expanded scope guide line | Render for expanded rows, including leaf rows expanded to show trailing input. |
| Click indent guide line | Toggle expanded state for the row's direct children when present. |
| Click bullet | Open/drill into the node. |
| Drag bullet | Move the row, expanding inside-drop targets. |
| Applied tag display | Render tags inline after node text using nodex-style badges; do not render a second-line chip strip. |
| Applied tag bullet color | Color the node bullet from applied tag colors, using pie segments for multiple tags. |

## Trigger Matrix

- `#` opens tag selection.
- `@` splits between tree reference and inline reference based on trigger
  position and cycle constraints.
- `/` opens slash commands only when the node is otherwise empty.
- `>` creates a field row only when the content is exactly the bare trigger.
- Trigger menus must route `ArrowUp`, `ArrowDown`, `Enter`, and `Escape` before
  normal outliner navigation.
