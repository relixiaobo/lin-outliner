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

Factor the existing Defuddle-based extraction into a Host-owned
`ExplicitPageReader` consumed independently by Agent web fetch and preview. It
runs only for an explicit selected URL Source and enforces scheme, redirect,
private-address, timeout, byte, content-type, encoding, and image budgets.

The typed result contains title, byline, canonical source URL, semantic blocks,
safe links, and admitted images. Remote images pass one shared proxy/cache/strip
policy and never reach renderer as unrestricted URLs.

The URL preview adds a compact Interactive/Reader mode control inside the same
target and panel history. Reader failure preserves the interactive mode and
reports the policy/fetch/parse reason; it does not open another navigation stack.

The existing `PreviewTarget` resolver and URL preview shell remain the entry
boundary. A loose Thread/Agent URL reference that already resolves there can use
the same Reader presentation without an `agent-payload` target or an Outline
Node projection; explicit selection and public-network policy remain mandatory.

### Dependencies and collisions

`outline-source-model` and `desktop-host-cutover` must merge first. This plan is
independent of `outline-source-preview`, but it serializes live claims on shared
preview shell/toolbar files and URL translation scheduling.

### Verification

Fixtures cover redirects, public/private address transitions, timeout, byte and
content-type limits, malformed HTML, sanitization, unsafe links, remote images,
cancellation, Agent/preview parity, interactive fallback, keyboard, narrow
layout, reduced motion, and light/dark rendering.

### Acceptance criteria

- Reader mode returns one bounded semantic document for an explicit public URL.
- Private-address, redirect, size, timeout, and sanitization failures cannot
  weaken the interactive preview or surrounding Source state.
- Agent and preview consume the same page-reader policy and typed result.
- Mode switching creates no second target, history, cookie jar, or store.
- Renderer receives no unrestricted network authority.
- Loose and Source-backed URL references share the same target, page reader,
  policy, presentation, and cancellation behavior without a Node-only adapter.

## Open questions

Choose one bounded remote-image policy for both Agent and preview consumers and
record it in the current spec. This is an implementation selection inside the
fixed network-authority boundary.

## Implementation checklist

- [ ] Factor `ExplicitPageReader` from the existing Agent extraction path.
- [ ] Add the Reader presentation and shared mode control.
- [ ] Prove network/sanitization bounds, Agent parity, fallback, and visuals.
- [ ] Update current preview, Agent-tool, and security specs.
