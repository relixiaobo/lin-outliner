# Static URL Reader

**Shape:** ONE complete user-visible reader feature in one PR.

## Goal

Offer a bounded static Reader presentation for an explicitly selected public
`http(s)` Source alongside the existing hardened interactive webview, while
sharing one Host page-reading and sanitization authority with Agent web fetch.

## Non-goals

- No authenticated-page scraping, browser automation, persistent webview-cookie
  transfer, external-browser integration, or hidden profile access.
- No second pane/history, preview target, page store, or unrestricted renderer
  network access.
- No replacement of the interactive webview.

## Design

The current `extractPageContent` already shares Defuddle extraction and metadata
with Agent web fetch. `agentWebTools` also owns markdown/text/raw/metadata modes,
matching windows and result projection. Reuse these boundaries instead of
replacing every Agent result with the preview's semantic-block representation.

**FR-1 — Shared extraction with caller-owned acquisition.** Factor the common
extraction and typed presentation into a Host-owned
`ExplicitPageReader` (suggested name), independently callable by an authorized
Agent fetch or explicit preview selection. An Agent call does not require a
selected UI Source. The static preview acquisition path enforces scheme,
redirect, private-address, timeout, byte, content-type, encoding and image limits;
it never inherits interactive-preview cookies or invokes browser fallback.
Shared extraction does not merge the callers' acquisition authority or change
the existing Agent fetch modes/fallback contract as an incidental refactor.

The typed result contains title, byline, canonical source URL, semantic blocks,
safe links, and admitted images. Remote images pass one shared proxy/cache/strip
policy and never reach renderer as unrestricted URLs.
Keep exact raw reads, metadata-only output, textual matching/paging and binary
resource outcomes on their existing Agent projections. Original raw content is
evidence, not renderer-safe markup. Agent requests for public static content use
the shared extraction result without gaining any preview-session access.

**FR-2 — One preview presentation.** The URL preview adds a compact
Interactive/Reader mode control inside the same target and panel history.
Reader failure preserves the interactive mode and
reports the policy/fetch/parse reason; it does not open another navigation stack.

The existing `PreviewTarget` resolver and URL preview shell remain the entry
boundary. A loose Thread/Agent URL reference that already resolves there can use
the same Reader presentation without an `agent-payload` target or an Outline
Node projection; explicit selection and public-network policy remain mandatory.

### Dependencies and collisions

Consume the current Source, preview and Desktop Host contracts from
#598/#599/#603. Recheck the unified-record file-tool claim and the current
`agentWebFetchContent`, `agentWebTools` and fetch/fallback owners. This plan
serializes live claims on shared preview shell/toolbar files and URL translation
scheduling.

### Verification

Fixtures cover redirects, public/private address transitions, timeout, byte and
content-type limits, malformed HTML, sanitization, unsafe links, remote images,
cancellation, Agent/preview parity, interactive fallback, keyboard, narrow
layout, reduced motion, and light/dark rendering.

### Acceptance criteria

- **AC-1:** Reader mode returns one bounded semantic document for an explicit public URL.
- **AC-2:** Private-address, redirect, size, timeout, and sanitization failures cannot
  weaken the interactive preview or surrounding Source state.
- **AC-3:** Semantic Agent reads and preview consume the same extraction/sanitization
  policy and typed result; each caller retains its own acquisition authority.
- **AC-4:** Mode switching creates no second target, history, cookie jar, or store.
- **AC-5:** Renderer receives no unrestricted network authority.
- **AC-6:** Loose and Source-backed URL references share the same target, page reader,
  policy, presentation, and cancellation behavior without a Node-only adapter.
- **AC-7:** An Agent fetch works without a selected UI Source and retains its declared
  raw/metadata/text/markdown, matching and binary-result behavior. Static preview
  never invokes browser fallback or renders raw evidence as trusted HTML.

## Open questions

Choose one bounded remote-image policy for both Agent and preview consumers and
record it in the current spec. This is an implementation selection inside the
fixed network-authority boundary.

## Implementation checklist

- [ ] Factor `ExplicitPageReader` from the existing Agent extraction path.
- [ ] Add the Reader presentation and shared mode control.
- [ ] Prove network/sanitization bounds, Agent parity, fallback, and visuals.
- [ ] Update current preview, Agent-tool, and security specs.
