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
- No preview-only parser or independent Agent/preview interpretation of the same
  supported Office format.
- No removal of the separate XLS or EPUB ingestion behavior in this feature.

## Design

### Current boundary and selected replacement

`agentPptxIngestion` supplies the current bounded PPTX reader.
`ingestRichDocumentAsMarkdown` in `agentFileIngestion` handles DOCX and XLSX by
invoking locally installed MarkItDown/Python; it does not supply a bundled typed
Office document. Wrapping that converter alone cannot satisfy the no-external-
runtime preview goal, and adding a separate preview parser would split authority.

**FR-1 — One extraction authority.** The selected feature replaces the DOCX/XLSX
MarkItDown routes with one Host-owned TypeScript extraction boundary shared by
Agent reading and preview, while
incorporating the existing PPTX parsing and archive limits. `OfficeExtractionService`
is a suggested name. Change format dispatch, derived-cache identity, tool result
projection, converter attribution and recovery guidance in the same PR. Do not
fall back to Python for these formats or tell users to install it after a failed
native parse. XLS and EPUB keep their existing independent ingestion routes.

**FR-2 — Bounded typed content.** After parser feasibility is established,
starting from a selected resolved Source or authorized Agent file read, the
shared result provides bounded typed content:

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

Consume the current Source, preview and Desktop Host contracts from
#598/#599/#603. Coordinate `agentFileIngestion`, `agentPptxIngestion`,
`agentLocalTools`, format/cache/result consumers and any dependency/build edits;
the unified-record file-tool claim must settle before overlapping mutations.
Only one claim may own shared preview registry/shell files at a time, and this
plan also serializes with
relevant translation-geometry work.

### Verification

Fixtures cover representative valid documents, malformed/encrypted/macro-
bearing packages, archive bombs, external relationships, oversized content,
partial coverage, cancellation, Agent/preview parity, object-URL cleanup,
narrow pane, keyboard, reduced motion, and light/dark rendering.

### Acceptance criteria

- **AC-1:** All three formats render useful bounded content from the same extraction
  result consumed by Agent reading.
- **AC-2:** Active Office content and archive bombs cannot execute or bypass shared limits.
- **AC-3:** Partial/failed reads remain distinguishable and preserve metadata and
  authorized Open Original, without an implicit second converter.
- **AC-4:** Renderer receives typed content/object URLs only and owns their cleanup.
- **AC-5:** No second extraction authority or external packaged runtime is introduced.
- **AC-6:** DOCX/XLSX reads and previews work with Python/MarkItDown absent. Their parser
  failure is explicit and never routes to a second converter; XLS/EPUB behavior
  and existing PPTX bounds remain covered by regression fixtures.
- **AC-7:** A loose resolved file reference and a Source-backed file use the same target,
  extraction, renderer, limits, and actions without a Node-only adapter.

## Open questions

Select a maintained pure-TypeScript DOCX/XLSX library only after a focused
dependency/license/archive-policy spike, including cached spreadsheet values and
representative bounded media. Reuse the same accepted parser for both consumers.
If no candidate meets the packaged-runtime and archive policy, return a concrete
scope/implementation alternative before building the preview; do not assume the
existing Python converter meets the selected target. This feasibility work is
inside the complete feature, not a separately shipped extraction scaffold.

## Implementation checklist

- [ ] Prove parser feasibility, then replace DOCX/XLSX conversion and consolidate
      shared Office extraction/limits before renderer work in the same PR.
- [ ] Add typed DOCX/XLSX/PPTX presentations and partial-state UI.
- [ ] Prove Agent/preview parity, archive security, cleanup, and visual behavior.
- [ ] Update current preview, Agent-tool, and security specs.
