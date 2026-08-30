# Outline Source Preview-First Interaction

**Shape:** ONE complete user-visible feature in one PR.

## Goal

Turn the complete content-first Source baseline into a preview-first resource
interaction without changing the document or public Host protocol. The selected
preview appears before the editable Node content, while every built-in URI value
remains visible and manageable through one compact switcher and its ordinary
field surface.

## Non-goals

- No change to Core types/commands, Runtime/CLI schemas, Source URI semantics,
  exact-file grants, managed-asset settlement, or special-Node retirement.
- No new preview renderer, pane type, file store, or renderer authority.
- No hiding Source values or management operations supplied by the baseline.
- No replacing ordinary child disclosure with a preview-specific expansion state.

## Design

### Preview-first composition

On the drilled root Node page, render the selected preview and compact preview
toolbar before editable content. In an ordinary Outline, render the selected
preview above the owner Node's editable content, followed by its ordinary URI
field. This matches Tana's visible order: preview, title/content, then URI. The
preview aligns with the owner content column, is presentation only, and never
occupies an Outline level or becomes a child or card containing the Node.
While the preview is visible, the ordinary Node marker occupies the rail beside
the preview's upper edge rather than repeating beside the title. Its expanded
guide begins below that real marker and runs through the preview composition to
the final visible descendant marker. Hiding the preview or collapsing the Node
returns the same marker to the title row. The shown preview participates in the
ordinary child/field disclosure instead of creating a second expansion model.

On the Node page, the upper-right close action changes only local visibility and
the Source toolbar label opens an ordered switcher when multiple values exist.
In the Outline, no duplicate toolbar appears: the selected URI value's inline
affordance owns **Hide preview**, while other URI values own preview switching.
URI values use these in-value affordances without a redundant value-row marker;
the owner Node's ordinary bullet and chevron remain unchanged. At the minimum
supported pane width, the URI field stacks its name above the value, and the
owner preview compacts mature preview controls inside the available width.
Mature preview bodies retain
their existing Open, Expand, reader, media, translation, and file actions rather
than receiving duplicates. The ordinary Node bullet and chevron keep only their
navigation and child-disclosure responsibilities.

### Hidden and failure states

When hidden, the selected/default URI value exposes **Show preview** and other
values expose **Preview this source** in the value row itself. Restoring a non-ready value shows its
specific invalid, unsupported, denied, unavailable, or retryable state rather
than an empty body. Switching Source restores the preview but does not move
keyboard focus into interactive media.

The URI field follows the same field-display, editing, movement, and deletion
rules as other fields. Drilled Node pages preserve the same selection,
visibility, availability, and action semantics; dense table and calendar
projections render ordered URI values without mounting rich previews.

Selection, the stored preview preference, preview-body reader state, and child
disclosure remain independent state axes. Effective Outline visibility requires
both a shown Source preference and an expanded owner Node. Stable value identity
preserves selection through reorder; removal follows the baseline fallback
rules. Async work from an old selection cannot replace the current preview.

The first newly added Source is selected and shown by default. Adding another
preserves current selection and visibility. Editing the selected visible value
reloads in place; editing another value does not replace the current preview;
editing while hidden remains hidden. Navigation, references, tags, content
edits, and child disclosure change neither Source selection nor its stored
preview preference.

### Paste and entry affordances

When the editor receives exactly one bare `http:`, `https:`, or normalizable
`www.` URL with no additional prose or files, an empty target atomically keeps/
materializes the ordinary Node, writes the normalized URL as content, and adds
that producer-normalized Source without replacing an existing value. The first
Source becomes selected and visible; an additional Source preserves current
selection and visibility.

Selected or non-empty content, prose containing a URL, multi-line input, an HTML
anchor, code, or a protected RichText range retains ordinary inline-link
behavior and adds no URI value. Typing a URL never auto-converts the Node. Add
task-oriented context-menu URI commands on the final merged APIs and recompose
the existing Add/Edit/Reorder/Remove/Clear conveniences without restricting the
ordinary field surface or inventing a first-value-only adapter.

Image previews use editable Node content as their user-authored accessible name
and the Source-derived label only as an empty-content fallback. This is the UI
half of the retired `inline-media-alt-text` task.

### Type-specific preview presentation

Resolved preview descriptors select one presentation through the renderer
registry, rather than branching on Node type or repeating MIME checks in the
shell. Documents (PDF, EPUB, HTML, Markdown, code, plain text, delimited tables,
and directories) retain summary/full reading chrome, `Expand`/`Collapse`, and
resize. Images render directly at their intrinsic aspect ratio with no document
frame, expansion control, or resize handle; their authorized file operations
remain in an ellipsis overlay, and inline previews stay within a bounded
inspection size while a dedicated reader may use the larger viewport. Audio and
video own their playback surface and same-layer actions. Ordinary URLs remain a
direct web surface. YouTube watch, short, live, and short links use a bounded
16:9 embed with click-to-play behavior and never inherit an autoplay request
from the source URL. The webview attach boundary strips arbitrary referrers and
assigns YouTube embeds one fixed Tenon app referrer so the player can identify
its client without extending that capability to ordinary URLs. Unsupported
binaries use the bounded metadata presentation and its open/actions control.

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
- [ ] Implement Node-page preview-first layout plus Tana-style URI-value preview
      controls and compact switching on final descriptors.
- [ ] Preserve every baseline management and mature-preview responsibility.
- [ ] Update current UI/preview specs and run renderer/E2E/accessibility/light-
      dark verification.
