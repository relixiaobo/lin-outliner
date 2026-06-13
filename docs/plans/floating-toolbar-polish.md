# Floating Toolbar Polish

Two small additions to `src/renderer/ui/editor/FloatingEditorToolbar.tsx`
that nodex's `FloatingToolbar.tsx` carries today.

Independent of asset work.

## Goal

1. **Heading-mark toggle** — sixth button in the toolbar that toggles the
   existing `headingMark` text mark over the current selection. The mark
   type already exists in `TextMarkKind` (`src/core/types.ts:110`); the
   PM schema already knows it. Only the toolbar UI is missing.
2. **`#` selection-extract** — small button that, given a non-empty text
   selection, creates a new tagged node in the user's chosen "extracts"
   destination with the selected text as content and a tag applied. nodex
   wires this to a Library extraction; lin's destination policy needs
   deciding (see open questions).

## Non-goals

- A full hover toolbar redesign.
- Color picker, font-size picker, more marks. v1 keeps the toolbar narrow.
- Persistent toolbar (sticky / pinned). Stay floating.

## Design

### Heading toggle

Add `'headingMark'` to the `ToolbarMark` union and the `BUTTONS` array in
`FloatingEditorToolbar.tsx`. The mark already round-trips through
`apply_node_text_patch` with `add_mark / remove_mark` patch ops, so no core
change required.

Icon: reuse the `Heading` icon from the existing icon set (already imported
by `AgentMarkdown.tsx`).

### `#` selection-extract

UX:

1. User selects text in a row's rich text editor.
2. Floating toolbar appears with a `#` button.
3. Clicking opens an inline tag picker (existing `TagSelector.tsx`).
4. On tag pick: create a new node containing the selected text, tagged
   with the chosen tag, in the destination. Replace the original selection
   with an inline reference to the new node.

The "replace selection with inline reference" path already exists for the
`@` trigger (`replace_node_with_inline_reference` command). The new
extract flow reuses it but injects a tag application step in the middle.

Wire-up: floating toolbar callback `onExtractWithTag(tagId)` → renderer
runs `extract_selection_as_tagged_node({ rowId, from, to, tagId })`. This
is a new compound command; consider whether it can be a renderer-side
sequence of existing commands wrapped in a single Loro transaction via
the scoped UndoManager so undo treats it as one step.

### Destination policy

Two options, decide before implementing:

- **A. Per-tag destination** — tagDef has a `defaultExtractParentId` field;
  the extract creates the new node under that parent. Allows different
  tags to file extracts in different places.
- **B. Global "extracts" bucket** — one designated workspace bucket (like
  the deleted `STASH` system node from nodex) holds all extracts. Simpler;
  less flexible.

Recommendation: **A** — fits lin's "no special buckets" stance better than
B and matches the PARA-removal direction (commit `ab971d7`).

## Open questions

- Should the `#` button be available with no text selection? Probably not —
  if there's no selection, the regular `#` trigger in trailing input
  already handles "add a tag".
- Heading levels (H1/H2/H3) — `headingMark` is currently a single mark
  with no level attribute. Adding levels would require schema work that's
  out of scope here.

## Implementation sketch

1. Add heading button to `FloatingEditorToolbar.tsx`. Wire to existing
   `add_mark / remove_mark` flow.
2. Add `#` button conditional on `props.activeMarks` plus a new
   `hasSelection` flag.
3. Either: extend `tagDef` with `defaultExtractParentId` (option A) and add
   a config UI in `DefinitionConfigPanel.tsx`.
4. New core command `extract_selection_as_tagged_node`.
5. Tag picker on click; on confirm, run the command.
6. E2E test for both buttons.

## Test plan

- E2E: select text, click heading button, verify the selection range gets
  a `headingMark`.
- E2E: select text, click `#`, pick a tag with a configured extract
  destination, verify a new tagged node exists at the destination with the
  selected text, and the source row now shows an inline reference.
- Undo: single Cmd+Z reverses the whole extract.
