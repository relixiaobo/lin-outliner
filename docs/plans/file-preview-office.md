# Office File Preview

**Shape:** ONE complete user-visible reader feature in one PR.

## Goal

Preview DOCX, XLSX, and PPTX as bounded, useful documents on the unified Source
preview surface, using the same Host-owned extraction result and security policy
as Agent Office reading.

## Non-goals

- No Office editing, comments, annotations, formula/macro execution, QuickLook,
  LibreOffice, or packaged external runtime.
- No new preview target, pane type, file store, or renderer filesystem authority.
- No third Office parser beside the existing hardened PPTX and DOCX/XLSX routes.

## Design

Starting from the selected resolved Source, consolidate current PPTX structural
parsing and DOCX/XLSX conversion behind one `OfficeExtractionService` before
adding renderers. It returns bounded typed content:

- DOCX headings, paragraphs, lists, tables, safe links, and bounded images;
- XLSX sheet metadata and bounded rows/columns with cached values; and
- PPTX slide order, text, bounded images, admitted notes, and basic geometry.

One archive policy owns compressed size, entry count, decompressed bytes,
relationships, media, sheet/row/column, slide, and timeout limits. Macros, OLE,
external relationships, formulas, scripts, and active content remain inert.
Unsupported constructs produce explicit partial-coverage facts.

Renderer output uses typed React data, never unsanitized generated HTML. Owned
object URLs are revoked on teardown. Parse failure and partial coverage retain
metadata plus Open Original where the resolved Source authorizes it.

The existing `PreviewTarget` resolver, `FilePreviewShell`, panel history, and
authorized actions remain the outer boundary. Loose Thread/Agent file references
that already resolve through it receive the same Office renderer without adding
an `agent-payload` target or requiring an Outline Node projection.

### Dependencies and collisions

`outline-source-model` and `desktop-host-cutover` must merge first. This plan is
independent of `outline-source-preview`, but only one claim may own shared
preview registry/shell files at a time. It also serializes with relevant
translation-geometry work.

### Verification

Fixtures cover representative valid documents, malformed/encrypted/macro-
bearing packages, archive bombs, external relationships, oversized content,
partial coverage, cancellation, Agent/preview parity, object-URL cleanup,
narrow pane, keyboard, reduced motion, and light/dark rendering.

### Acceptance criteria

- All three formats render useful bounded content from the same extraction
  result consumed by Agent reading.
- Active Office content and archive bombs cannot execute or bypass shared limits.
- Partial/failed reads remain distinguishable and preserve authorized fallback.
- Renderer receives typed content/object URLs only and owns their cleanup.
- No second extraction authority or external packaged runtime is introduced.
- A loose resolved file reference and a Source-backed file use the same target,
  extraction, renderer, limits, and actions without a Node-only adapter.

## Open questions

Select a maintained pure-TypeScript DOCX/XLSX library only after a focused
dependency/license/archive-policy spike. Reject any candidate that creates a
second parser or requires a packaged helper runtime.

## Implementation checklist

- [ ] Consolidate current Office extraction and limits before renderer work.
- [ ] Add typed DOCX/XLSX/PPTX presentations and partial-state UI.
- [ ] Prove Agent/preview parity, archive security, cleanup, and visual behavior.
- [ ] Update current preview, Agent-tool, and security specs.
