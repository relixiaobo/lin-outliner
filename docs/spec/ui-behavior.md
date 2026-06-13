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
  `Cmd+[` / `Cmd+]` even while text is focused, or via `Alt/Option+ArrowLeft` /
  `Alt/Option+ArrowRight` outside editable text controls (there are no top-bar
  back/forward buttons; see [`design-system.md`](./design-system.md) → Shell).
  They do not undo or redo document operations. In editable text, Option+Arrow
  remains the platform word-navigation shortcut.
- Entering a node page places edit focus at the start of the first visible body
  row. If the page has no body rows, focus lands on that page's trailing draft so
  the user can immediately type the first row. Navigation never auto-focuses the
  end-of-page trailing draft on non-empty pages. Search pages (for example
  Recents) are result views, so entering them does not place edit focus on a
  result row.
- Rows use a compact bullet/chevron leading control, restrained hover/focus
  states, and no right inspector.
- Page titles are editable rich text. This includes the workspace root title
  (so people can name their workspace), which stays structurally fixed — it can
  be renamed but not moved, deleted, or reparented. The functional system
  sections (Daily notes, Library, Schema, Saved searches, Trash, Settings) and
  other locked pages (e.g. day pages) keep read-only titles.
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
| `Enter` at text end on collapsed/leaf row | Create next sibling and focus it. |
| `Enter` in the middle | Split the row, preserving rich text before/after the cursor. |
| `Enter` on expanded row with children | Create the first child and focus it. |
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

## Field Row Matrix

| Interaction | Expected behavior |
| --- | --- |
| Type in field name | Show a reuse popover of matching existing fields ("Fields") and built-in system fields ("System fields"). Nothing is highlighted by default. Fields already present on the same owner node are excluded — a node may not carry the same field twice. |
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
  references, and reference field values that point at the owner) as read-only
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

A **`reference` field type** holds references to other nodes (vs an `options`
field, whose values come from a per-field option pool). Its value draft is a
node-search box: focusing it opens `TrailingReferencePopover` over the whole
document (the same in-memory search that powers an `@` reference), typing filters,
and picking a node appends a `reference` value via `add_field_reference`, then
advances to the next trailing draft. Each value renders as a reference row
(double-click edits the target; expandable). Picks reference **existing** nodes
only — there is no create-from-query affordance, and the typed text is never
persisted as a free-text value (it is purely the search query). This is the
editable peer of the read-only References / Owner / Day system fields above: same
reference-row presentation, but the value set is user-managed rather than
computed.

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
Reference field-value sources use the reference marker; ordinary linked and
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
- reference field values, attributed to the owning content node and grouped under
  the field name.

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
| `Backspace` / `Delete` | Remove selected root rows by selectable-row policy: ordinary rows trash normally, stored field value rows route through `remove_field_value`, and synthetic `sysref:*` rows no-op. A single ref-clicked ordinary reference deletes the reference row itself; a ref-clicked reference field value still routes through field-value removal. |

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
| Hover indent guide line | Thicken only the guide line, without expanding into child chevron hit targets. |
| Expanded scope guide line | Render for expanded rows, including leaf rows expanded to show trailing input. |
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
| Drop files on an editable content row | Prevent the browser's default navigation, ingest every regular `File`, convert images into image rows, and insert all other assets as attachment siblings after the target row in source order. |
| `/attachment` on an empty row | Delete the slash trigger, open the native attachment picker, ingest selected files, and place image/attachment rows at that row's position. Cancel leaves the row empty. |
| Attachment row render | Show a compact block row with a file-kind glyph or PDF thumbnail, filename, size, type label, and derived page count/duration when available. Audio and video attachments expose native media controls below the metadata. |
| Attachment actions | Open uses the OS default app after the main process revalidates the asset path and local-file policy. Reveal shows the stored asset copy. Copy puts the stored asset path on the clipboard. |
| Missing asset metadata | Render a non-editable unavailable placeholder; the row remains a block node and does not expose broken system actions. |

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
| Type in a `reference` field value draft | Open the node-search popover over the whole document; ArrowUp/Down/Enter pick a candidate, Escape closes. Picking appends a `reference` value (`add_field_reference`) and advances to the next draft. A non-matching query never materializes a free-text value. | `trailingReferencePopover.test.tsx`, `outliner-triggers.spec.ts` |
| `LINKS_TO` query rule | Match linked references only: tree references, inline node references, and reference field values whose target is the query target. Do not match unlinked textual mentions. | `searchEngine` |
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
