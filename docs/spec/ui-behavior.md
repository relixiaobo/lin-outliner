# UI And Interaction Spec

The outliner should follow nodex-style behavior while using the TypeScript
core. This file is the parity checklist for future UI changes: any outliner
keyboard or pointer change should be checked against this matrix.

## Layout

- Single primary outliner panel.
- Panel breadcrumb stays pinned to the top of the panel scroll container.
- Breadcrumb uses the panel left inset. The main outline content can remain
  centered independently on wide panels.
- When the page title scrolls under the pinned breadcrumb, the current page
  title appears as the final breadcrumb segment.
- Breadcrumb back navigates the current panel to its previous node page. It does
  not undo document operations.
- Page-history back/forward navigate the active panel's outliner page history via
  `Cmd+[` / `Cmd+]` (there are no top-bar back/forward buttons; see
  [`design-system.md`](./design-system.md) → Shell). They do not undo or redo
  document operations.
- Rows use a compact bullet/chevron leading control, restrained hover/focus
  states, and no right inspector.
- Page titles are editable rich text.
- The root scope always renders a trailing input so typing can continue at the
  end of the page.
- Field entries are ordinary outline rows with field-specific value rendering.
  Their separators stay hidden until the row is hovered or focus is inside its
  field name/value area.

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
| `Mod+Enter` | Cycle checkbox state: no checkbox, undone checkbox, done checkbox. |

## Trailing Input Matrix

| Interaction | Expected behavior |
| --- | --- |
| Printable text on empty trailing row | Create an eager child and keep editing that node. |
| `Enter` with text | Create content, then create/focus a new empty row in the same parent. |
| Empty `Enter` | Create/focus an empty child. |
| `Tab` | Relocate the trailing input under the last child and expand that child. The draft stays a draft — the cursor stays put and no node is created until text is typed. |
| `Shift+Tab` | Relocate the trailing input one parent level up (no node created until text is typed). |
| Empty `Backspace` after a `Tab` relocate | The draft now sits under the (empty) sibling it was relocated into, so the "parent has no children" rule below applies: collapse that sibling and focus it. |
| Empty `Backspace` when parent has no children | Collapse the parent and focus it. |
| Empty `Backspace` when parent has children | Focus the last visible child. |
| `ArrowUp` | Focus the last visible child above the trailing row. |
| `ArrowDown` at panel boundary | Navigate out only if the parent view supplies that callback. |
| `#`, `@`, `/`, `>` | Create the matching trigger/field row and open its menu. |

## Field Row Matrix

| Interaction | Expected behavior |
| --- | --- |
| Type in field name | Show a reuse popover of matching existing fields ("Fields") and built-in system fields ("System fields"). Nothing is highlighted by default. Fields already present on the same owner node are excluded — a node may not carry the same field twice. |
| `Space` on an empty field name | Summon the full reuse picker (every reusable field + system field, alphabetical) without typing a leading space. Once the name has text, `Space` types normally. |
| `ArrowDown` + `Enter` (or click) in the reuse popover | Reuse that definition: relink the entry to it (`reuse_field_definition`) and drop the throwaway draft def. |
| `Enter` in field name | With no popover candidate highlighted, commit the typed name as a new field and create/focus a sibling row after the field entry. |
| `Enter` in field value | Commit field and create a sibling row after the field entry. |
| `>` in field value content/trailing input | Create a nested field entry inside the field value scope. |
| `Tab` / `Shift+Tab` | Same structural indentation rules as content rows. |
| `ArrowUp` / `ArrowDown` | Move through visible outline rows. |
| `Escape` | Close the reuse popover if open, else leave edit mode and select the field row. |

A reused **system field** (Created, Last edited, Done, Done time, Tags,
References, Owner, Day) has no backing definition node: its name is a fixed
read-only label, and its value is derived from the owning node rather than
stored. Relinking an entry onto a system field drops any value children the draft
carried (the value is computed, never stored). Each renders by its real type, not
as bare text:

- **Done** — a read-write checkbox; toggling it flips the owner's done state
  (`toggle_done`). The only mutable system field. When the owner is **locked** (e.g.
  a daily-note `date:` page, which `toggle_done` rejects), it renders read-only —
  reflecting the state without an interactive toggle, so a Done field created at a
  day page's root never crashes on click.
- **Created / Last edited / Done time** — the formatted date plus a read-only
  calendar glyph (matching the editable `date` value styling).
- **Tags** — the owner's applied tags as read-only colored badges (the same
  nodex-style badges shown inline after node text), each navigable to its tag.
- **References** — the backlink source nodes (nodes that reference the owner) as
  read-only navigable links, not a bare count.
- **Owner** — the owner's parent node, as a navigable link.
- **Day** — the date of the nearest `day`-tagged ancestor (the daily-note page
  the node lives under), with a calendar glyph, navigable to that day.

The renderer derives all of these through one structured `systemFieldDisplay`
helper (the row component switches on its `kind`). Owner and Day are on-node
fields only; they are not (yet) selectable in view sort/filter/group, so the
protocol-surface `ViewSystemField` union is unchanged.

A **field entry row is never expandable**: its children *are* its value(s),
rendered in the value column, so there is no leaf-expand chevron and no separate
child scope to open. (Individual value rows inside the value column are likewise
not expandable.)

A typed field value that fails its type's format check shows a trailing warning
icon; the message is revealed on hover, never as always-on inline text.

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

## Reference And Inline Reference Matrix

Tana is the behavior reference for the data model: a reference is a mirror of
the original node, and the same node ID cannot appear twice as a child in the
same list. Lin enforces the same block-instance invariant in core. Inline
references are text atoms, not child block instances, so they do not participate
in that sibling uniqueness rule.

| Interaction | Expected behavior | Test coverage |
| --- | --- | --- |
| Add a reference to a target in a different parent | Create a reference row that renders the target's text and children. Expanding the reference row shows target children. | `core.test.ts`, `outliner-selection-keyboard.spec.ts` |
| Add or move a reference where the same target already appears as a sibling | Reject the tree reference. UI selection falls back to inline reference where appropriate. | `core.test.ts`, `rowInteractions.test.ts`, `outliner-triggers.spec.ts` |
| Empty row `@Target` when tree reference is valid | Replace the draft row atomically with an inline-reference conversion row. The row pulses, focuses after the inline atom, and restores to a tree reference only if it remains unchanged on blur. | `core.test.ts`, `outliner-triggers.spec.ts`, `outliner-selection-keyboard.spec.ts` |
| Empty row `@Target` when the target is already in the same parent | Insert an inline reference in the same row. Continue typing appends text after the inline atom. The original target is not renamed or moved. | `core.test.ts`, `rowInteractions.test.ts`, `outliner-triggers.spec.ts` |
| Continue typing after a pending reference conversion | If any normal text is added, keep the inline-reference row and do not restore it to a tree reference on blur. | `outliner-triggers.spec.ts`, `outliner-selection-keyboard.spec.ts` |
| Continue typing Chinese or other IME text after an inline reference | Text commits after the inline atom and the caret remains after the committed text. Internal zero-width anchors may exist in the editor DOM but must not persist into `RichText` or generate patches. | `editorTextPatch.test.ts`, `outliner-triggers.spec.ts` |
| Inline reference inside normal text | Render as text-like link, not a chip. It stays in text flow and preserves cursor offset through split, merge, patch, and IME paths. | `editorTextPatch.test.ts`, `outliner-bullet-parity.spec.ts` |
| Click an inline reference in a normal row | Drill/open the referenced node without focusing the editor title. | `outliner-bullet-parity.spec.ts` |
| Click an inline reference displayed inside a reference row | Open the inline reference target. The reference row itself still uses single-click selection outside inline references. | `outliner-selection-keyboard.spec.ts` |
| Click a reference row | Select the reference link row; do not enter text edit mode. | `outliner-selection-keyboard.spec.ts` |
| Double-click a reference row or press ArrowRight on a selected reference row | Convert the reference row to an inline-reference conversion row. If unchanged and valid on blur, restore to a reference row. If text is added, keep it as inline text. | `outliner-selection-keyboard.spec.ts` |
| Backspace/Delete a selected reference row | Delete/trash the reference link itself. The target node remains. Mixed normal-node/reference selections use normal batch block deletion. | `outliner-selection-keyboard.spec.ts` |
| Selected option-reference field value | ArrowUp/Down moves through field options, Enter selects, and Escape closes the options list before clearing the selected reference row. | `outliner-triggers.spec.ts` |
| Toggle checkbox/done on a reference row | Apply the done state to the target node, because the reference displays the target. | `outliner-parity.test.ts`, `outliner-selection-keyboard.spec.ts` |
| Permanently delete a target node | Remove tree references and inline references to that target. Undo restores both. | `core.test.ts` |
| Trash a target node | Keep references restorable; the reference still points at the trashed target until restore or permanent delete. | `core.test.ts` |
| Reference to a reference | Normalize to the effective target. Nested reference nodes should not point to reference nodes. | `core.test.ts` |
| Agent/tool `replace_with_reference_to` | Replace or retarget a block reference through core commands, subject to the same duplicate and cycle constraints. | `agentNodeTools.test.ts` |
