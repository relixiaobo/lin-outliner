# File Preview Extensions

**Shape:** (b) A SET of two independent complete user-visible features: Office
preview and static URL reading. Each ships in its own PR after the shared Host
and Source foundations.

## Goal

Complete the two remaining high-value readers on the unified preview surface:

- bounded, best-effort DOCX, XLSX, and PPTX preview; and
- a static readable presentation for an explicit `http(s)` Source alongside
  the existing hardened interactive webview.

Both features consume the final Source selection/resolution contract from
Source PR-I and the final `createResourcePreviewHost()` ownership from
`host-runtime-composition`. They must not extend the old special file/image Node
model or add work to the implicit `main.ts` composition root.

## Non-goals

- No editing, annotations, comments, quote anchoring, or Office formula/macro
  execution.
- No new preview target, file store, Agent resource kind, or renderer filesystem
  authority.
- No QuickLook, LibreOffice, browser automation, authenticated-page scraping,
  or persistent webview-cookie transfer into static reading.
- No third Office or webpage extraction implementation beside existing product
  readers.
- No compatibility reader for retired development formats.

## Design

### Requirements

- **FR-1:** Every preview begins from the final selected Source and Host resolver;
  renderer never receives filesystem or network authority.
- **FR-2:** Office preview and Agent Office reading consume one bounded extraction
  service and one archive/security policy.
- **FR-3:** Static preview and Agent webpage reading consume one explicit page
  reader and one network/sanitization policy.
- **FR-4:** Partial, unsupported, denied, and failed reads remain distinguishable
  and preserve an authorized fallback action.
- **FR-5:** Neither feature creates a new persistence store, target kind, pane
  type, or compatibility path.

### Shared Source and preview boundary

The selected resolved Source remains the only entry to preview. `PreviewTarget`
continues to identify local-file, AssetRecord, or URL authority; main resolves it
to a typed descriptor and the renderer chooses the first matching
`PreviewRendererEntry` by registry order. The existing `FilePreviewShell`,
panel history, Open/Reveal/Copy actions, error states, and metadata fallback stay
authoritative.

Loose Thread and Agent references reach the same target resolver. They do not
add an `agent-payload` target or expose managed paths to renderer. Agent Result
And Resource Reference Lifecycle may later supply another canonical reference,
but it resolves through this same Host boundary.

### Feature 1: Office preview

Create one Host-owned Office extraction service used by both preview and Agent
file reading. Consolidate the existing hardened PPTX structural parser and the
current DOCX/XLSX conversion path behind that service before adding a renderer;
preview must not become a third parser with different limits or security rules.

The service returns a bounded typed document:

- DOCX: headings, paragraphs, lists, tables, safe links, and bounded images;
- XLSX: sheet metadata and bounded rows/columns with cached values; and
- PPTX: slide order, text, bounded images, notes where admitted, and basic
  geometry sufficient for a readable slide view.

One archive policy owns compressed size, entry count, decompressed bytes,
relationships, embedded media, sheets/rows/columns, slides, and timeouts.
Macros, OLE, external relationships, formula execution, scripts, and active
content remain inert. Unsupported constructs produce explicit partial-coverage
facts rather than disappearing silently.

Renderer output uses React data structures, not unsanitized generated HTML.
Object URLs for admitted embedded media are component-owned and revoked on
teardown. Parse failure and partial coverage retain Open Original and the
metadata fallback.

### Feature 2: static URL reader

Factor the existing Defuddle-based page extraction used by Agent web fetch into
a Host-owned `ExplicitPageReader`. The Agent tool and preview presentation both
consume that service; neither wraps the other and neither duplicates network or
sanitization policy.

The reader is invoked only from an explicit selected URL Source. It enforces
scheme, redirect, private-address, timeout, byte, content-type, encoding, and
image budgets in main and returns a bounded typed reader document with title,
byline, canonical source URL, semantic blocks, safe links, and admitted images.
It uses no persistent preview cookies and does not claim access to signed-in
content.

The URL preview offers Interactive and Reader presentations through one compact
mode control. Failure in Reader leaves the interactive webview available; it
does not create a second pane type or navigation history. Remote images follow
one shared proxy/cache/strip policy and never enter renderer as unrestricted
URLs.

### Dependencies and collisions

Source PR-I and the complete Host composition set land before either feature.
Source PR-F may land independently after PR-I; a preview feature does not depend
on its layout, but it must not implement concurrently against the same preview
shell/toolbar files. The translation-geometry unit in
`interaction-jank-cleanups` also touches URL/preview scheduling and must be
ordered by the live file check rather than developed in parallel.

### Verification

Office fixtures cover valid files, malformed/encrypted/macro-bearing packages,
archive bombs, external relationships, oversized content, partial coverage, and
Agent/preview parity. URL fixtures cover redirects, private addresses, timeout,
malformed HTML, sanitization, remote images, cancellation, and interactive
fallback. Both features include light/dark, narrow-pane, keyboard, reduced-
motion, and renderer-without-Node evidence.

## Acceptance Criteria

- **AC-1:** DOCX, XLSX, and PPTX fixtures render useful bounded content from the
  same extraction result Agent file reading consumes.
- **AC-2:** Archive bombs, macros, OLE, external relationships, formula execution,
  scripts, oversized media, and malformed Office files cannot execute or bypass
  the shared limits.
- **AC-3:** Reader mode returns a bounded semantic document for an explicit
  public URL and rejects private-address/redirect/size/timeout policy failures
  without affecting interactive preview.
- **AC-4:** Interactive and Reader presentations share one URL target and panel
  history; switching mode creates no second navigation or storage authority.
- **AC-5:** Renderer receives typed data/object URLs only, revokes owned media on
  teardown, and remains free of Node/filesystem/network authority.
- **AC-6:** Source PR-F, Office/Reader work, and translation-geometry work have no
  concurrent claim on overlapping preview shell files.

## Open questions

- Which maintained pure TypeScript DOCX/XLSX libraries best satisfy the shared
  typed-output and archive-budget contract? Resolve with a dependency/license
  spike inside the Office PR; reject a candidate that requires a second parser
  or packaged external runtime.
- Which bounded remote-image policy should `ExplicitPageReader` use? Choose one
  policy for both Agent and preview consumers and record it in the current spec.

These are implementation selections inside fixed security and ownership
boundaries, not permission to change the feature shape.

## Implementation checklist

- [ ] Land Source PR-I and Host composition; regenerate exact preview and
      extraction ownership from current symbols.
- [ ] Consolidate Office extraction before adding Office renderers.
- [ ] Factor `ExplicitPageReader` before adding the Reader presentation.
- [ ] Keep each feature independent and avoid overlap with Source PR-F or
      translation-geometry work.
- [ ] Update current preview, workspace, Agent-tool, and security specs.
- [ ] Run typecheck, relevant Core/renderer/E2E suites, docs check, diff check,
      and light/dark accessibility verification per feature.
