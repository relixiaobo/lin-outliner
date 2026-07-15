# UI And Interaction Spec

The outliner should follow nodex-style behavior while using the TypeScript
core. This file is the parity checklist for future UI changes: any outliner
keyboard or pointer change should be checked against this matrix.

## Layout

- Single primary outliner panel.
- Panel breadcrumb stays pinned to the top of the panel scroll container.
- Breadcrumb uses the panel left inset. The main outline content can remain
  centered independently on wide panels.
- Breadcrumb never renders as an empty path for a real node page: the internal
  workspace container is hidden, but the user-visible workspace root remains a
  breadcrumb ancestor when it is the only available context.
- If a pane root points at a node that no longer exists in the current projection,
  the workspace layout repairs that pane to a real fallback root instead of
  rendering an orphan untitled page shell.
- When the page title scrolls under the pinned breadcrumb, the current page
  title appears as the final breadcrumb segment.
- Breadcrumb back navigates the current panel to its previous node page. It does
  not undo document operations.
- Page-history back/forward navigate the active panel's outliner page history via
  `Cmd+[` / `Cmd+]` even while text is focused, or via `Alt/Option+ArrowLeft` /
  `Alt/Option+ArrowRight` outside editable text controls (there are no top-bar
  back/forward buttons; see
  [`design-system/surfaces.md`](./design-system/surfaces.md#shell)).
  They do not undo or redo document operations. In editable text, Option+Arrow
  remains the platform word-navigation shortcut. Returning to a previously
  scrolled panel view restores its scroll position instead of jumping to the top.
- Entering a node page places edit focus at the start of the first visible body
  row. If the page has no body rows, focus lands on that page's trailing draft so
  the user can immediately type the first row. Navigation never auto-focuses the
  end-of-page trailing draft on non-empty pages. Search pages (for example
  Recents) are result views, so entering them does not place edit focus on a
  result row.
- Rows use a compact bullet/chevron leading control, restrained hover/focus
  states, and no right inspector.
- The main outliner renders through the flat row producer by default. Small
  outlines render the full flat list in normal flow; large outlines window the
  visible rows with overscan, while focused and draft rows stay force-mounted so
  keyboard navigation and trailing inputs still work. The old recursive renderer
  remains a reload-scoped diagnostic fallback via
  `localStorage('lin:recursive-outliner') === '1'`.
- Expanding or collapsing a row keeps the clicked disclosure control visually
  anchored in the panel viewport, even while virtualized row measurements settle.
  Immediate user scroll input releases that temporary anchor; delayed measurement
  correction must not pull the viewport back after the user has moved it.
- Page titles are editable rich text. This includes the workspace root title
  (so people can name their workspace), which stays structurally fixed — it can
  be renamed but not moved, deleted, or reparented. The functional system
  sections (Daily notes, Library, Schema, Saved searches, Trash) and
  other locked pages (e.g. day pages) keep read-only titles.
- Trash is a recoverable holding area, not a normal editable bucket. The Trash
  root's context menu offers **Empty Trash** when it has children; the action
  confirms first and then permanently deletes each direct trashed subtree.
  Context menus for nodes inside Trash offer both **Restore** and **Delete
  forever**. Permanent delete confirms first and removes the selected trashed
  root rows (and their children); it is distinct from normal Delete/Backspace,
  which still moves live rows to Trash.
- The root scope always renders a trailing input so typing can continue at the
  end of the page.
- Field entries are ordinary outline rows with field-specific value rendering.
  Their separators stay hidden until the row is hovered or focus is inside its
  field name/value area.

## Row State Model

- `focusedId` means the row is in edit mode.
- `selectedId` and `selectedIds` mean row selection mode.
- `selectionRootId` is the panel-level selection scope. Field values still render
  inside a nested value-column `OutlinerView`, but their selection root is the
  outer panel root so a single range can span body rows, field entries, and field
  value rows.
- `expanded` controls visible children and trailing child inputs.
- Outliner expansion is renderer-local **view state**, not document state. Each
  root node page persists its own expanded node ids and revealed hidden-field
  keys in local storage. Because the current renderer keeps one global
  `expanded` set shared by every split pane, restoring a root page only merges
  its saved expansion into the global set; it never clears rows that another pane
  may be showing. This state is not part of core commands, undo/redo,
  import/export, or agent-editable document content.
- `focusOffset` preserves cursor position across remounting structural moves.

## Content Row Matrix

| Interaction | Expected behavior |
| --- | --- |
| `Enter` at text start on a non-empty row | Create a previous sibling and focus it; the current row and descendants stay in place. |
| `Enter` at text end on collapsed/leaf row | Create next sibling and focus it. |
| `Enter` in the middle | Split the row, preserving rich text before/after the cursor. |
| `Enter` at text end on expanded row with children | Create the first child and focus it. |
| `Tab` | Indent under previous sibling; pre-expand that sibling and restore cursor offset. |
| `Tab` on first child | No-op. |
| `Shift+Tab` | Outdent after parent, collapse the previous parent if it becomes empty, and restore cursor offset. Rows whose parent is the current panel root are a no-op. |
| `Backspace` at start with text | Merge into the previous visible content row when possible, then restore the cursor at the join offset. |
| `Backspace` on empty leaf row | Trash the row, then keep focus: previous visible row at end; if there is no previous row, next visible row at start or the panel trailing draft when the row was the only body row. |
| `Backspace` on empty row with children | Block deletion so a subtree is not removed by accident. |
| `ArrowUp` at text start | Focus previous visible row at end. |
| `ArrowDown` at text end | Enter expanded child scope first, then next visible row/trailing row. |
| `Escape` | Leave edit mode and select the current row. |
| `Mod+A` | First press uses native text selection inside the focused editor. If the row text is already fully selected, the next press leaves edit mode and selects every visible row in the panel selection scope. |
| `Mod+Enter` | Cycle checkbox state: no checkbox, undone checkbox, done checkbox. |

## Trailing Input Matrix

| Interaction | Expected behavior |
| --- | --- |
| Printable text on empty trailing row | Create an eager child at the draft's current visual position and keep editing that node. If the draft was relocated after a sibling, the fresh trailing draft stays after the newly materialized node. |
| `Enter` with text | Create content at the draft's current visual position, then create/focus a new empty row immediately after it in the same parent. |
| Empty `Enter` | Create/focus an empty child at the draft's current visual position and keep the next trailing draft immediately after it. |
| `Tab` | Relocate the trailing input under the sibling immediately before the draft's current visual position and expand that sibling. At the scope end, this is the last child; after `Shift+Tab`, this is the parent the draft follows. The draft stays a draft — the cursor stays put and no node is created until text is typed. If there is no preceding sibling, `Tab` is a no-op. |
| `Shift+Tab` | Relocate the trailing input one parent level up, immediately after the current parent in that scope (no node created until text is typed). At the current panel root, `Shift+Tab` is a no-op. |
| Empty `Backspace` after a `Tab` relocate | The draft now sits under the (empty) sibling it was relocated into, so the "parent has no children" rule below applies: collapse that sibling and focus it. |
| Empty `Backspace` when parent has no children | Collapse the parent and focus it. |
| Empty `Backspace` when parent has children | Focus the last visible child. |
| `ArrowUp` | Focus the last visible child above the trailing row. |
| `ArrowDown` at panel boundary | Navigate out only if the parent view supplies that callback. |
| `#`, `@`, `/`, `>` | Create the matching trigger/field row and open its menu. |

The live `#` tag trigger stays active only while the query after `#` contains
bare tag characters (Unicode letters/numbers, `_`, and `-`). Punctuation such as
`.` ends the tag query instead of keeping the dropdown open for text that cannot
be written as a bare tag.
Tag suggestions include only active tag definitions: a `tagDef` in Trash remains
visible on rows that already carry it as a deleted badge, but it is not offered
for new tagging. Typing the same label creates a new active tag definition
instead of reusing the trashed one.

## Field Row Matrix

| Interaction | Expected behavior |
| --- | --- |
| Type in field name | Show a reuse popover of matching active existing fields ("Fields") and built-in system fields ("System fields"). Field definitions in Trash are excluded. Nothing is highlighted by default. Fields already present on the same owner node are excluded — a node may not carry the same field twice. |
| `Space` on an empty field name | Summon the full reuse picker (every reusable field + system field, alphabetical) without typing a leading space. Once the name has text, `Space` types normally. |
| `ArrowDown` + `Enter` (or click) in the reuse popover | Reuse that definition: relink the entry to it (`reuse_field_definition`) and drop the throwaway draft def. |
| `Enter` in field name | With no popover candidate highlighted, commit the typed name as a new field and create/focus a sibling row after the field entry. |
| `Enter` in field value | Commit field and create a sibling row after the field entry. |
| `Backspace` at start of field name | Delete the field row through the same selection-delete path used for selected rows. Focus the previous visible row at end; if there is no previous row, focus the next visible row at start or the panel trailing draft when the field row was the only body row. |
| `Mod+A` in field name/value | First press selects the text in that control/editor. A second consecutive `Mod+A` while the editor text is fully selected leaves edit mode and selects every visible row in the panel selection scope. Empty controls have no text-selection step, so `Mod+A` can select visible rows immediately. |
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
  (`toggle_done`). The only mutable system field. Attaching a Done field also makes
  the **owner's own row** show a checkbox (even before the first toggle): both the
  row checkbox and the field value read the owner's `completedAt`, so they stay in
  sync with no extra wiring (`nodeShowsCheckbox` treats a `sys:done` field entry as
  a third checkbox trigger, alongside the `completedAt` sentinel and tag-driven
  `showCheckbox`). When the owner is **locked** (e.g. a daily-note `date:` page,
  which `toggle_done` rejects), both the field value and the row checkbox render
  read-only — reflecting the state without an interactive toggle, so a Done field
  carried by a locked day page never crashes on click.
- **Created / Last edited / Done time** — the formatted date plus a read-only
  calendar glyph (matching the editable `date` value styling).
- **Tags** — the owner's applied tags as read-only colored badges (the same
  nodex-style badges shown inline after node text), each navigable to its tag.
- **References** — linked backlink source nodes (tree references, inline node
  references, and reference-valued field children that point at the owner) as read-only
  **reference rows**, not a bare count. The raw `sys:refCount` sort/filter value
  counts every linked reference edge; the rendered value dedupes by source node.
- **Owner** — the owner's parent node, as a read-only reference row.
- **Day** — the date of the nearest `day`-tagged ancestor (the daily-note page
  the node lives under), as a read-only reference row to that day node.

The renderer derives all of these through one structured `systemFieldDisplay`
helper (the row component switches on its `kind`). The three **node-reference**
kinds (References / Owner / Day) render as real reference rows — the same
presentation used for every other node reference — via `SystemReferenceValues`,
which synthesizes read-only `reference` node projections (a `sysref:` id, `locked`)
into an augmented index for the field-value subtree. So each value double-clicks
to edit its target (the change flows to the original node) and expands to view it,
exactly like an editable reference. The value **set**, however, is read-only: it
is computed from the document, so there is no trailing draft (no add) and the
synthetic ids carry no stored node (no delete — Backspace on a reference row only
steps up). `SystemFieldValue` keeps only the scalar kinds (date / tags / text /
done). Owner and Day are on-node fields only; they are not (yet) selectable in
view sort/filter/group, so the protocol-surface `ViewSystemField` union is
unchanged.

A **field entry row is never expandable**: its children *are* its value(s),
rendered in the value column, so there is no leaf-expand chevron and no separate
child scope to open. (Individual value rows inside the value column are likewise
not expandable.)

A typed field value that fails its type's format check shows a trailing warning
icon; the message is revealed on hover, never as always-on inline text.

A **plain field** uses the normal outliner value editor and may contain ordinary
text nodes, inline node references, or whole-row reference nodes. Typing `@` in
the value draft opens the standard document reference suggestions. Picking a
reference as the whole value creates the normal reference-conversion row and,
when left unchanged, restores it as a structural `reference` child of the field
entry. Picking inside surrounding text creates an inline reference in a plain
value node. References are value shapes rather than a field type, and there is
no field-only reference picker.

For `options_from_supertag` fields, the source supertag must be an active tag
definition. If the source tag is moved to Trash, the field's value picker no
longer derives candidates from nodes carrying that deleted tag.

## View Toolbar

The node-level view toolbar is the presentation control for a node's child rows
and for saved-search result views. It lives above the rendered child/result rows
when the node's `viewDef.toolbarVisible` flag is true. The current supported mode
is list, with Filter by name, Display, Group by, Sort by, and Filter by
controls. These controls all read and write `viewDef` child nodes
(`displayField`, `sortRule`, `filterRule`, plus the view's `groupField`) rather
than storing renderer-local state.

Nested toolbars render as part of the expanded child outline, not as detached
cards. They remain logically inside the expanded child subtree, while their
visual indent aligns with the owning node's title/content column instead of the
first child row. The expanded parent guide line spans the toolbar and
descendants. The toolbar itself carries only subtle top/bottom separators; the
hierarchy line is the main visual divider.

The leading search icon is a Tana-style **Filter by name** shortcut. Clicking it
turns the icon into an inline editable chip. Non-empty text is written as a real
`sys:name contains <text>` `filterRule`; clearing the chip removes that rule.
The name rule is owned by this shortcut and is not repeated in the generic
Filter summary chips or on the generic Filter icon.

The toolbar shows compact neutral summary chips for active Display fields, Group
by, and each non-name Filter rule. These chips sit inline in the same toolbar row
as the icon controls rather than forming a separate summary row. Each chip is
also a shortcut into the matching toolbar popover; Filter chips open the editor
for that specific saved `filterRule`, not merely the first rule for that field.
That matters because advanced states may contain multiple filters against the
same field. A Filter summary chip reads as the field name with a trailing remove
control; the operator/value detail lives in the editor pane, matching Tana's
active-filter chip model. Filter state is not duplicated on the generic Filter
icon.

Sort follows Tana's separate state model: an active sort rule is represented on
the Sort button itself, with the icon direction matching the first rule. While
the Sort popover is open, the toolbar can also show a `Sorted by ...` summary
chip beside the active button as editable context. Closing the popover leaves the
compact icon state, not a persistent text chip.

Toolbar popovers follow Tana's field-first shape. Display is a direct checklist
of fields. Group is a single-select field list because it has no per-field
settings yet. Sort starts from the shared field list and drills into the chosen
field for direction settings; reopening Sort always returns to the field list
first, even when a rule already exists. Existing sort rows show their priority
number beside the direction because sorting precedence follows the persisted
`sortRule` order. Newly selected sort fields wait for the command result before
showing direction controls, so a fast second click cannot create duplicate rules.
Supported system fields appear first in a
stable Tana-like order and use view-specific labels: Created time, Date from
calendar node, Done, Done time, Last edited time, Number of references, Owner
node, and Tags. A system field is offered only when it exists on at least one
current child/result row, or when an existing Display, Group, Sort, or Filter
setting already references it so the old setting remains editable. For example,
Tags requires at least one row with an applied tag, Done requires at least one
row with a checkbox, Done time requires at least one completed row, and Number of
references requires at least one row with a linked reference count. Date from
calendar node uses date-field treatment for icons, sort/filter wording, sort
comparisons, filter comparisons, and grouping buckets. Custom fields in the
shared field list come from fields actually present on the current child/result
rows, plus fields already referenced by existing Display, Group, Sort, or Filter
settings. Fields that the data model does not yet expose as computed values,
such as path, workspace, or editor identity, are not shown as fake empty choices.

Filter uses a narrower field list than Display, Group, or Sort. The leading
Filter by name chip owns name filtering, so Name is excluded from the generic
Filter popover. Generic Filter still offers the real system fields supported by
the view adapter, then contextual custom fields from the current child/result
rows plus fields already referenced by existing non-name filter rules so old
rules remain editable. Fields that the data model does not yet expose as computed
values are not shown as fake empty choices.

Rows that do not match the active view filter are not discarded from the
interaction surface. The visible list shows matching rows first, then appends a
collapsed `N items filtered out` disclosure. Expanding it reveals the filtered
rows in the same outline renderer and keyboard-selection model; collapsing it
hides them again without changing the persisted view settings. The disclosure's
renderer id includes the active filter-rule ids, so expanding an old filter does
not silently expand a newly created filter on the same parent later.

When a field-first popover drills into an editor pane, focus moves to the pane's
back control. That keeps Escape scoped to the popover and preserves keyboard
dismissal after the clicked field row unmounts.

When a row context-menu action reveals a nested View Toolbar from a collapsed
row, the row expands in the same interaction so the toolbar becomes visible
immediately. The menu label follows visibility in the current row: a configured
toolbar hidden behind a collapsed row still reads as **Show view toolbar**.

Display fields render on each visible content/result row as quiet metadata under
the row title and inline tags. The node name is excluded because the title already
shows it. Empty fields are omitted per row, so adding a Display field does not
create blank placeholders on rows that do not carry that value. The displayed
values use the same field resolution as sort, filter, and group, but system
fields render through the display adapter rather than the raw sort/filter
adapter: dates render as `YYYY-MM-DD`, Done renders as text, and reference-like
fields render their labels instead of raw ids/count internals. Values render as
plain text joined by comma for now; typed chips and navigable references are a
future display-layer enhancement, not a different view model.

## Search Nodes

Search nodes render a compact query summary below the page title and above the
materialized result rows while the inline query builder is closed. The summary
shows read-only chips for the query semantics and the current materialized result
count; it does not configure how the results are presented.

The summary exposes a **View** action that reveals the same node-level View
Toolbar used by normal node pages. Query chips describe *what the search returns*;
the View Toolbar controls *how the result references are displayed, grouped,
sorted, and filtered*.

## NodePanel References Footer

Each `NodePanel` has a Tana-style bottom **References** section when its root node
has linked references or exact unlinked textual mentions. The section is hidden
when both counts are zero and collapsed by default when present. It is derived
from the shared reference summary, not from the optional `sys:refCount` system
field, so the footer is always available even when the References field is not
displayed on the node.

The footer is outliner-native, not a card list: its collapsed affordance is a
small `N references` row aligned with the page content column, and expansion
reveals counted group labels plus source rows rendered through the shared
read-only outliner preview row primitive. Source rows therefore reuse the normal
outliner row shell, indentation, chevron slot, bullet/reference marker, title
text, description text, and trailing action slot. Source breadcrumbs align with
group labels; source row markers and titles align with normal node body rows.
Source breadcrumbs are navigable.
Reference-valued field sources use the reference marker; ordinary linked and
unlinked source rows use the normal content bullet.
Each source row renders a reference frame behind its bullet, wrapped title,
description, and trailing action slot; the frame uses the same left and right
range as the normal node selection affordance and a heavier left quote rule.

Source rows show the source node's full title text with normal wrapping, not a
single-line ellipsis. If the source node has a description, the description is
shown as secondary wrapped text under the title, aligned to the same text column.
Unlinked content mentions keep their `Link` action in the row's independent
trailing action slot as a lightweight link-colored button with a transparent
hit area and no default material background; the title wraps before the action
slot so long source text remains readable.

Linked references include:

- tree reference rows whose `targetId` is the panel root and whose `refRole`
  counts as a backlink;
- inline node references in rich text;
- reference-valued field children, attributed to the owning content node and grouped under
  the field name.

Search nodes do not count as reference sources. A saved search is a view/query,
not a user-authored citation of every node it happens to include, filter by, or
name in its title. Materialized search result references, direct references and
plain-text mentions on `search` nodes, and query operand references or mentions
inside `queryCondition` subtrees stay out of the backlink graph.

Unlinked mentions are exact, case-insensitive title matches in visible node text
and descriptions. Latin-word matches require word boundaries, so `Project Alpha`
does not match `Project Alphabet`; adjacent Unicode letters/numbers are also
treated as token characters, so a CJK title does not match inside a longer CJK
word. Repeated matches in the same source node count and render as separate
unlinked mention rows, so linking one occurrence leaves the other plain-text
occurrences visible and linkable. Unlinked mentions in normal content rows expose
a `Link` action that replaces only the matched text range with an inline node
reference through the normal rich-text patch command; description mentions are
listed but not linkable.

Rows do not show inline backlink counters. Counts live in the NodePanel footer
only. The collapsed References count is the linked-reference count, matching the
read-only `References` system field. Unlinked mentions are computed only for the
expanded panel root and appear as a separate group count.

The read-only `References` system field uses the same cached reference summary
for its linked count and deduped source rows. Sorting, filtering, grouping, and
rendering by that system field reuse the summary for the current projection frame
instead of rebuilding the full-document reference graph per row or per sort
comparison.

## Selection Mode Matrix

Selection scope is panel-level, not value-column-local. Field value rows render
inside the field row's value column, but stored value rows participate in
Shift/Cmd selection, drag selection, `Mod+A`, clipboard, and batch actions in the
same panel-level selectable order as ordinary rows. Visual editing navigation
continues to use the body/reference visible row order, so value rows do not become
implicit previous/next body rows for text editing commands.

| Interaction | Expected behavior |
| --- | --- |
| Click row body | Select row. |
| Click editable text | Enter edit mode. |
| `Escape` in edit mode | Select current row. |
| `Enter` on selected row | Enter edit mode. |
| Printable key on selected row | Append that character and enter edit mode. |
| `Shift+ArrowUp/Down` | Extend visible row selection. |
| `Mod+A` | Select every selectable row in the current panel scope, including stored field value rows. |
| `Tab` / `Shift+Tab` | Batch indent/outdent selected root rows and preserve selection mode, selected rows, and selection anchor. Tab applies only to contiguous selected runs whose first row has an unselected previous sibling; a selected run at the start of its parent is a no-op, so later selected rows never become children of earlier selected rows. Shift+Tab never moves rows above the current panel root; panel-root rows are a no-op. Shift+Tab collapses any previous parent emptied by the move so the moved rows stay adjacent to their old parent. Visible rows that change position during the structural move use a short transform-only movement animation; `prefers-reduced-motion: reduce` disables it. Field value rows are excluded from structural indent/outdent because they may not leave their owning field entry. |
| `Backspace` / `Delete` | Remove selected root rows by selectable-row policy: ordinary rows trash normally, stored field value rows route through `remove_field_value`, and synthetic `sysref:*` rows no-op. A single ref-clicked ordinary reference deletes the reference row itself; a ref-clicked reference-valued field child still routes through field-value removal. |

## Paste And Clipboard Conversion Matrix

Paste is structure-aware: the parser (`pasteParser.ts`) converts the most
faithful clipboard representation into rows. When the clipboard carries both
`text/html` and a `text/plain` fallback, the plain-text Markdown parser wins only
when the HTML is the lossy side — flat `<div>`/`<p>`-per-line (the editor-copy
shape that whitespace-folds indentation and keeps literal `- `/`[x]` markers).
Genuine `<ul>/<ol>/<li>` HTML is trusted so a rich web-list keeps both its
hierarchy and its inline marks. The first pasted block merges into the target
row; the rest become siblings/children. Behavior parity target is nodex
(`html-to-nodes.ts` / `applyParsedPasteMetadata`).

| Interaction | Expected behavior |
| --- | --- |
| Paste multi-line plain text | One row per line. In the agent composer (single-paragraph schema) the lines are kept as `hardBreak`s within the row. |
| `<br>` inside an HTML block | Split the block's inline run at each `<br>` into sibling rows, not a single space-joined row. |
| List markers `- * +`, `1.` / `1)`, bullets `• ◦ ▪ ‣ · ●` | Stripped from the start of a line; nesting from indentation is preserved. |
| Fenced ```` ``` ```` / `~~~` block | Becomes a code-block row with detected language. |
| Inline Markdown (`**bold**`, `*italic*`, `~~strike~~`, `[label](url)`) | Converted to the corresponding marks. |
| Single-line bare URL with a text selection | Wraps the selection as a link. |
| GFM task line `- [ ]` / `- [x]` | Becomes a checkbox row (`completedAt` sentinel: `undefined` none, `0` unchecked, timestamp checked) when the marker is alone or followed by whitespace; `[x]title` stays literal text. Merging a task line into an existing **non-empty** row never flips it to checked — only a genuinely empty target row adopts the pasted checkbox state. |
| `#tag` on a Markdown/plain line | Harvested and applied; unknown tags are auto-created (find-or-create), reusing same-named defs. Guard: start/whitespace before the shared tag token. Bare tags accept Unicode letters/numbers, `_`, and `-`; `[[#tag]]` / `#[[tag]]` are accepted; bracket names accept raw backslashes, and serializers escape `]`, backslash, and newline-style characters as `\]`, `\\`, `\n`, `\r`, and `\t`; bare CSS hex colors such as `#fff` and `#112233` are left literal. |
| `name:: value` on a Markdown/plain line | Harvested as a field; unknown fields auto-created as `plain`, existing `options` fields smart-select the option. Guard: a double colon **followed by whitespace** (`name:: value`), so `std::cout`, `http://…`, `foo::bar` never match. Field values stop before the next field or shared tag token; bare CSS hex colors do not terminate the field. |
| `#tag` / `name::` inside a link label, URL, or `` `code` `` span | Left literal — link/code spans are masked out of the metadata scan (so `See [the #section](url)` keeps its label). |
| Metadata on the HTML paste path | Not harvested — `#tag` / `field::` extraction is scoped to the plain-text / Markdown path; HTML pastes still convert structure. |

## Leading Control Matrix

| Interaction | Expected behavior |
| --- | --- |
| Hover any row | Show chevron affordance. |
| Click chevron on row with children | Toggle expanded state. |
| Click chevron on leaf row | Expand an empty child scope and focus its trailing input. |
| Click chevron or indent guide while scrolled | Preserve the clicked disclosure trigger's viewport top across the layout commit. Removing or adding descendant flat rows must not pull the clicked row/header up or down. The correction is instantaneous scroll compensation, never smooth scrolling. |
| Hover indent guide line | Thicken only the guide line, without expanding into child chevron hit targets. |
| Expanded scope guide line | Render as a visible neutral guide for expanded rows, including leaf rows expanded to show trailing input. Every marker has the same transparent marker slot; the visible glyph is only centered content inside that slot. The guide uses the actual marker slot DOM as its geometry source, not the visible glyph or an estimated flat-row layout: the flat renderer measures `.row-bullet-button` for the parent and last mounted descendant relative to `.outliner-flat-guides`, then feeds measured `left` / `top` / `height` into the guide. The band starts just below the parent marker slot so marker clicks remain owned by the marker itself. File icons, bullets, and other marker glyphs share one structural marker slot regardless of glyph size. The line ends on the last visible descendant marker centerline, so tall previews, wrapped content, and glyph size never stretch the structural line. |
| Click indent guide line | Toggle expanded state for the row's direct children when present. |
| Click bullet | Open/drill into the node. |
| Drag bullet | Move the row, expanding inside-drop targets. If the dragged row is part of a block selection, move the selected structural roots together in visible order as one undoable document operation; dropping on a trailing draft row appends to that scope. Only the nearest hovered row owns the drop guide line, including nested rows. Invalid or completed drags clear any guide line and keep block selection instead of focusing a single row. |
| Applied tag display | Render tags inline after node text using nodex-style badges; do not render a second-line chip strip. |
| Applied tag bullet color | Color the node bullet from applied tag colors, using pie segments for multiple tags. |

## Trigger Matrix

- `#` opens tag selection.
- `@` splits between tree reference and inline reference based on trigger
  position and cycle constraints.
- `/` opens slash commands only when the node is otherwise empty.
- `/attachment` opens the native file picker, ingests the selected files, and
  inserts non-image assets as attachment siblings at the row's current position.
  Picked images keep the image-node flow.
- `>` creates a field row only when the content is exactly the bare trigger.
- Trigger menus must route `ArrowUp`, `ArrowDown`, `Enter`, and `Escape` before
  normal outliner navigation.

## File And Attachment Matrix

Binary files are not embedded in the document. The renderer ingests dropped or
picked files through asset commands, then creates document rows through core
commands so undo/redo and projection updates stay document-native.

| Interaction | Expected behavior |
| --- | --- |
| Drop files on an outliner row | Prevent the browser's default navigation, ingest every regular `File`, and show the same neutral insertion guide used by node reordering while the external file hovers. The top third inserts before the row, the middle third inserts as the row's first child (expanding the row), and the bottom third inserts after the row; if the target is expanded with children, after drops as the first visible child to match normal outliner drag semantics. Images create image nodes, and all other assets create attachment nodes in source order. |
| Paste files into an outliner row | `Cmd+V` / paste reads regular `File` objects from the clipboard and ingests them through the same asset-node mapping as file drop. A real `File` payload wins over companion display text from the source app, so copied files paste as file nodes rather than filename text. Pure image clips keep the image paste path, while mixed or non-image file clips create file nodes together in source order. On a draft row, files land at the draft's current position; on a committed row, non-image files insert after that row. |
| `/attachment` on an empty row | Delete the slash trigger, open the native attachment picker, ingest selected files, and place image/attachment rows at that row's position. Cancel leaves the row empty. |
| File node render | A non-image file (attachment) renders as a **lightweight name row**: its **file-type icon is the bullet** (the `file` RowMarker variant — audio / video / pdf / generic), the row content is the **read-only filename** that wraps inside the content column, and tag chips follow the filename in the same inline flow. The row has no trailing action menu; file actions live in the preview surface controls. The filename is **display-only** and never opens or renames from inline typing; instead the **chevron expands an inline preview** and the **bullet drills** to the node page. An **image** is the one exception (see below). |
| File node is a normal node | A file node behaves like any node, plus an inline preview: the **chevron expands an inline preview widget** under the row (the same widget the node page uses, started in summary mode), and the normal children outline renders below it. If the file node has no children, that outline still shows the standard trailing draft so users can add the first child note inline. It can carry child notes, tags, be moved, referenced, pinned, and opened on its node page — all for free. A non-image row mounts a read-only filename editor surface so a caret can land anywhere in the filename while ordinary input is rejected. That surface gives the row full keyboard parity — arrow nav, Enter to add a sibling, Tab to indent, Backspace to remove the node, `Cmd+V` with real files to insert file nodes after the row, and `#` to open the tag picker for the file node itself without editing the filename. Image rows use a visually-hidden focus anchor for the same keyboard parity because the visible row content is the image; applied tags still render visibly after the inline image so they can be seen and removed. |
| File node row click & reference | Clicking inside a non-image filename places a read-only caret without an extra row-level focus frame, and clicking outside the filename selects the row; the chevron toggles the inline preview and the bullet drills to the node page. Clicking an inline image selects the image row; Maximize lives in the image row's `⋯` menu. A `reference` whose target is a file node still renders as a normal **reference row**, not with the file's icon-bullet / inline image. |
| File node preview | The preview shows in two places: **inline** under an expanded file row, and as the **node page** hero (drill the bullet). Both render the same `FilePreviewShell` — on the node page an outliner-ancestry breadcrumb + **read-only filename title**, then the rendered file inside one rounded preview viewport, then the node's children outline. Preview shell state (expanded/collapsed, local resized heights, pending PDF page jumps, and restored PDF/EPUB reader positions) is scoped to the current resolved file identity, so navigating file A → file B in the same pane does not leak A's view state into B. Document-like previewable files start in **summary** mode; PDFs render a compact horizontal strip of page previews for every page instead of cropping the first page, with token spacing between the filename/tag line and the preview viewport. Audio/video previews are direct playback controls, so they render as a flat media stage without the document preview card chrome, Expand/Collapse primary, or resize handle; the native media element is marked as an interaction-preserving surface, but its browser controls are replaced by a Media Chrome control bar themed with Tenon tokens. The Tenon `⋯` file-action menu lives inside that same control bar beside playback, timeline, volume, and fullscreen controls, so audio and video keep one visible action layer and never spill outside the pane or cover the scrub bar. All framed file previews keep content inside an inner inset: PDF pages, EPUB pages, markdown/code blocks, text/code previews, tables, and directory listings must not sit directly on the viewport frame, and horizontal scrollbars sit in a reserved bottom gutter rather than against the frame or over the last line. Summary PDF pages fit the preview viewport height, keep the same natural token inset on all four viewport edges, scroll horizontally inside that inset, use tight page-to-page spacing, and can be clicked (or keyboard-activated) to expand into the full vertical reader scrolled to that page; that page jump is one-shot and is consumed after it lands so resize does not snap back to the old target page. The full PDF reader scrolls inside the same inset-preserving content box, so vertically-scrolled pages do not enter the viewport's top or bottom inset. The shared bottom action bar floats over previewable content instead of occupying a blank bottom band. Its primary and `⋯` are separate controls, not a segmented control; document-like previewable files use a fixed-width `Expand` / `Collapse` primary, while audio/video keep only the in-player `⋯` file-action menu. The viewport's bottom edge can be dragged (or keyboard-resized from the handle) to change only document-like preview height. For a non-previewable file, the same surface becomes a compact metadata card: it shows a concise file-kind title such as `zip` with size on the same line and modified date on a separate quiet line (no icon and no `Type` / `Size` labels) and keeps a short **Open** primary plus the `⋯` actions in the same bottom-center action location, with that bar participating in the card layout so it never covers metadata. The node-page title prefers the node display text, then the stored original filename, so old file nodes with blank text do not show `Untitled`. |
| Image render (inline) | An image is the one file kind that renders inline as the image **itself** (an image's content is its identity) instead of an icon-bullet name row: a bounded `<img>`, with no file-type icon and no filename in the row. Its `⋯` menu floats at the image's top-right, revealed on hover; the menu's primary action maximizes it (opens the file preview). |
| File node ⋯ menu | Non-image file rows do not carry a row-level `⋯`; the chevron opens the inline preview, and the preview surface's `⋯` carries the stored asset's system actions. An image's inline surface still has a top-right `⋯` whose primary action is **Maximize**. |
| File node actions | Document-like non-image file previews use the same bottom-center preview action location so actions never move between document formats. For document-like previewable files, its fixed-width primary toggles **Expand/Collapse**, and its separate `⋯` menu carries **Open in split pane**, **Open with default app**, **Show in Finder**, **Copy file**. Audio/video previews have no useful expanded state, so they omit the primary and expose the same system actions through the same-layer `⋯` media control. `Open in split pane` opens a dedicated file-only reader pane: the pane is bound to the file node for persistence/source identity, but it renders only the file content and header actions — no outliner ancestry, node title hero, child outline, References section, Expand/Collapse primary, or preview resize handle. PDF/EPUB/HTML file-only readers fill the available pane height; PDF and EPUB still keep their internal document viewport/inset so pages and section frames never sit directly on the pane edge. For non-previewable files, the same action bar shows a short **Open** primary for the default-app action and uses `⋯` for the same system actions. Open uses the OS default app after the main process revalidates the asset path and local-file policy. Reveal shows the stored asset copy. Copy puts the stored asset file on the clipboard. |
| Media preview controls | Audio and video previews stay visually single-layer: they do not add the document preview's outer frame/background/inset around the player. The playable media surface itself is the only visible container and carries the shared file outer edge treatment (`--file-preview-frame-radius` plus `--inset-hairline`) so its corner and border quality matches other file previews without adding another wrapper. They still omit document-specific Expand/Collapse, resize, and bottom floating action chrome. Media Chrome playback/mute/fullscreen buttons and the Tenon `⋯` file-action button use the product icon-control geometry (`--control-size-xl` hit area with `--icon-size-md` glyphs), hover/focus deepens `--text-secondary` to `--text-primary`, and icon-only controls do not add `--fill-*` hover boxes. Timeline and volume ranges keep transparent hover backgrounds and fixed control height so scrubbing never shifts the bar or visually overlaps the file-action menu. |
| Missing asset metadata | The preview shows an unavailable message; the row stays an ordinary file name row with a display-only filename and exposes no broken system actions. |
| Non-node source preview | A source with no node (agent payload, loose inline local-file ref, url) opens the same `file-preview` surface in its loose state: source/path breadcrumb, read-only filename/source title, and the shared preview, but no children outline. URL sources are previewable but not file-like: the breadcrumb/header shows the reported webpage favicon and title, the body starts directly with the sandboxed webview, and the single-layer surface has no document frame, duplicate heading, Expand/Collapse, resize handle, or bottom action bar. A neutral `Languages` icon before the header `⋯` opens the task-first translation popover. Its stable glyph is muted while off, becomes the fixed-size spinner during initial work, and gains a subtle circular neutral fill after translated content is visible; it never composites a completion badge. Target language follows the UI locale until explicitly changed, model defaults to dynamic `Follow Agent`, and explicit target/model plus automatic translation are remembered. Automatic translation remains opt-in and activates only for a valid differing top-level language. `Option+A` on macOS and `Alt+A` elsewhere toggles only the active URL preview. Translation uses at most three concurrent requests per page: the first visible batch is at most two blocks / roughly 2,000 characters, later batches are at most four blocks / roughly 4,000 characters, and no more than one active batch is prefetch. Independent batches render in response order. Before direction is known the guest prefetches roughly two viewports both ways; afterward it keeps roughly four viewports ahead and one behind, symmetrically for upward and downward reading. A 120ms probe replaces only offscreen low-priority work when full capacity is needed for new visible content. Blocks outside the bounded window remain unsent, completed blocks stay cached, and same-target-language blocks are skipped. Each submitted source gets a fixed-size inline loader; success inserts inert text, while failure becomes a keyboard-accessible paragraph retry and pauses normal scheduling until recovery. Translation/status insertion and hide/show preserve the visible source anchor. Navigation, reload, pane close, and target/model changes cancel all page-local work; URL previews retain **Open in browser** in the header menu. Other loose sources retain the shared preview and system-action behavior described by their renderer. |
| Agent transcript file preview | Live agent transcript file chips are local working-file pointers, including user attachment chips, user inline file references, assistant prose references, and assistant-produced file result chips. A click opens a file-only reader in the center workspace area, reusing the active/available workspace pane rather than adding a split pane or previewing in the agent dock. The reader uses the same file preview content shell as workspace file previews, starts in full reader mode, has no Expand/Collapse or resize handle, and shows only the compact reader header with filename and `⋯` actions. The `⋯` menu keeps the system actions: **Open with default app**, **Show in Finder**, and **Add to outline** for ingestible files. |
| Add a non-node source to the outline | The loose preview's `⋯` menu offers "add to outline" for ingestible kinds (`local-file`, `agent-payload`; not `url`): it copies the source into the asset store, creates a file node under Today, and binds the same mounted preview surface to that node in place. After that it is an ingested node with outliner ancestry, a children outline, and file-node actions. |

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
| Selected options reference value | ArrowUp/Down moves through field options, Enter selects, and Escape closes the options list before clearing the selected reference row. | `outliner-triggers.spec.ts` |
| Type `@` in a plain field value draft | Open the standard reference suggestions. A whole-value pick becomes a structural reference child when left unchanged; a pick inside surrounding text becomes an inline reference in the plain value node. | `outliner-triggers.spec.ts` |
| `LINKS_TO` query rule | Match linked references only: tree references, inline node references, and reference-valued field children whose target is the query target. Do not match unlinked textual mentions. | `searchEngine` |
| Toggle checkbox/done on a reference row | Apply the done state to the target node, because the reference displays the target. | `outliner-parity.test.ts`, `outliner-selection-keyboard.spec.ts` |
| Permanently delete a target node | Remove tree references and inline references to that target. Undo restores both. | `core.test.ts` |
| Trash a target node | Keep references restorable; the reference still points at the trashed target until restore or permanent delete. | `core.test.ts` |
| Reference to a reference | Normalize to the effective target. Nested reference nodes should not point to reference nodes. | `core.test.ts` |
| Agent/tool `replace_with_reference_to` | Replace or retarget a block reference through core commands, subject to the same duplicate and cycle constraints. | `agentNodeTools.test.ts` |

## IME Composition Vs Async Echoes

A core command echo (split/create, indent/outdent, undo) applies its
`focusRequest` asynchronously, ~60-80 ms after the keystroke that issued it. A
composition started inside that window must never be aborted by the echo
(issue #176): moving focus or selection mid-composition makes Blink
force-commit the partial text (`skill` torn into `sk` + `ill`).

Mechanism (`src/renderer/ui/editor/compositionRelay.ts`): every
`RichTextEditor` registers its live composition in a module-level gate; every
`focusRequest` applier (the editor itself, plus `OutlinerFieldRow`,
`CodeBlockRow`, `NodeDescription`, `BlockNodeRow`) parks the request unconsumed
while `isCompositionLive()`. At compositionend the composing editor decides the
parked request's fate — only a request that ARRIVED during the composition is
relayed: aimed at itself, it flushes then applies the held placement; aimed at
another editor, it reverts its local doc to the echoed content (composition
transactions never flushed, so that is core's truth), extracts the composed
insertion, and re-issues the request through `relayCompositionHandoffState` —
non-empty text rides the pendingInput rail so the word lands whole at the
target's cursor placement.

The same torn-word symptom has a second, focus-independent cause: composing
into an EMPTY textblock. The block has no #text node to host the IME's marked
range, so ProseMirror redraws the whole paragraph element on the first
non-append composition rewrite (macOS Pinyin re-segments "s k" → "sk i" at the
third letter) and the OS IME session dies with the removed node — force-commit
mid-word, then a torn recompose. Mechanism
(`src/renderer/ui/editor/imeCompositionAnchor.ts`): at composition start the
editor dispatches `compositionAnchorTransaction`, seeding the empty block (and
the inline-ref-adjacent caret cases) with the zero-width sentinel and parking
the caret after it; the composition then always binds to a stable #text node
that ProseMirror patches in place. The codec strips the sentinel, so it never
reaches `RichText` or patches.

| Interaction | Expected behavior | Test coverage |
| --- | --- | --- |
| Compose IME text immediately after Enter (split/create) | The composition is never interrupted: exactly one `compositionend` carrying the full composed text, focus moves only afterwards, and the composed word lands whole at the start of the new row; the old row is untouched. | `compositionRelay.test.ts`, `focusModel.test.ts`; live-app acceptance via `scripts/probe-ime-split.ts` (the e2e mock has no real async echo; synthetic keystrokes bypass the macOS IME) |
| Compose IME text into an empty row | The composition survives IME re-segmentation: the paragraph element is never redrawn (characterData-only updates on the anchored #text node), one `compositionend` with the full word. | `imeCompositionAnchor.test.ts`; real-IME verification only — CDP `Input.imeSetComposition` replaces the whole text node including the anchor, unlike a real macOS IME, so the probe cannot cover this leg |
| Echo focus targeting the composing editor itself (e.g. indent keeps focus in place) | The placement is held until compositionend, then applied after the normal composition flush. | `scripts/probe-ime-split.ts` technique; unit-covered via relay state tests |
| Cancelled composition while a request is parked | The bare focus request is re-issued at compositionend; no text is relayed. | `compositionRelay.test.ts` |
| Editor unmounts mid-composition with a parked request | The gate is released and the parked request re-issued without text (the composed text dies with the row). | code-reviewed edge; gate release asserted in `compositionRelay.test.ts` |

Diagnostics: dev builds emit an `[ime-trace]` console.debug rail
(`compositionRelay.imeTrace`) covering every composition/focus decision plus a
per-composing-transaction forensic line (doc text, DOM, composition node,
block-swap flag) in `RichTextEditor.dispatchTransaction` — readable over CDP
for live repros; fully gated out of prod.

Known gap (accepted): textarea surfaces (description, code block, field name)
are protected as focus *targets* by the gate but do not register their own
compositions; an echo landing while composing inside a textarea can still
force-commit there. Plain (non-IME) characters typed inside the echo window are
a separate, milder stranding class — tracked outside this section.

## Accessibility (ARIA & Focus)

The sighted keyboard model above is unchanged; this section records the
**announced** ARIA structure and focus management that assistive tech relies on.

**Anchored overlay keyboard** (`primitives/useMenuKeyboard.ts`). Floating menus
and popovers built on `useAnchoredOverlay` (not the modal `Dialog`) opt into one
shared hook that mirrors what `Dialog` already does for modals: focus-in on open,
focus-restore to the trigger on close, Escape-to-close scoped to the surface, and
either roving Arrow/Home/End navigation (`kind: 'menu'`) or a Tab focus-trap
(`kind: 'dialog'`). Focus-in and focus-restore are **separate effects**: restore
keys on the open↔close transition only, while focus-in also re-runs whenever the
optional `focusKey` changes — the identity of the surface's *content*. A surface
that swaps its body in place (a menu's Back button, the view toolbar switching
section) bumps `focusKey` so focus is pulled back into the surface after the swap;
without it, focus would be left on an unmounted child or the pill outside the
surface and Escape/roving would go dead. The restore target is captured into a ref
at open time, never read live at close (by then the open-section state is already
cleared). It is IME-guarded (`isImeComposingEvent`) so CJK composition
keystrokes are never hijacked, and it makes the surface programmatically focusable
(`tabindex=-1`) without per-call wiring. The roving index math is one pure
`resolveMenuNavigation(key, index, count)` reused by the menu kind, the
`RadioOptionGroup`, and the child-run tablist (which maps Left/Right onto it).
Escape ownership moves to this hook, so
`useDismissibleOverlay` is invoked pointer-only (`{ escape: false }`) where the
two compose. Adopted by: `NodeContextMenu` (menu in `main` mode, dialog in
tag/move submodes), `SettingsRowMenu`, the agent conversation row menu and the
agent history/session menu (which previously had **no** Escape), the view-toolbar
section popovers, and the date-value picker. The two `⋯`-style row menus (settings
row, conversation row) share one `primitives/AnchoredActionMenu` that bundles the
anchored positioning, the hook, and trigger-aware outside-pointer dismissal.
Surfaces already on `Dialog` (Command Palette, Confirm, Launcher) are unchanged.

**Outliner tree** (`PanelChildrenOutline`, `OutlinerRowShell`). The outline
container is `role="tree"` + `aria-multiselectable="true"` + `aria-label`. Each
row wrapper (`.row-wrap`) is `role="treeitem"` carrying `aria-level` (1-based
*panel-relative* depth — the drilled-in root is level 1, by design), `aria-selected`,
and `aria-expanded` **only when the row has children** (leaf rows omit it so no
phantom toggle is announced). `aria-selected` tracks the **visible** selection
(the `.selected` class), so a ref-click-selected row — which paints
`.ref-click-selected`, not `.selected` — reads as unselected, matching what is seen.
A row's nested children render inside a `role="group"` (the `.children` wrapper),
completing the tree nesting (treeitem → group → treeitems). Non-treeitem content
that sits inside the tree (the definition-template label banner, the empty-state
placeholder) is `role="presentation"` so only rows are announced as tree items; the
empty state's loading variant stays a `role="status"` live region. The two
virtualization wrappers (`.outliner-flat`, `.outliner-flat-row`) are
`role="presentation"` so the windowed treeitems read as direct tree descendants.
This is additive structure — no tabindex is added to the tree (focus lives in the
contentEditable model), and `useWorkspaceKeyboard` is untouched.
`aria-setsize`/`aria-posinset` under virtualization, and whether field/preview rows
should stay `treeitem`s or become `role="none"`, are deferred follow-ups for the
live-screen-reader gate.

**Calendar month grid** (`primitives/CalendarMonthGrid.tsx`). `role="grid"` with
one `role="row"` per week and `role="gridcell"` day cells. Exactly one day is a
tab stop (roving tabindex: the selected day, else today, else the first in-month
day); Arrow keys move ±1 day / ±1 week, `Home`/`End` to week ends, and
`PageUp`/`PageDown` by month. When a keyboard move lands outside the rendered
window the grid calls `onMoveMonth` with the **exact month difference** between the
target and the current view (not a fixed ±1), so a Page step from an overflow cell
already showing an adjacent month still lands the target in view. The grid is
`aria-multiselectable` only when it can hold more than one selected cell (a date
range's two endpoints). The selected day(s) carry `aria-selected`, the today cell
`aria-current="date"`.

**Corrected role mappings** (announced role now matches the control):
- Interactive `DoneCheckbox` → `role="checkbox"` + `aria-checked` (matching its
  read-only twin), not `aria-pressed`.
- View-toolbar single-select options → a `role="radiogroup"` wrapper
  (`RadioOptionGroup`) with `role="radio"` + `aria-checked` options, roving
  tabindex and Arrow move-select; multi-select option lists stay
  `role="checkbox"`.
- Child-run details tabs → `role="tablist"` / `role="tab"` (`aria-selected`,
  `aria-controls`, roving Arrow/Home/End) with the body as `role="tabpanel"`.
- Command Palette input → `role="combobox"` + `aria-expanded` +
  `aria-autocomplete="list"` (it already had `aria-activedescendant` /
  `aria-controls`), mirroring the Launcher.

Live keyboard + VoiceOver verification of focus-in / trap / restore is the gate
for this surface set; jsdom focus semantics do not cover focus reality.
