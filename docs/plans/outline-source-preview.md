# Outline Source Preview-First Interaction

**Shape:** ONE complete user-visible feature in one PR.

## Goal

Turn the complete content-first Source baseline into a preview-first resource
interaction without changing the document or public Host protocol. The selected
preview appears before the editable Node content, while every Source remains
visible and manageable through one compact switcher and field surface.

## Non-goals

- No change to Core types/commands, Runtime/CLI schemas, Source URI semantics,
  exact-file grants, managed-asset settlement, or special-Node retirement.
- No new preview renderer, pane type, file store, or renderer authority.
- No hiding Source values or management operations supplied by the baseline.
- No coupling preview visibility to ordinary child disclosure.

## Design

### Preview-first composition

Within the same ordinary Node scope, render selected preview, compact preview
toolbar, editable content/tags, Source field, other fields, and ordinary
children in that order. The preview is presentation only and never occupies an
Outline level or becomes a card containing the Node.

The upper-right close action is **Hide preview** and changes only local
visibility. The Source toolbar label opens an ordered switcher when multiple
values exist. Mature preview bodies retain their existing Open, Expand, reader,
media, translation, and file actions rather than receiving duplicates.

### Hidden and failure states

When hidden, the selected/default Source row exposes **Show preview** and other
rows expose **Preview this source**. Restoring a non-ready value shows its
specific invalid, unsupported, denied, unavailable, or retryable state rather
than an empty body. Switching Source restores the preview but does not move
keyboard focus into interactive media.

The Source field remains visible whenever any value exists even when optional
field-display rules would hide other fields. Drilled Node pages preserve the
same selection, visibility, availability, and action semantics; dense table and
calendar projections render ordered URI values without mounting rich previews.

Selection, visibility, preview-body reader state, and child disclosure remain
four independent state axes. Stable value identity preserves selection through
reorder; removal follows the baseline fallback rules. Async work from an old
selection cannot replace the current preview.

The first newly added Source is selected and shown by default. Adding another
preserves current selection and visibility. Editing the selected visible value
reloads in place; editing another value does not replace the current preview;
editing while hidden remains hidden. Navigation, references, tags, content
edits, and child disclosure change neither selection nor visibility.

### Paste and entry affordances

When the editor receives exactly one bare `http:`, `https:`, or normalizable
`www.` URL with no additional prose or files, an empty target atomically keeps/
materializes the ordinary Node, writes the normalized URL as content, and adds
that producer-normalized Source without replacing an existing value. The first
Source becomes selected and visible; an additional Source preserves current
selection and visibility.

Selected or non-empty content, prose containing a URL, multi-line input, an HTML
anchor, code, or a protected RichText range retains ordinary inline-link
behavior and adds no Source. Typing a URL never auto-converts the Node. Add the
context-menu Source entry commands on the final merged APIs and recompose the
existing Add/Edit/Reorder/Remove/Clear controls without changing their semantics
or inventing a first-value-only adapter.

Image previews use editable Node content as their user-authored accessible name
and the Source-derived label only as an empty-content fallback. This is the UI
half of the retired `inline-media-alt-text` task.

### Dependencies and collisions

`outline-source-model` must merge first. This plan is independent of Host
composition and Agent resource lifecycle after that contract lands. It must not
overlap `file-preview-office`, `url-static-reader`, or preview/translation units
from `interaction-jank-cleanups` on shared preview-shell and toolbar files.

### Verification

Renderer and E2E coverage exercises single/multiple Sources, shown/hidden,
selection/reorder/removal, invalid/denied/unavailable values, stale async work,
Node-page parity, child disclosure, keyboard/focus, reduced motion, narrow
layouts, stable loading geometry, selection/drag/virtualization behavior,
accessibility naming, and light/dark presentation.

### Acceptance criteria

- Preview-first layout changes no document state or public protocol.
- Bare-URL paste converts only the exact empty-target case; every prose,
  selection, multi-line, anchor, code, and protected-range case remains a link.
- Every baseline Source operation remains reachable in shown and hidden states.
- Selecting, hiding, showing, editing, reordering, and removing Sources affect
  only their documented state axes.
- Failure states preserve the Source text and expose an appropriate recovery.
- Existing mature preview capabilities and security boundaries remain intact.
- Image accessible naming follows editable Node content without `mediaAlt`.

## Open questions

None. Exact compact-control placement is resolved against the current design
system during visual verification without changing the interaction contract.

## Implementation checklist

- [ ] Rebase on the merged Source model and regenerate preview-shell collisions.
- [ ] Implement preview-first layout and compact switching on final descriptors.
- [ ] Preserve every baseline management and mature-preview responsibility.
- [ ] Update current UI/preview specs and run renderer/E2E/accessibility/light-
      dark verification.
