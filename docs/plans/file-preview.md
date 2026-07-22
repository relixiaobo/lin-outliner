# File Preview Extensions

## Goal

Complete the remaining high-value readers on top of the existing unified file
preview surface:

- best-effort DOCX, XLSX, and PPTX rendering for `local-file` and `asset`
  targets; and
- an optional static reader for `http(s)` URL targets when a readable,
  non-interactive representation is preferable to the hardened webview.

This plan has shape **(b): a set of two independent complete features**. Office
preview and static URL reading are separate PRs. Each must be useful, secure,
and reviewable on its own; neither is groundwork that waits for the other.

## Non-goals

- No annotation, comments, quote insertion, or bidirectional anchors.
- No editable artifact surface. Preview remains read-only.
- No QuickLook, LibreOffice, or other OS-specific/external conversion runtime.
- No replacement for inline `ImageRow` or `AttachmentRow` rendering.
- No browser automation, DOM control, upload, capture, or network interception.
- No new Agent persistence or preview authority. Thread content uses the same
  `PreviewTarget` sources as every other product surface.
- No compatibility reader for removed development data.

## Design

### Canonical target and source model

`PreviewTarget` remains the shared routing contract:

```ts
type PreviewTarget =
  | {
      kind: 'local-file';
      path: string;
      entryKind: 'file' | 'directory';
      label?: string;
    }
  | {
      kind: 'asset';
      assetId: string;
      label?: string;
    }
  | {
      kind: 'url';
      url: string;
      label?: string;
    };
```

The main process resolves a target to either a file descriptor or a normalized
URL descriptor. File descriptors identify their authority as `local-file` or
`asset`; renderer code never infers a filesystem path for an asset.

Agent Core does not add another target kind:

- a `ThreadAttachmentContent` with `source.kind === 'localFile'` routes to a
  `local-file` target;
- a `ThreadAttachmentContent` with `source.kind === 'asset'` routes to an
  `asset` target;
- inline attachment bytes remain Item content until a host-owned action
  materializes them as an asset; and
- file paths and images referenced by command/tool Items route through the same
  local-file or asset authority as equivalent Outliner content.

The identity chain is therefore `ThreadItem -> source-owned PreviewTarget`, not
a second Agent file store. A forked Thread keeps Item history/provenance and
resolves the same source identity without copying external bytes.

### Shared panel shell and registry

Every target opens the existing `file-preview` panel view. The shell owns:

- Back through panel history;
- source identity and type;
- source-aware Open Original, Reveal, or Copy actions;
- loading, parse failure, unsupported, and oversized states; and
- a compact renderer toolbar slot.

Renderer selection remains registry-driven:

```ts
interface PreviewRendererEntry {
  id: string;
  priority: number;
  match(source: PreviewSourceDescriptor): boolean;
  component: PreviewRendererComponent;
  toolbar?: PreviewToolbarComponent;
}
```

The fallback metadata card is the lowest-priority registry entry. A failed
Office/static-reader parse falls back to that card or the existing URL webview;
it never creates a separate navigation surface.

### Office reader feature

One complete Office PR adds three best-effort readers after a dependency and
license review:

| Format | Preferred output | Required behavior |
| --- | --- | --- |
| DOCX | semantic HTML | headings, paragraphs, lists, tables, images, and links |
| XLSX | bounded table view | sheet selector, row/column bounds, values, and basic formatting |
| PPTX | bounded slide view | slide selector, text, images, and basic geometry |

The implementation must:

- operate on bytes delivered by existing preview commands;
- cap input size, decompressed entry count, decompressed bytes, sheets, rows,
  columns, slides, and embedded media;
- sanitize every generated HTML fragment before it reaches React;
- keep scripts, macros, external relationships, and active content inert;
- proxy embedded images through object URLs owned by the preview component and
  revoke them on teardown;
- expose a useful parse error and preserve Open Original; and
- avoid adding a dependency to the main bundle when parsing can remain in the
  sandboxed renderer without Node access.

DOCX semantic fidelity is preferred over page-perfect imitation. XLSX and PPTX
may be deliberately partial, but unsupported constructs must degrade visibly
rather than disappear silently.

### Static URL reader feature

The optional URL-reader PR adds a second presentation for an existing `url`
target. The hardened webview remains available for interactive pages and signed-
in content.

Main performs the network read so redirects, byte limits, timeouts, content
type, and address policy are enforced outside the renderer. Extraction produces
a typed, bounded reader document containing title, byline, source URL, text,
safe links, and optional images. Renderer sanitizes the final HTML again before
display.

The request policy must reject non-HTTP schemes, loopback/private-network
destinations unless an existing product policy explicitly allows them, redirect
escapes, oversized bodies, and unsupported content encodings. Cookies and the
persistent Preview webview session are not copied into the static fetch path.

Remote images use one ratified policy for the whole reader document: proxy and
cache with strict limits, inline already-fetched safe bytes, or strip. Renderer
HTML never receives unrestricted remote image URLs.

### Routing and interaction

The common click router continues to distinguish Node navigation from preview:

```text
node       -> Outliner navigation
local-file -> file-preview
asset      -> file-preview
url        -> URL preview
```

Plain click opens in the current workspace panel and preserves Back. Cmd/Ctrl-
click opens beside the current panel. A click originating in `ThreadDock` uses
the focused workspace panel, falling back to the first panel; it does not turn
the dock into a second preview container.

Composer/editor attachment controls remain editing controls. Preview opens from
the rendered `userMessage` Item or an explicit attachment action, never from a
caret interaction.

### Security and process ownership

- Treat local files, assets, Office archives, extracted HTML, and remote pages
  as untrusted input.
- Keep Node out of renderer. All filesystem and network authority stays in main
  or existing internal protocols/preload commands.
- Validate realpaths and asset IDs before minting internal URLs; never place a
  raw local path in a fetch URL.
- Render SVG as an image, not inline executable markup.
- Block Office macros, OLE objects, external relationships, formula execution,
  and script-bearing HTML.
- Keep `shell.openPath` and `shell.openExternal` source-aware and main-owned.
- Preserve the packaged renderer CSP. A reader must not widen global
  `script-src`, `connect-src`, or `frame-src`.
- Apply reduced motion/transparency/contrast behavior and the existing neutral
  focus/selection system to new controls.

### Verification

Each feature PR includes focused parser limits and malformed-input tests,
renderer routing/fallback tests, and light/dark visual verification. Office
fixtures cover valid examples, encrypted/macro-bearing files, archive bombs,
broken relationships, and oversized content. URL fixtures cover redirects,
timeouts, private addresses, malformed HTML, remote images, and sanitization.

Run the repository-required typecheck, relevant Core and renderer suites,
focused E2E coverage, docs check, and diff check before marking either PR ready.

## Open questions

- DOCX library: semantic `mammoth` output or a more visual renderer after bundle,
  CSP, and sanitization comparison?
- Which maintained PPTX parser meets the archive-limit and no-script contract?
- Should XLSX display formulas as source text, cached values, or both? Formula
  execution is out of scope regardless.
- Is the static URL reader still valuable beside the persistent hardened
  webview, and which single remote-image policy should it use?
