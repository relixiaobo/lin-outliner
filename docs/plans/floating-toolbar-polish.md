# Floating Toolbar Additions

**Shape:** (b) A SET of two independent complete features. The heading-mark
toggle is a renderer-only PR. Selection extraction is a coordinated Core and
renderer feature in a later PR.

## Goal

Expose the existing heading mark in the selection toolbar and add one atomic
workflow that extracts selected rich text into a tagged destination Node while
replacing the source selection with an inline reference.

## Non-goals

- No toolbar redesign, color/font-size controls, heading levels, or persistent
  toolbar mode.
- No global Extracts bucket or implicit destination.
- No renderer sequence of partially committed mutations and no hidden fallback
  when a tag has no configured destination.
- No change to the ordinary at-caret `#` tag trigger.

## Design

### Requirements

- **FR-1:** Heading toggle uses the current rich-text mark patch path and adds no
  Core protocol.
- **FR-2:** Extraction is admitted only for a non-empty valid rich-text range and
  a tag with one live configured destination.
- **FR-3:** Destination creation, tag application, and inline replacement commit
  in one Core transaction or not at all.
- **FR-4:** Extracted content preserves supported marks and references without
  splitting an inline-reference boundary.
- **FR-5:** One Undo/Redo treats extraction as one user action.

### Feature 1: heading-mark toggle

Add `headingMark` to the toolbar mark union and button registry, using the
existing `HeadingIcon`. It follows the same add/remove mark path as bold,
italic, strike, code, and highlight. Update the toolbar's stable width/geometry
for the extra fixed-size control so selection or active state cannot resize the
overlay.

This feature touches only renderer toolbar/editor code and focused tests. The
mark already round-trips through the current rich-text codec and patch runtime.

### Feature 2: selection extraction

The destination policy is the ratified per-tag relationship: a tag definition
may hold one `defaultExtractParentId`. The configuration UI validates and stores
that relationship through the canonical document command surface.

For a non-empty selection:

1. `#` opens the existing tag selector using the action registry's current
   create-then-apply candidate policy.
2. Selecting a tag with a live destination submits one compound Core command
   containing the source Node, exact rich-text range/revision, tag, and resolved
   destination.
3. Core validates all identities and the stale range before mutation, creates
   one destination Node from the selected rich-text slice, applies the tag, and
   replaces the source slice with one inline reference in the same transaction.
4. One Undo reverses the entire operation. Any failed validation commits
   nothing.

The extracted Node preserves supported marks and inline references through the
canonical rich-text slice codec. A selection that would split an inline
reference boundary is rejected using the existing text-patch rules rather than
silently flattening content.

`outline-source-model` lands before Feature 2 because it changes `src/core/types.ts`,
`src/core/commands.ts`, Node structural variants, and create/clone invariants on
the exact shared protocol surface. Feature 1 has no such dependency.

### Verification

Feature 1 tests toggle on/off, mixed selection state, keyboard focus, overlay
geometry, and one-step Undo. Feature 2 tests exact rich-text preservation,
destination/tag application, inline-reference replacement, stale range,
missing/deleted destination, invalid boundaries, concurrent edits, atomic
failure, and one-step Undo/Redo. Visual evidence covers the toolbar and tag
picker in light/dark and narrow panes.

## Acceptance Criteria

- **AC-1:** Selecting text and toggling Heading adds/removes `headingMark`
  through the existing patch path with stable toolbar geometry.
- **AC-2:** Selecting a configured tag creates one tagged Node under its live
  destination and replaces the exact source slice with one inline reference.
- **AC-3:** Stale range, deleted destination/tag, invalid reference boundary, or
  concurrent conflict commits no partial mutation.
- **AC-4:** One Undo restores the original source and removes the created Node;
  one Redo reproduces the same logical result through canonical command replay.
- **AC-5:** Feature 2 begins only after `outline-source-model` and changes no special/legacy
  Node or Source path.

## Open questions

None. Heading levels remain out of scope, no-selection hides the extract action,
and per-tag destination is the ratified policy.

## Implementation checklist

- [ ] Ship the renderer-only heading toggle independently.
- [ ] Land `outline-source-model` before claiming the coordinated extraction protocol.
- [ ] Add the per-tag destination field, configuration surface, and one atomic
      extraction command without renderer-side mutation sequencing.
- [ ] Update current rich-text, command, and UI specs.
- [ ] Run typecheck, relevant Core/renderer/E2E tests, docs check, diff check,
      and light/dark visual verification for each feature.
