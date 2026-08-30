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
- The main outliner and editable field-value outlines render through the flat
  row producer exclusively. Small
  outlines render the full flat list in normal flow; large outlines window the
  visible rows with overscan, while focused and draft rows stay force-mounted so
  keyboard navigation and trailing inputs still work. Table subtrees and system
  reference values reuse that renderer in embedded-flow mode; there is no second
  recursive editing implementation or renderer-state/local-storage switch.
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
- Field slots are ordinary outline rows with field-specific value rendering.
  Each slot's top and bottom separators stay hidden until that row is hovered or
  focus is inside its field name/value area, including entries in the middle of a
  contiguous field group.

## Row State Model

- `focusedId` means the row is in edit mode.
- Programmatic focus for an editable outliner row goes through the
  `focusRequest` state rail. Callers never focus row DOM directly; the row-owned
  consumer performs the DOM focus only after the shared IME composition guard
  allows it, leaving a blocked request parked until `compositionend` relays it.
  Outside that request consumer, direct `element.focus()` is reserved for
  non-editor chrome.
- Every accepted projection update reconciles renderer-local row state against
  the nodes that left the previous projection. Delta removals and full reseeds
  follow the same rule: stale focus and deferred requests, selection metadata,
  description and toolbar requests, and outline expansion are cleared before
  they can target a removed node. Unaffected state and set identities remain
  stable so unrelated rows do not re-render.
- `selectedId` and `selectedIds` mean row selection mode.
- `selectionRootId` is the panel-level selection scope. Field values still render
  inside a nested value-column `OutlinerFlatView`, but their selection root is the
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

## Rich Text Editor Runtime

- Ordinary focused rich-text edits are patch-first. Insert/delete text and
  add/remove mark transactions emit bounded `RichTextPatch` operations from the
  ProseMirror transaction steps; they do not serialize the complete editor
  document or compare complete `RichText` objects on the input frame.
- Complete `RichText` snapshots remain explicit slow-boundary work: composition
  flush, structured paste, external replacement, blur/commit, Enter/split,
  mod-Enter payloads, and transactions that cannot be represented as bounded
  patch operations.
- The focused editor owns an in-memory content mirror. During ordinary edits it
  updates that mirror with the emitted patch, updates primitive UI facts such as
  emptiness and trigger state from bounded data, then dispatches the patch to the
  host. The full `onChange(RichText)` snapshot callback is not part of the
  ordinary keystroke path.
- Row and panel-title hosts keep their draft/title mirrors in refs and apply the
  same patch before sending `apply_node_text_patch`. React state is updated for
  visible primitive/editor-control needs (for example active triggers, option
  picker query text, or replace-all slow boundaries), not for every ordinary
  large `RichText` object.
- Body rows, field names and values, Table cells, code blocks, descriptions,
  checkbox controls, and file keyboard anchors consume matching focus requests
  and pending printable input in the layout phase. External draft reconciliation
  also completes before paint, except while the local editor owns a newer focused
  draft or a live IME composition. No editable surface may use a timer, animation
  frame, or passive effect to hand off focus or the first character.
- A `RichTextEditor` targeted by focus or pending input constructs its
  `EditorView` synchronously in the layout phase. Untargeted visible editors keep
  passive construction so opening a large outline does not put every ProseMirror
  instance on the initial critical path. One component identity constructs one
  `EditorView`; draft materialization and authoritative settlement reuse it.
- Trailing drafts are keyed by semantic ownership, not a transient backing
  entry. A field-value draft uses the owner/field-definition slot identity, so
  materializing a previously virtual field entry remaps the parent without
  remounting the draft editor or losing pending input.
- Middle-row Enter first settles already-queued text patches, then replaces the
  row's local draft mirror with the split head before submitting the atomic
  split. The accepted projection delta confirms the split and clears that mirror
  in the same render commit; the later durable Operation Event is deduplicated.
  A rejected split restores the complete pre-split draft. A pre-split mirror
  must never suppress the accepted split-head replacement and leave duplicated
  tail text on screen.
- Ordinary create, split, and empty-row removal update the visible row structure
  in the initiating renderer turn. Create and split mint the real Node ID before
  submission and render one pending row with that ID and its final React key;
  accepted settlement upgrades the same editor in place and folds the Runtime's
  authoritative Projection delta without waiting for durability. Text typed into
  a pending split row is retained and reconciled after creation. Removal hides
  the pending row without deleting it from the Projection. An existing trailing
  draft stays mounted after a pending created row from the first optimistic frame
  onward; it is never removed and re-added at settlement. The accepted projection
  apply and pending presentation cleanup share one synchronous render commit;
  command rejection removes the pending presentation and restores source content
  and focus.
- Body, field-value, and Table-hosted node editing all delegate create, split,
  remove, merge, relocate, done-state, and semantic row conversion to the same
  optimistic structural transaction. A nested renderer may choose layout and
  navigation policy, but it may not implement a second settlement or focus path.
- Trigger detection in the focused editor uses the current mirror and a bounded
  caret window for long text. Full-text trigger parsing is retained only for
  short rows where slash/bare-trigger semantics require exact whole-row context.
- Inline-reference title and color changes update presentation immediately when
  the editor is idle. While it is focused or composing, the editor records a
  pending presentation refresh and applies it on blur or composition end from
  the current ProseMirror document, so a target rename never overwrites local
  semantic edits and does not wait for an unrelated parent render.

## Trailing Input Matrix

| Interaction | Expected behavior |
| --- | --- |
| Printable text on empty trailing row | Create an eager child at the draft's current visual position and keep editing that node. If the draft was relocated after a sibling, the fresh trailing draft stays after the newly materialized node. |
| Undo after eager trailing-row typing | The materializing create and its immediately following text patches share one text-edit undo group, so one document undo removes the half-typed row instead of first replaying the initial seed text. |
| `Enter` with text | Create content at the draft's current visual position, then create/focus a new empty row immediately after it in the same parent. |
| Empty `Enter` | Create/focus an empty child at the draft's current visual position and keep the next trailing draft immediately after it. |
| `Mod+Enter` | On a body trailing draft, materialize a real node at the draft's current visual position (including when empty), then cycle it from no checkbox to an undone checkbox. If materialization is rejected, keep the draft and its original error without issuing the checkbox command. On an empty field-value trailing draft, do nothing. |
| `Tab` | Relocate the trailing input under the sibling immediately before the draft's current visual position and expand that sibling. At the scope end, this is the last child; after `Shift+Tab`, this is the parent the draft follows. The draft stays a draft — the cursor stays put and no node is created until text is typed. If there is no preceding sibling, `Tab` is a no-op. |
| `Shift+Tab` | Relocate the trailing input one parent level up, immediately after the current parent in that scope (no node created until text is typed). At the current panel root, `Shift+Tab` is a no-op. |
| Empty `Backspace` after a `Tab` relocate | The draft now sits under the (empty) sibling it was relocated into, so the "parent has no children" rule below applies: collapse that sibling and focus it. |
| Empty `Backspace` when parent has no children | Collapse the parent and focus it. |
| Empty `Backspace` when parent has children | Focus the last visible child. |
| `ArrowUp` | Focus the last visible child above the trailing row. |
| `ArrowDown` | Focus the next visible row after the draft's structural position. At the panel boundary, navigate out only if the parent view supplies that callback. |
| `#`, `@`, `/`, `>` | Create the matching trigger/field row and open its menu. |

The live `#` tag trigger stays active only while the query after `#` contains
bare tag characters (Unicode letters/numbers, `_`, and `-`). Punctuation such as
`.` ends the tag query instead of keeping the dropdown open for text that cannot
be written as a bare tag.
Tag suggestions include only active tag definitions: a `tagDef` in Trash remains
visible on rows that already carry it as a deleted badge, but it is not offered
for new tagging. Typing the same label creates a new active tag definition
instead of reusing the trashed one.

Suggestion list identity includes the query and the ordered result identities.
When either changes, the active suggestion resets or clamps in the layout phase
and the active row scrolls into view before paint. A newly rendered result set
must never show the previous result set's highlight for one frame. Asynchronous
candidate validation may disable or annotate results, but it must not overwrite
an Arrow-key selection the user made while validation was pending.

## Field Row Matrix

A node's complete field shape is projected from its tags plus its own stored
entries. Tag slots render first in schema order; own entries follow in child
order. A tag slot without a stored value has the stable virtual id
`slot:<ownerId>:<fieldDefId>` and no `NodeProjection`. It is still selectable,
Arrow-reachable, and focusable: row navigation targets its field-name surface,
while value editing targets a synthetic trailing editor under the slot id. The
first accepted value materializes the backing entry through `update_field_slot`
without changing the visible row identity, so pending printable input and IME
state survive the transition.

A virtual tag slot has no instance-owned structure to mutate. Delete, drag,
indent/outdent, duplicate, tag, checkbox, description, and structural context
menu actions are disabled. Removing the tag removes a valueless virtual slot;
stored values survive untagging as own fields. Clearing or removing the last
value and committing an empty tag slot dematerializes its entry, while an empty
own field entry remains stored.

When the template entry carries a static value, an unmaterialized slot presents
that value as an inherited ghost in `--text-tertiary`. The ghost is read-only:
it does not take pointer input, so clicking or typing in the underlying empty
editor creates the user's own value. A trailing check affordance revealed by row
hover or keyboard focus explicitly accepts and materializes the current default.
Whole-field controls such as checkbox present the inherited state in their native
control while keeping the same separate accept affordance. A stored value replaces
the ghost and no longer follows template edits. Fields configured with
`autoInitialize` never show a ghost because their acquisition-time value is
resolved and frozen only when the tag is applied.

| Interaction | Expected behavior |
| --- | --- |
| Type in field name | Show a reuse popover of matching active existing fields ("Fields") and built-in system fields ("System fields"). Field definitions in Trash are excluded. Nothing is highlighted by default. Fields already present on the same owner node are excluded — a node may not carry the same field twice. |
| `Space` on an empty field name | Summon the full reuse picker (every reusable field + system field, alphabetical) without typing a leading space. Once the name has text, `Space` types normally. |
| `ArrowDown` + `Enter` (or click) in the reuse popover | Reuse that definition: relink the entry to it (`reuse_field_definition`) and drop the throwaway draft def. |
| `Enter` in field name | With no popover candidate highlighted, commit the typed name. An own field entry creates/focuses a sibling row after itself; a projected tag slot has no structural position and moves focus into its value editor. |
| `Enter` in field value | Commit field and create a sibling row after the field entry. |
| `Backspace` at start of field name | Delete an own field row through the same selection-delete path used for selected rows. Focus the previous visible row at end; if there is no previous row, focus the next visible row at start or the panel trailing draft when the field row was the only body row. A projected tag slot is not deletable from its instance. |
| `Mod+A` in field name/value | First press selects the text in that control/editor. A second consecutive `Mod+A` while the editor text is fully selected leaves edit mode and selects every visible row in the panel selection scope. Empty controls have no text-selection step, so `Mod+A` can select visible rows immediately. |
| `>` in field value content/trailing input | Create a nested field entry inside the field value scope. |
| `Tab` / `Shift+Tab` | Stored values use normal structural indentation within the field boundary. Tab may move a direct value under its previous direct sibling; Shift+Tab may promote an ordinary descendant into a direct value. A direct value cannot Shift+Tab out of its owning field entry, and a projected tag slot wrapper cannot move structurally. |
| `ArrowUp` / `ArrowDown` | Move through visible outline rows across field boundaries. Auto-hidden field-value drafts are skipped rather than revealed by navigation; already-visible expanded-child drafts and the panel trailing draft remain navigation targets. |
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

A **field slot row is never expandable**: a materialized entry's direct children *are* its
value(s), rendered in the value column, so the entry has no separate child scope
to open. Each stored value is still an ordinary expandable node. Its descendants
render below it inside the value column, use normal node commands, and are not
interpreted as additional values of the field. A leaf value's chevron opens an
empty ordinary child draft. A direct value keeps field-aware add/remove cleanup;
deeper descendants use ordinary node creation and deletion. An empty checkbox
field shows its standalone toggle before a value node exists; after the toggle
creates a stored boolean, that value uses the same expandable row with the
checkbox as its primary control. The control replaces only the text editor:
Escape, Arrow navigation, Shift+Arrow selection, and Tab structure keys retain
the ordinary row behavior.

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

The standard document reference suggestions are a deterministic bounded
shortlist of at most 24 nodes. Matching retains the existing full substring
semantics at every query length, including one- and two-character queries,
single CJK characters, and mid-word matches. Retrieval is complete by text-rank
tier: no excluded node has a better text rank than an included node, while the
disabled, untitled, context, length, recency, and label tie-breaks apply within
the retrieved set. Empty queries use recency order. Before the shortlist limit,
candidate admission applies the canonical public-Node-ID predicate: only UUIDv4
content Nodes and the explicit public system-Node allowlist can create a Node
reference. Date shortcuts and private non-Node identities are omitted because
they have no public `node://` URI; Composer local-file results remain
separately referenceable through canonical `file:` URIs. Cycle status is
evaluated only for shortlisted nodes from a cached reverse-reachability set;
candidate availability is not a ranking input. Posting keys
share their normalized label storage through offsets, and an overflow edit
overlay is compacted outside the projection commit by a cooperatively yielding
rebuild. The idle timer follows input, while an independent maximum-age timer
and a pressure ceiling ensure a continuous delta stream cannot starve the
rebuild or grow the overlay indefinitely. Deltas accepted during a rebuild stay
queryable in the overlay and are cooperatively rebased before the new base is
committed. A cold or invalidated reachability set is built cooperatively after
the picker opens, never inside the typing event. Node choices remain disabled
until that set resolves; resolution only updates availability and annotations.
It does not reorder candidates or replace the user's selected candidate, so
Enter cannot act on a different row after asynchronous validation. Breadcrumbs
are derived only for the final visible results.

For `options_from_supertag` fields, the source supertag must be an active tag
definition. If the source tag is moved to Trash, the field's value picker no
longer derives candidates from nodes carrying that deleted tag.

## View Toolbar

The node-level view toolbar is the presentation control for Outline child rows
and saved-search results. For ordinary nodes it lives above rendered rows when
the node's `viewDef.toolbarVisible` flag is true. Search nodes instead always
expose one compact icon-first result-view band. It keeps **Outline** (persisted
as `list`) and **Table** visible as one two-option mode selector in both modes;
the active option has `aria-pressed="true"`. Outline additionally provides name
search, Display, Group, Sort, and Filter; Table additionally provides name search,
Sort, and Filter, while Add field owns visible-column configuration. The compact
variant has no summary chips, result count, card fill, or decorative dividers,
and activating name search expands its inline input. Ordinary Outline reuses the
same selector with icon-and-text options. The node context menu's **View as**
subview remains a secondary text entry point rather than the only discoverable
mode control. Table ignores a saved group rule without clearing it,
so returning to Outline restores the same grouping. These controls all read and
write `viewDef` child nodes
(`displayField`, `sortRule`, `filterRule`, plus the view's `groupField`) rather
than storing renderer-local state.
The ordinary **Show/Hide view toolbar** action is not offered for Search nodes:
their result-view band is part of the Search surface rather than a conditional
projection of `viewDef.toolbarVisible`.

Nested toolbars render as part of the expanded child outline, not as detached
cards. They remain logically inside the expanded child subtree, while their
visual indent aligns with the owning node's title/content column, derived from
the same row geometry tokens instead of the bullet or selection gutter. The
expanded parent guide line spans the toolbar and
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
rules remain editable. Its contextual discovery also includes nested fields
visible inside the owner's own field values; Display, Group, Sort, and Table
column discovery continue to treat those owner fields as metadata rather than
record rows. Fields that the data model does not yet expose as computed values
are not shown as fake empty choices.

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

Field display names are labels, not identities. A name-based write first resolves
against the owner's complete projected field-slot shape. A single matching slot
wins whether it is materialized or virtual. When several slots match, the
owner's applied tag chains provide precedence by definition identity: resolution
checks direct tags first, then each inheritance depth in specific-first order.
The first layer with exactly one unique matching `fieldDefId` wins only when the
owner has exactly one matching slot backed by that definition. A materialized
winner addresses its entry; a virtual winner addresses the definition and
materializes through the slot write boundary. Multiple stored matches preserve
the duplicate-entry error and return all matching entry ids. If ambiguity
includes a virtual slot, the duplicate-definition error returns the competing
definition ids because no entry id exists for that slot yet.

The same tag-chain walk resolves schema-level ambiguity when no direct owner
entry matches and Schema contains several active definitions with that label.
The first layer with exactly one unique matching `fieldDefId` wins. No reachable
candidate or more than one candidate at that layer preserves the
duplicate-definition error. Resolution therefore never depends on owner-child,
tag, or Schema traversal order.

Outliner field rows, `value_is_default` comparison, View Toolbar choices, and
Table columns remain keyed by field-entry or definition id. Two independently
defined fields may therefore render as separate rows or columns with identical
labels, matching Tana; no originating-tag suffix is added.

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

## Table View

Table is another projection of a node's direct children, not a copied dataset.
Each direct content or reference child becomes one record after the shared
filter and ordered-sort projection. The owner's own field-entry rows remain
above the grid because they describe the owner rather than its records. A
filtered-out disclosure remains recoverable inside the grid and reveals rows in
the same columns. Search nodes can use the same renderer, but never receive a
writable trailing draft because their result references are derived.

On a real transition from any non-Table mode (`list`, `cards`, or `calendar`) to
Table, the same `set_view_mode` transaction inspects the current direct records,
resolves every reference chain to its final target, and adds visible columns for
active custom fields used by those targets but never configured in this view. A
Search owner refreshes its materialized result references first, within the same
transaction, using the main process's live text index, so first entry cannot
observe an empty stale result set or compatibility-scored results. If the saved
query is no longer evaluable, this pre-refresh keeps the previous materialized
results and the mode change still lands; explicit query writes and manual
refreshes continue to report the evaluation error. Existing display-field nodes
are authoritative: their order and settings stay intact, hidden columns remain
hidden, and only missing fields are appended in Schema order. System fields and
unused custom fields are never defaulted. Repeating Table mode does nothing;
fields first used while Table remains active are considered on the next
transition out of and back into Table.

The first column is the synthetic, non-removable **Title** column. It contains
the ordinary bullet/disclosure, checkbox, rich title editor, reference behavior,
and row context menu. Each visible `displayField` contributes one additional
column. Columns use finite `displayOrder` first, then stored child order and id as
deterministic fallbacks. When Table initialization encounters historical display
fields without a finite order, it assigns only those fields sequential orders
after the maximum existing finite order and appends new defaults after them;
existing finite orders never change. `displayLabel` overrides the live field label,
`displayWidth` is clamped to the supported range, and `displayVisible` controls
visibility. Header menus rename a column for this view, move it left or right,
or hide it. The persisted remove command remains protocol-compatible, but the
Table header exposes Hide as its only removal action. The resize separator
supports pointer drag, keyboard increments, and double-click reset. A resize
preview exists only while dragging
or awaiting that commit; once the command settles it yields to the latest
projected width, so undo, collaboration, and external updates cannot be masked by
stale renderer state. The default geometry follows Tana's scan-first composition:
Title is `minmax(260px, 1fr)`, authored and system fields default to 180px and
clamp no narrower than 112px, and the trailing 104px Add field track remains
stable. Header and rows fill the available content width whenever those minimums
fit; Title absorbs the remainder. Narrower panes retain the minimum tracks and
use the Table-local horizontal scroller instead of wrapping columns into an
unreadable strip.

An authored column's field-kind icon opens that field definition in the current
pane, providing direct access to its configuration surface. Hover visibly
strengthens only the icon without adding a background or outline. A derived
system field has no definition node, so its kind icon remains non-interactive and
does not expose that hover state. Column labels and menus keep their existing
view-local behavior.

**Add field** lists fields that are not currently visible in three searchable
groups: custom fields used by a current record, other active custom fields, then
supported system fields. Both custom groups follow Schema order; system fields
keep their established order. A hidden display field therefore remains
available; selecting it restores that same column with its width, order,
view-local label, and row values intact. Table's Edit displayed fields action
opens this same Add field surface rather than restoring a second toolbar row. The
Outline Display popover provides the equivalent checkbox toggle and presents
custom Fields before System fields. Selecting a definition with no display field
creates only a display-field node. The new-field path accepts a localized field
type and atomically creates the field definition plus its display-field node.
None of these paths bulk-create empty values on records.

An existing authored value renders through the ordinary node surface, including
the standard bullet, single-click editing, disclosure, children, context menu,
and established type-aware field behavior. There is no separate read-only cell
preview mode. Table preserves the ordinary leading geometry, with distinct
chevron and bullet slots in both Title and authored-value cells.
An absent value is a quiet empty cell and remains absent on hover, selection,
focus, and arrow navigation. Enter or double-click focuses the projected slot's
trailing editor without writing an entry. A printable key travels on the pending
input rail to that same editor; the accepted draft then materializes exactly one
entry together with its first value, so the initiating character is not lost and
an abandoned empty edit leaves no stored copy.
Enter or a printable key on an inactive stored or trailing-draft Title cell opens
its ordinary rich-text editor directly and seeds printable input there. Read-only
system fields remain derived; Done keeps its direct toggle behavior. The trailing
Title draft creates an ordinary direct child, and Enter at the end of the final
stored Title creates and focuses the next record.

Reference-backed records use one final target for field text, sort, filter,
grouping, choice discovery, system-field projection, and edit attachment. This
includes saved-search results whose target is another reference. A missing or
cyclic chain uses the reference node's own title for Name, renders target-backed
authored and system fields empty, does not accept a field write, and never blocks
the rest of the Table.

Expanding a table record shows its ordinary child outline without active authored
field-entry rows. In Table, active fields are columns whether their columns are
visible, hidden, or not yet configured. Visible-column values remain editable
through their cells and their ordinary value nodes remain in cell selection
order, but active field-entry wrappers and values for hidden or undisplayed
fields are absent from the expanded tree, disclosure child count, keyboard
navigation, selectable-row model, and agent-visible outline. Hidden active data
stays discoverable and recoverable through Add field. A field entry whose
definition is missing or in Trash is the recovery exception: it renders as an
ordinary expanded field row and participates in all of those structural models,
so its stored values never become unreachable.

Each table is an independently named ARIA `grid` with `row`, `columnheader`, and
`gridcell` descendants and one roving tab stop. An expanded nested Outline inside
a record owns a separately named, multi-selectable `tree`, so its `treeitem` rows
always have a valid tree container. Arrow keys move one cell, Home and End move
to row edges, and Cmd/Ctrl+Home or Cmd/Ctrl+End move to grid edges.
Those navigation keys operate only while the cell wrapper owns focus. Tab and
Shift+Tab traverse wrappers, and native Tab leaves at the outer boundary. Once
an authored node editor owns focus, Enter, Tab, Shift+Tab, drag, and other node
commands retain ordinary outliner semantics rather than being captured by the
grid. The neutral cell fill likewise belongs only to wrapper focus; descendant
editor focus leaves the wrapper transparent, including while its node subtree is
expanded. Escape closes editor-local state and, after the editor releases focus,
returns focus to the same logical cell. IME composition, modifier shortcuts,
and dead keys are not consumed as printable table input.

Column menus move focus to the first item on keyboard or pointer open. Arrow keys,
Home, and End navigate menu items; Tab or Escape closes and restores the column
trigger. Rename switches the same surface to dialog focus behavior, focuses its
input, and traps Tab within the dialog. Enter, blur, outside-pointer dismissal,
or a second trigger click commits once; only Escape cancels without a write. The
trigger is excluded from outside-pointer capture so its own click closes rather
than dismissing and immediately reopening the menu.

Selecting a record's Title node keeps the ordinary node selection identity and
commands, but Table projects its visual selection and `aria-selected` state onto
the complete multi-select grid row. Title does not retain a second node-local fill
inside that surface. An authored value node is still an ordinary nested node:
selecting it remains local to that value and does not select the containing record
row.

The grid uses the panel as its vertical scroll owner and a local native
horizontal scroll area for overflowing columns. Header and mounted rows share
one responsive full-width column template. Header labels and Add field use
`--font-ui-sm`; row titles and values keep `--font-content` and
`--line-content`, all over the shared `--font-family-sans`. Only data columns
receive quiet horizontal separators; Add field remains outside those lines,
while a vertical hierarchy guide aligns with the owning row bullet. More than 60 logical rows use a bounded measured window
with overscan; focused rows and the trailing draft stay mountable, and height
corrections above the viewport compensate `scrollTop` before paint. Expanded
children may own independent nested Outline or Table scopes with their own
columns, filters, sorting, view actions, accessible name, and horizontal scroll.
Visible saved searches have one refresh owner: Table owns Table-mode search
scopes, while the surrounding flat Outline renderer excludes those scopes and
continues to own visible Outline-mode searches.

## Search Nodes

Search nodes do not repeat query semantics as read-only chips beneath a title
that already identifies the query. The title query action is the single entry
point for inspecting and editing those semantics. While its editor is open, the
root result-view controls temporarily yield to it; closing the editor restores
the same compact band without changing view configuration. The editor provides
the materialized result count and an explicit refresh action as editing context;
the closed result view needs neither because visible searches refresh
automatically through their single mode-specific owner.

The editor projects stored condition nodes into outline text through the shared
query complexity limits. When that bounded projection omits any stored rule or
operand, the editor shows an explicit truncation warning, keeps the textarea
read-only, and disables Reset and Save. Users may still inspect the visible
projection, refresh materialized results, or close the editor, but a partial
projection is never writable over the complete query.

Outline and Table therefore use one shared compact result-view mechanism rather
than stacking a query summary and a full toolbar. Outline aligns name search,
Table, Display, Group, Sort, and Filter with the result content axis. Table aligns
name search, Outline, Sort, and Filter with the Title label axis above the pure
field header; Add field owns visible columns. The compact band has no frame,
fill, summary chips, result count, manual refresh, or decorative separator. At
narrow pane widths its controls keep the shared fixed control size and wrap as
complete units instead of shrinking or clipping.
Each compact-control tooltip anchors to the control that currently owns hover or
keyboard focus, including after the controls wrap. Moving directly between
controls remeasures the new label's intrinsic width, so a short tooltip never
inherits the width or location of the previous control.

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

Linked rows and counts update immediately from the incrementally maintained
reference summary. An expanded section refreshes unlinked mentions after a
150 ms debounce, scanning the corpus in fixed cooperative batches so a refresh
cannot monopolize the renderer. Each scan is generation-checked; a newer edit,
target switch, collapse, or unmount cancels pending work, and a stale result can
never replace the current target's rows.

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
| `Tab` / `Shift+Tab` | Batch indent/outdent selected root rows and preserve selection mode, selected rows, and selection anchor. Tab applies only to contiguous selected runs whose first row has an unselected previous sibling; a selected run at the start of its parent is a no-op, so later selected rows never become children of earlier selected rows. Direct field values may Tab under a previous direct value. Shift+Tab never moves rows above the current panel root or a direct value above its owning field entry; those boundary rows are a no-op. Ordinary descendants below a value may Shift+Tab into the field entry, promoting them to direct values. Shift+Tab collapses any previous parent emptied by the move so the moved rows stay adjacent to their old parent. Visible rows that change position during the structural move use a short transform-only movement animation; `prefers-reduced-motion: reduce` disables it. |
| `Backspace` / `Delete` | Remove selected root rows by selectable-row policy: ordinary rows trash normally, stored field value rows route through field-slot value removal, and synthetic `sysref:*` rows no-op. A mixed selection is encoded as one ChangeSet so its accepted Projection update is one contiguous revision. A single ref-clicked ordinary reference deletes the reference row itself; a ref-clicked reference-valued field child still routes through field-value removal. |

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

Canonical plain-text references wrap exactly one URI in `[[...]]`.
Ordinary Nodes use `node://UUID` (mapping to internal `node:UUID`), and the only
public system authorities are `workspace`, `daily-notes`, `library`, `schema`,
and `searches`. Absolute local paths use standard percent-encoded `file:` URLs;
an empty authority is required and a trailing slash carries directory intent.
Credentials, query, fragments, relative/remote files, malformed encoding,
unknown schemes, and every private or typed structural Node ID remain literal.
The URI never stores a label. Node atoms resolve the current document title at
render time, file atoms use the decoded basename, and stored display metadata is
only an unavailable fallback. Renaming changes presentation without changing
the structured `ReferenceTarget`, copied URI, or equality. URI syntax grants no
authority: Core still preflights Node existence/Trash state, and file actions
still apply their working-set and Host security checks. A backslash-escaped
marker remains literal at boundaries that support semantic escaping.
Thread Markdown maps normalized AST text back through each text node's source
position before classifying escapes. Numeric or named entities may therefore
form an active reference without stealing the source occurrence of a later,
byte-identical escaped marker. Rendering, referenced-Node extraction, and
reasoning-summary target detection use that same mapping; a leading
entity-encoded reference remains available in the expanded reasoning body.

| Interaction | Expected behavior |
| --- | --- |
| Paste multi-line plain text | One row per line. In the agent composer (single-paragraph schema) the lines are kept as `hardBreak`s within the row. |
| `<br>` inside an HTML block | Split the block's inline run at each `<br>` into sibling rows, not a single space-joined row. |
| List markers `- * +`, `1.` / `1)`, bullets `• ◦ ▪ ‣ · ●` | Stripped from the start of a line; nesting from indentation is preserved. |
| Fenced ```` ``` ```` / `~~~` block | Becomes a code-block row with detected language. |
| Inline Markdown (`**bold**`, `*italic*`, `~~strike~~`, `[label](url)`) | Converted to the corresponding marks. Canonical backslash escapes in link labels decode to visible punctuation on paste and serialization round-trip. |
| Single-line bare URL with a text selection | Wraps the selection as a link. |
| Bare `http://`, `https://`, or `www.` URL in ordinary pasted text | Becomes a link mark on the URL only. `www.` hrefs normalize to `https://`; sentence punctuation and unmatched closing delimiters stay outside the link. Existing HTML anchors and inline code remain authoritative protected ranges. |
| GFM task line `- [ ]` / `- [x]` | Becomes a checkbox row (`completedAt` sentinel: `undefined` none, `0` unchecked, timestamp checked) when the marker is alone or followed by whitespace; `[x]title` stays literal text. Merging a task line into an existing **non-empty** row never flips it to checked — only a genuinely empty target row adopts the pasted checkbox state. |
| `#tag` on a Markdown/plain line | Harvested and applied; unknown tags are auto-created (find-or-create), reusing same-named defs. Guard: start/whitespace before the shared tag token. Bare tags accept Unicode letters/numbers, `_`, and `-`; `[[#tag]]` / `#[[tag]]` are accepted; bracket names accept raw backslashes, and serializers escape `]`, backslash, and newline-style characters as `\]`, `\\`, `\n`, `\r`, and `\t`; bare CSS hex colors such as `#fff` and `#112233` are left literal. |
| `name:: value` on a Markdown/plain line | Harvested as a field; unknown fields auto-created as `plain`, existing `options` fields smart-select the option. Guard: a double colon **followed by whitespace** (`name:: value`), so `std::cout`, `http://…`, `foo::bar` never match. Field values stop before the next field or shared tag token; bare CSS hex colors do not terminate the field. |
| `#tag` / `name::` inside a link label, URL, `` `code` `` span, reference marker, or backslash-escaped token | Left literal. Protected ranges are excluded before metadata extraction, and removing surrounding metadata remaps marks and inline-reference offsets. |
| Metadata on the HTML paste path | Harvested through the same scanner as plain text after DOM structure and marks are converted. Existing `<a>` and `<code>` ranges stay literal; metadata outside those ranges is applied to the row. |
| `[[node://UUID]]` in plain-text or HTML paste | Materialized as an inline node reference, then preflighted by Core before any row or metadata write. Every referenced node must exist outside Trash; one missing or trashed target rejects the entire paste atomically, including first-row merge, descendants, trailing siblings, and yielding bulk paste. The renderer applies its local draft only after that command succeeds, so rejection leaves the edited row unchanged. Canonical `[[file:///absolute/path]]` references and chat-source references keep their own validation rules. |
| Single-line or metadata-only semantic paste | Uses structured paste whenever parsing adds a link, tag, field, checkbox, reference, node type, or other semantic state. A metadata-only row can update the target row or materialize at a pristine trailing position; only a truly literal unmarked line delegates to native paste. |

While a structured paste command is pending, its target editor is temporarily
non-editable and rejects additional paste, keyboard, `beforeinput`, and
document-changing transactions. It applies the captured first-row content only
after Core succeeds, then restores editability; rejection leaves the local
content unchanged and also restores editability. This prevents input typed
during command latency from being overwritten by the successful paste snapshot.
Handled pending-paste key events remain handled at the workspace boundary, so
`Undo` and `Redo` cannot escape to global Core commands while the editor is
frozen.

## Leading Control Matrix

| Interaction | Expected behavior |
| --- | --- |
| Hover any row | Show chevron affordance. |
| Click chevron on row with children | Toggle expanded state. |
| Click chevron on leaf row | Expand an empty child scope and focus its trailing input. |
| Click chevron or indent guide while scrolled | Preserve the clicked disclosure trigger's viewport top across the layout commit. Removing or adding descendant flat rows must not pull the clicked row/header up or down. The correction is instantaneous scroll compensation, never smooth scrolling. |
| Hover indent guide line | Thicken only the guide line, without expanding into child chevron hit targets. |
| Expanded scope guide line | Render as a visible neutral guide for expanded rows, including leaf rows expanded to show trailing input. Its resting 1 px stroke uses the neutral tertiary-ink tier rather than the separator tier, so half-pixel antialiasing cannot erase it beside tall image and media previews in either theme; hover deepens the same neutral ink without changing layout. Every marker has the same transparent marker slot; the visible glyph is only centered content inside that slot. The guide uses the actual marker slot DOM as its geometry source, not the visible glyph or an estimated flat-row layout: the flat renderer measures `.row-bullet-button` for the parent and last mounted descendant relative to `.outliner-flat-guides`, then feeds measured `left` / `top` / `height` into the guide. The band starts just below the parent marker slot so marker clicks remain owned by the marker itself. File icons, bullets, and other marker glyphs share one structural marker slot regardless of glyph size. The line ends on the last visible descendant marker centerline, so tall previews, wrapped content, and glyph size never stretch the structural line. |
| Click indent guide line | Toggle expanded state for the row's direct children when present. |
| Click bullet | Open/drill into the node. |
| Drag bullet | Move the row, expanding inside-drop targets. If the dragged row is part of a block selection, move the selected structural roots together in visible order as one undoable document operation; dropping on a trailing draft row appends to that scope. Only the nearest hovered row owns the drop guide line, including nested rows. Invalid or completed drags clear any guide line and keep block selection instead of focusing a single row. |
| Applied tag display | Render tags inline after node text using nodex-style badges; do not render a second-line chip strip. |
| Right-click an applied tag → **Apply template to tagged nodes** | Preview the exact number of missing freeform seed children and affected active, editable nodes without writing. Targets include direct applications and applications of tags whose extends chain contains this tag; nodes in Trash and locked nodes are excluded. Show positive counts in the shared confirmation dialog, and only confirmation runs the single undoable backfill command. When the addition count is zero, restore focus to the originating tag badge without opening a dialog or dispatching apply. Existing `templateId` clones are not duplicated. |
| Applied tag bullet color | Color the node bullet from applied tag colors, using pie segments for multiple tags. |

## Trigger Matrix

- `#` opens tag selection.
- `@` splits between tree reference and inline reference based on trigger
  position and cycle constraints.
- `/` opens slash commands only when the node is otherwise empty.
- `/attachment` and `/image` are task-oriented picker commands. Both ingest the
  selected file as a managed asset and create ordinary Source-backed Nodes at the
  row's current position; the command name does not select a Node variant.
- `>` creates a field row only when the content is exactly the bare trigger.
- Trigger menus must route `ArrowUp`, `ArrowDown`, `Enter`, and `Escape` before
  normal outliner navigation.

## URI And Preview Matrix

Binary files are not embedded in the document. The schema's locked built-in URI
definition has stable ID `field:source` and visible name `URI`; its lock does not
extend to entries or values. New Nodes have no URI entry. Producers create a
normal unlocked entry lazily, with ordinary editable RichText value Nodes that
carry exact locator text. Users can edit, move, copy, process, or delete a value,
and can delete the complete entry. The final value's removal deletes the empty
entry. A user-defined field named `Source` is unrelated because preview meaning
follows definition identity, not text labels. Managed file producers admit bytes
first, then create the ordinary Node and canonical asset URI in one document
transaction so undo/redo, projection, and asset reachability stay coherent.

| Interaction | Expected behavior |
| --- | --- |
| Drop files on an outliner row | Prevent browser navigation, snapshot every regular `File` during the event, and show the normal neutral insertion guide. The top/middle/bottom thirds preserve before/inside/after tree placement. Each successful admission creates an ordinary Node plus one managed Source in original order; an empty target row retains its identity for the first success, later files become siblings, and a failed file creates no dangling Node. |
| Paste files into an outliner row | A real clipboard `File` payload wins over companion display text. Pure image, mixed, and non-image clips all use the managed Source producer. On an empty row the first success retains row identity; on a non-empty row resources become ordered siblings after it. Successful siblings survive an independent failure. |
| `/attachment` or `/image` on an empty row | Remove the trigger, open the native picker, and create ordinary managed Source-backed Nodes at that position. The task-oriented command name does not choose a Node type. Cancel leaves the row empty. |
| Source-backed row | Render exactly like any ordinary content Node: editable RichText, normal neutral bullet, inline tags, references, description, selection, movement, Enter/Tab/Backspace, paste, and `#` behavior. No file-type bullet, read-only filename editor, inline image replacement, or hidden keyboard anchor exists. Its visible order matches Tana: the selected Source preview appears above the owner title/content, followed by the ordinary URI field. The preview aligns with the owner content column. While visible, the same ordinary marker sits in the rail beside the preview's upper edge, the title uses an empty leading slot, and the expanded guide starts below that marker and continues through the composition to its final visible descendant. Hiding the preview returns the marker to the title row. The chevron controls only ordinary children; the bullet opens the normal Node page. Neither control represents preview visibility. |
| URI management | The URI field uses the same field row, value editor, trailing input, tree commands, copy/move behavior, and entry deletion as other fields. Its exact editable values remain the authoritative management surface. URI values omit the redundant value-row marker because their in-value preview affordance owns show/hide/switch; the owner Node's ordinary bullet and chevron remain unchanged. At narrow pane widths, the Source field stacks its name above the value while the owner preview compacts mature controls without clipping. The Node-page compact preview toolbar exposes the selected value's Source actions: Link File, Replace with File, Copy URI, retry, clear, remove, and exact-file authorization/revocation where applicable. Link File and Replace with File are explicit atomic Host workflows: the picker grant settles before the field mutation, and failed mutation releases a newly orphaned grant. Selection uses stable value identity, survives reorder, never skips an explicitly selected unavailable value, and falls back to the first surviving value only when its identity disappears. Removing the final value removes the URI entry and leaves the owner unchanged; adding the first later value selects and shows it. |
| Edited or broken URI | A text edit commits exactly what the user entered and immediately derives presentation from that value. A syntactically valid edited YouTube or web URL loads the new address. Invalid, denied, unsupported, missing, or temporarily unavailable text stays durable and editable and shows its local reason; preview failure never rolls back or locks the field. |
| URI preview state | On the drilled root Node page, the selected URI preview and compact toolbar render before editable title/content. In an ordinary Outline, the same selected preview renders without a duplicate toolbar above the owner title/content, with the ordinary URI field below it; this matches Tana's preview → title/content → URI order. It aligns with the owner content column, is not a child row, and does not alter the ordinary marker. The Node-page toolbar labels a single value directly and gives multiple values an ordered compact switcher. Hide preview changes only renderer-local visibility. In the Outline, the selected URI value exposes **Hide preview** while shown and **Show preview** while hidden; every other URI value exposes **Preview this Source** on its ordinary field row. Showing or switching atomically selects the requested value and restores its preview without moving focus into interactive media. Selected value, preview visibility, document reader state, and child disclosure are independent; selection and visibility persist in renderer-local view state. Adding another value preserves them, editing a visible selection reloads it in place, editing another value does not select it, and editing while hidden remains hidden. Stale resolution from a previous selection cannot replace the current body. Invalid, denied, unavailable, or unsupported values keep their exact field text and show their own reason and recovery. Table and calendar projections render ordered URI values without rich previews. |
| Bare URL paste | Pasting exactly one bare `http:`, `https:`, or normalizable `www.` URL with no selection, file payload, HTML anchor, extra prose, or additional line into an empty ordinary Node atomically writes the normalized URL as Node content and appends the same Source while retaining that Node's identity. The first Source is selected and shown; an additional Source preserves selection and visibility. A non-empty Node, selected range, prose, multi-line input, HTML anchor, code, or protected RichText range keeps ordinary inline-link behavior and adds no URI value. Typing a URL never creates a Source. |
| Type-specific preview presentation | `FilePreviewShell` resolves one presentation from the same ordered renderer registry that matches MIME, extension, Source kind, and preview target; it never derives chrome from Node type. PDF, EPUB, HTML, Markdown, code, plain text, delimited tables, and directories retain document summary/full state, per-source resized height, insets, scroll geometry, page jumps and restored positions, EPUB lazy mounting/outlines/translation, and scoped cleanup. Images render directly at their intrinsic aspect ratio with no document frame, Expand/Collapse, or resize handle; ordinary inline previews are bounded to 720 px wide and 520 px / 60 vh high while dedicated readers may use the larger viewport, and authorized file operations remain in a compact ellipsis overlay. Audio and video use their player surface. Ordinary URLs use their direct web surface; recognized YouTube watch, short, live, and short-link URLs use a separate 16:9 player capped at 760 px wide. Its embed URL explicitly disables autoplay, does not propagate source autoplay parameters, and starts only after user interaction. Unsupported binaries use bounded metadata. |
| Preview actions | Document-like Sources use the stable bottom-center `Expand`/`Collapse` plus separate `⋯` actions. Authorized managed Sources expose **Open in split pane**, **Open with default app**, **Reveal in Finder**, and **Copy file**; unsupported formats keep **Open** plus the authorized secondary actions. The dedicated reader is bound to the ordinary owner/source identity but omits Node-page ancestry, title hero, child outline, References, inner Expand/Collapse, and resize handle. Open/Reveal/Copy use Runtime-verified private materialization and never expose a ContentStore path. |
| Media preview controls | Audio and video remain a single-layer Media Chrome surface with playback, seek, volume, mute, shortcuts, fullscreen, and same-layer authorized actions. They omit document Expand/Collapse, resize, and outer card chrome. Fixed control geometry and transparent range hover keep the bar stable. |
| Missing asset metadata | The selected preview shows unavailable with retry where authorized. Authored Node content and ordinary row behavior remain intact, and broken system actions are absent. |
| Non-node source preview | A source with no node (agent payload, loose inline local-file ref, url) opens the same `file-preview` surface in its loose state: source/path breadcrumb, read-only filename/source title, and the shared preview, but no children outline. URL sources are previewable but not file-like: the breadcrumb/header shows the reported webpage favicon and title, the body starts directly with the sandboxed webview, and the single-layer surface has no document frame, duplicate heading, Expand/Collapse, resize handle, or bottom action bar. Ordinary webpages fill that surface; recognized YouTube URLs load the click-to-play embed in the bounded 16:9 player while retaining the same sandbox, session, external-navigation policy, and caption translation bridge. A neutral `Languages` icon before the header `⋯` opens the task-first translation popover. Its stable glyph is muted while off, becomes the fixed-size spinner during initial work, and gains a subtle circular neutral fill after translated content is visible; it never composites a completion badge. Target language follows the UI locale until explicitly changed, model defaults to dynamic `Follow Agent`, and explicit target/model plus automatic translation are remembered. Automatic translation remains opt-in and activates for a valid differing top-level language or detected caption language. `Option+A` on macOS and `Alt+A` elsewhere toggles only the active URL preview. The complete viewport immediately receives cached output or fixed-size loading controls. One shared pool uses up to six independent requests: visible batches carry at most eight blocks / roughly 2,000 characters, prefetch batches carry at most sixteen / 4,000, and visible work can use the whole pool or preempt obsolete distant work. A latency- and velocity-derived window stays between roughly three and eight viewports; isolated-world work revisions wake the host immediately while a one-second timeout provides recovery. Blocks outside the bounded window remain unsent, completed blocks stay cached, and same-target-language blocks are skipped. Transient transport, rate-limit, and server failures retry twice while loading remains visible; exhausted failures become local accessible retries without pausing unrelated work. Prerecorded standard `TextTrack` video (including Frontend Masters / Video.js) and YouTube timed text share the same control and pool: original captions remain visible, translated cues preserve native cue layout and arrive as the second line, the first caption batch is at most six cues with a 1,500-character soft budget (one cue may use the 4,000-character hard limit), later batches are at most sixteen cues / 4,000 characters, and a bounded playback window replaces whole-transcript translation. Track revisions discard stale caption completion/errors without discarding visible page completion. Seeking preempts stale prefetch; backward seeking reuses the page-local cache. Captionless, same-target, inaccessible, and live-caption media do not issue caption requests; YouTube ads hide and pause Tenon's captions, confirmed captionless videos are negative-cached, and fetch failures back off per video/track. Translation/status insertion and hide/show preserve the visible source anchor. Navigation, reload, non-hash in-page video or caption-track changes, pane close, and target/model changes cancel stale page-local work; URL previews retain **Open in browser** in the header menu. Other loose sources retain the shared preview and system-action behavior described by their renderer. |
| EPUB bilingual translation | A reflowable EPUB selected Source and dedicated reader place the shared `Languages` control in the stable header; `pre-paginated` books do not expose it. Managed and trusted-local packages use the validated internal stream with a 128 MiB compressed-package cap; streamless sources retain the bounded fallback. Target language, model, Translate / Show original, completion state, and `Option+A` / `Alt+A` match URL translation, while **Translate automatically** is a separate remembered EPUB opt-in that defaults off. Loaded direct leaf-readable blocks use complete-viewport loading, bounded visible/prefetch batches, the six-request shared pool, predictive three-to-eight-viewport mounting, local retry, visible-work preemption, and book-session cache. Source/configuration changes cancel stale work, and translation changes preserve the reading anchor. |
| Agent transcript file preview | Live agent transcript file chips are local working-file pointers, including user attachment chips, user inline file references, assistant prose references, and assistant-produced file result chips. A click opens a file-only reader in the center workspace area, reusing the active/available workspace pane rather than adding a split pane or previewing in the agent dock. The reader uses the same file preview content shell as workspace file previews, starts in full reader mode, has no Expand/Collapse or resize handle, and shows only the compact reader header with filename and `⋯` actions. The `⋯` menu keeps **Open with default app**, **Reveal in Finder**, and **Add to outline** for ingestible files. |
| Add a non-node source to the outline | The loose preview's `⋯` menu offers "add to outline" for ingestible local files and Agent payloads, not remote URLs. It copies bytes into the asset store, creates an ordinary Node under Today with one managed Source, and binds the same mounted preview to that owner in place. The result uses ordinary Node content, ancestry, children, Source management, and authorized preview actions. |

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
| Toggle checkbox/done on a reference row | Apply the done state to the target node, because the reference displays the target. | `outlinerParity.test.ts`, `outliner-selection-keyboard.spec.ts` |
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
`RadioOptionGroup`, and any horizontal tablist (which maps Left/Right onto it).
Escape ownership moves to this hook, so
`useDismissibleOverlay` is invoked pointer-only (`{ escape: false }`) where the
two compose. Adopted by: `NodeContextMenu` (menu in `main` mode, dialog in
tag/move submodes), `SettingsRowMenu`, Thread row actions, view-toolbar section
popovers, and the date-value picker. Compact `⋯` row menus share
`primitives/AnchoredActionMenu`, which bundles anchored positioning, the hook,
and trigger-aware outside-pointer dismissal.
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
