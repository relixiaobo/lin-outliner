---
status: draft
priority: P2
owner: relixiaobo
created: 2026-06-03
updated: 2026-06-03
---

# File Preview

> **Depends on [`workspace-tabs-to-single-pane.md`](workspace-tabs-to-single-pane.md).**
> Preview is a new kind of *view-state* in a pane. This plan assumes the
> single-pane refactor has generalized the per-pane history from a `NodeId[]`
> stack to a discriminated **view-state** stack (so a `file-preview` entry slots
> in next to `outliner`). An advisory note to that effect has been raised on the
> refactor. If that refactor ships with history still hard-typed to `NodeId`,
> S1 must first generalize it — do not build preview on the interim shape (A7).

Let a user click a local-file reference — in the outliner, in agent output, or
anywhere a file appears — and read that file **inside the app**, in the current
pane, with a back button to return to the node. `Cmd`+click opens the preview in
a split pane (read on one side, take notes on the other). URLs open in a
reader-mode preview with an "open original" escape hatch.

## Goal

- A **unified preview pane**: one shell (back / file identity / source-aware
  "open externally" / loading·error·unsupported states) hosting a **swappable,
  per-type content renderer** chosen from a registry. Identical interaction
  chrome across every file type; content-level interaction lives in each
  renderer.
- A **unified click router**, keyed on the reference target, wired into **every**
  surface where a file/URL can appear, so "click → preview" behaves the same
  everywhere by construction (not per-surface logic).
- **Read local file bytes** from the main process by absolute path (validated),
  delivered to the renderer over a new `local://` custom protocol — streamed,
  never base64'd over IPC.
- Inline interactive rendering for the high-value, web-native types; a metadata
  card + "open in default app" for everything else; URLs via reader-mode
  extraction.
- **100% web-native / cross-platform, zero OS-native dependency.** macOS-first
  in practice, but nothing here is mac-specific.

## Non-goals

- **Annotation / Reader (highlights, comments, bidirectional highlight,
  select-to-insert-quote).** Still being explored; explicitly **not** part of
  this PR and **not** a stage here. The renderer contract is kept minimal and
  does *not* pre-bake annotation fields — see "Forward-compat" for how it extends
  cleanly later.
- **The `attachment` node type** ([`file-attachments.md`](archive/file-attachments.md))
  and **block-node inline rendering** ([`image-rendering.md`](image-rendering.md),
  `BlockNodeRow`/`ImageRow`). Those render a file *as a block inside the outline*.
  This plan is the *destination pane* you open *from* such things. They compose:
  an attachment node's "open" routes into this preview pane. We do **not**
  duplicate the attachment node, the block-node shell, or the asset pipeline.
- **An in-app live browser** (an isolated `<webview>`/`WebContentsView` loading
  real, interactive remote pages). Considered and rejected for this line: it is a
  larger, separate capability (browser-grade scope, expanded threat surface,
  doesn't fit the renderer contract). URLs here are reader-mode only, with an
  "open original page" escape to the system browser.
- **Embeds** (YouTube/Twitter iframes) — separate decision in
  [`embed-strategy.md`](embed-strategy.md). Reader-mode article extraction is not
  an embed.
- High-fidelity Office rendering. docx/xlsx/pptx are best-effort web-native
  conversions (read the content, not pixel-perfect layout). No LibreOffice /
  external-binary conversion path.

## Relationship to existing work (collision self-check)

Run 2026-06-03: `gh pr list` → **no open PRs**. Related plans:

- **Dependency** — `workspace-tabs-to-single-pane.md` (draft): the pane /
  view-state model this builds on. Blocked on it.
- **Composes with** — `file-attachments.md` (draft): the `attachment` node type.
  Preview is its "open" destination. Coordinate so attachment "open" calls the
  same click router, not a bespoke handler.
- **Adjacent surface** — `image-rendering.md` (in-progress, branch
  `cc/asset-subsystem-images`): block-node inline rendering via `BlockNodeRow`.
  Distinct from the preview pane. Images already render inline as blocks; the
  preview pane is the full-view click-through. Reuse `asset://` patterns; do not
  touch `BlockNodeRow`.
- **Sibling protocol** — `asset-subsystem.md`: the `asset://` protocol. `local://`
  is a sibling handler with a **separate origin** (stored snapshot assets vs.
  live arbitrary local files are two different security capabilities).
- **Protocol seam** — `outliner-local-file-references.md` (done, PR #80) shipped
  `ReferenceTarget = node | local-file` and deferred an `asset` / `remote-url`
  kind "added with their consumers". **S6 (url-reader) is that consumer for
  `remote-url`.** Today URLs are stored as `link` text marks, not a
  `ReferenceTarget`; the router handles both (see Click router). Adding the
  `remote-url` kind touches `src/core/types.ts` — a protocol/shared change →
  land it **interface-first**, coordinated, per the shared-interface rule.

## Design

### 1. Unified preview pane = shell + renderer registry

A `file-preview` view-state renders a **shell** that is identical for every
source. The shell owns:

- **Back** (pops the pane's view-state stack → returns to the prior node/preview).
- **File identity** in the breadcrumb slot (name + path), replacing the node
  breadcrumb while in preview.
- **Source-aware "open externally"** action (the universal escape hatch):
  - file → "Open in default app" (`shell.openPath`, path validated)
  - url → "Open original page" (`shell.openExternal`, https only)
- **Loading / error / unsupported** overlay states (handled once, in the shell).
- An optional **per-type toolbar slot** (PDF page/zoom, etc.) injected by the
  renderer into the shell's one toolbar row.

Inside, the **reader area** hosts one renderer chosen from a registry:

```ts
interface PreviewRendererEntry {
  id: string;                            // "pdf" | "image" | "text" | "docx" | "fallback" | ...
  priority: number;                      // higher wins; fallback = -Infinity
  match(source: PreviewSource): boolean; // by ext / mimeType / source kind
  component: PreviewRendererComponent;   // renders into the reader area
  toolbar?: PreviewToolbarComponent;     // optional; shares the renderer's handle
}
```

**The bucket-2 metadata card is just a `fallback` entry** (`match` always true,
`priority = -Infinity`). So every source — supported or not — opens the *same*
pane through the *same* machinery; "unsupported" is simply a registry miss. This
is the core simplification: one code path, one shell, swappable bodies.

Design-system: shell is an opaque content layer (B5); back / open-externally are
icon controls that deepen on hover, no box (B6); preview chrome is not
user-selectable (B10).

### 2. `local://` protocol — byte delivery

Bytes reach the renderer over a new privileged custom protocol, **not** base64
over IPC (verified: base64-over-IPC is the wrong pattern; `protocol.handle` +
`net.fetch(pathToFileURL(path))` is the modern, streamed, Range-capable way —
Electron protocol docs; issue #42612 notes added latency, fine for
preview-sized reads, **stream large media via Range**).

- Scheme: **`local://`** (internal only — appears in `src=`/`fetch`, never shown
  to the user; same nature as the existing `asset://`).
- Registered `registerSchemesAsPrivileged` as standard + secure + stream +
  `supportFetchAPI`. **Do not set `bypassCSP`** (verified refuted as a fix; it
  only weakens CSP — the real PDF-blank cause is cross-origin/CORS, addressed by
  serving same-origin).
- Token→path mapping in main (mirrors the existing search-cache hashed-ID
  pattern) so raw paths never appear in URLs and every fetch passes validation.
- Separate origin from `asset://` (distinct, more-scrutinized capability).

`PreviewSource` (the input every renderer receives):

```ts
interface PreviewSource {
  path: string;            // absolute, realpath'd + validated in main
  name: string;
  ext: string;             // lowercased, no dot
  mimeType: string;        // sniffed in main
  entryKind: 'file' | 'directory';
  sizeBytes: number;
  lastModified: number;
  url: string;             // "local://<token>" — same-origin, streamed
  readText(): Promise<string>;       // size-capped in main
  readBytes(): Promise<ArrayBuffer>; // for pdfjs / mammoth / SheetJS
}
```

S6 generalizes this to a `file | url` discriminated union (url sources carry the
fetched + extracted article HTML instead of a `local://` url).

### 3. Unified click router

One router, invoked from every surface, normalizes the click target and
dispatches:

```
node       → navigate the pane to that node (existing behavior)
local-file → open file preview (onOpenFilePreview(path, entryKind))
url        → open reader-mode preview (S6); escape hatch = open original
```

Wired into:

- **Outliner inline refs** — `RichTextEditor.tsx` click handler (today handles
  only node refs at ~`:425`; add the `local-file` arm).
- **Outliner link marks** — URL clicks (today stored as `link` text marks) →
  url arm.
- **Agent output** — `AgentMarkdown.tsx` (today renders `local-file` segments as
  plain text) → make them clickable; route through the same router.
- **Agent attachments** — `AgentInlineReferenceText` file chips.
- **Attachment node "open"** — when `file-attachments.md` lands (coordinate).

**Entry-point coverage checklist + edge cases** (must all be handled for "works
everywhere" to be true):

- [ ] Directory ref (`entryKind: 'directory'`) → directory-listing renderer, not
      a read error.
- [ ] URL → reader preview / open-original; **never** the file path.
- [ ] Agent `inline_text` attachment → no disk path; detect and degrade (not
      previewable).
- [ ] Snapshot vs live: agent attachments carry `path` and `readPath`; preview
      opens the **live `path`** (consistent with path-based live read).
- [ ] Composer (input) chips → editing context; plain click does not jump to
      preview (or gate behind a modifier) — decide and note.

### 4. Scope — two buckets

**Bucket 1 — inline preview** (renderer entries):

| Type | Renderer | Dependency | Notes |
|---|---|---|---|
| Text / source code | shiki (read-only) | already bundled | CodeMirror 6 only if scroll/search/fold demanded later |
| Markdown | react-markdown + remark-gfm + DOMPurify | bundled + `dompurify` | |
| Images (SVG as `<img>`) | `<img src="local://…">` | — | SVG rendered as image (neutralizes scripts), never inlined |
| PDF | pdf.js (pdfjs-dist) → canvas | `pdfjs-dist` | bundle the worker locally (the "worker→blob breaks CSP" claim is refuted); serve same-origin to avoid the CORS-blank issue |
| Audio / video | `<video>`/`<audio>` + `local://` streaming + Range | — | codec caveat: Electron's Chromium plays H.264/AAC/MP4 etc., **not every** codec → unplayable falls back to the card |
| CSV / TSV | table renderer (reuse SheetJS once present) | (via `xlsx`) | |
| Word `.docx` | mammoth **or** docx-preview + DOMPurify | `mammoth`/`docx-preview` | semantic vs visual-fidelity — pick one in S5 |
| Excel `.xlsx` | SheetJS (Community) → react-data-grid | `xlsx` + `react-data-grid` | data fidelity (no charts/visual layout); needs **no** nodeIntegration (refuted), fed an ArrayBuffer |
| PowerPoint `.pptx` | **best-effort** JS renderer + DOMPurify | **TBD (unverified)** | lowest fidelity, highest risk; library selection + verification is an S5 sub-step |
| URL | reader-mode (S6) | `defuddle` + `linkedom` (bundled) | |

**Bucket 2 — open in default app** (the `fallback` entry): zip/archives,
`.ipynb`, design/proprietary/binary/executables, unknown. A metadata card
(icon / name / size / mtime / path) + "Open in default app" / "Reveal in
Finder". **No QuickLook/Shell thumbnail** in the preview fallback (dropped
deliberately). Note: this does **not** remove `nativeImage.createThumbnailFromPath`
(`src/main/main.ts:~1087`), which still serves inline file chips / agent composer
thumbnails — a different surface.

### 5. url-reader (S6)

- main fetches the URL (Node side; https only), extracts the article with
  **defuddle** (+ linkedom — both already deps; likely already used by agent web
  tools), DOMPurifies the result, returns clean **static HTML**. No live remote
  content in any renderer.
- Rendered in the same pane via a `url-reader` registry entry (same path as
  markdown/docx HTML).
- **Remote images** in the extracted article need a policy (the packaged CSP
  blocks remote loads): **proxy/inline through main, or strip/placeholder** —
  do **not** open `img-src` to remote (privacy/tracking). Lean (b) proxy or (c)
  strip.
- Escape hatch: shell "Open original page" → `shell.openExternal`.
- Adds the `remote-url` `ReferenceTarget` kind (interface-first; see collision
  check) when a URL is a first-class reference; link-mark URL clicks work
  without it.

### 6. Security checklist

- **DOMPurify** every file→HTML product (markdown, docx, pptx, url-reader). SVG
  as `<img>`, never inlined.
- **Path validation** in main: realpath (resolve symlinks), confirm in-bounds,
  `isFile`/`isDirectory`, size cap, timeout; reject zip-bombs / oversized reads
  before loading into memory; stream binaries.
- **`shell.openPath`** (files) / **`shell.openExternal`** (urls, https only) —
  validate the target; `openExternal` is a known XSS→RCE vector (DeepChat CVE).
- **Untrusted-content isolation**: v1 renders *derived, sanitized* HTML in the
  trusted renderer (acceptable, documented compromise). Raw `.html` files and any
  genuinely-untrusted interactive content stay "open externally" until/unless an
  isolated `<webview>` is added (deferred hardening). pdf.js parsing untrusted
  PDFs in the trusted renderer is moderate risk — acceptable with bundled worker,
  no eval; isolate later if needed.

## Forward-compat (the annotation seam — defined, not built)

When Reader/Annotation is eventually designed, it extends this cleanly **without
re-cutting the contract**, because the registry is open: add capability flags
(`selectable`, `annotatable`), an imperative handle (`getSelection()`,
`applyHighlights()`, `scrollToAnchor()`), and a per-type `PreviewAnchor`
(text-quote / pdf page+rects / epub CFI / sheet cell). Highlights would be
**nodes** (quoted text + a `file-locator` `ReferenceTarget`, comments as child
nodes), painted back by querying the open file's highlight nodes. **None of this
is in scope now** — the anchor model is the hard, unvalidated part and is left
for its own plan + research. We deliberately do not speculate its shape here.

## Open questions

- pptx renderer library — needs a focused evaluation/verification before S5
  (first research pass did not cover pptx). Accept best-effort fidelity.
- docx: mammoth (clean/semantic) vs docx-preview (visual fidelity) — decide in S5.
- url-reader remote-image policy: proxy-through-main vs strip — decide in S6.
- Composer chip click behavior (jump vs modifier-gated) — decide in S1.
- `remote-url` `ReferenceTarget` kind: confirm interface-first ordering with
  whoever owns `src/core/types.ts` at S6 time.

## Complete PRs (dependency-ordered)

**Execution (complete-per-PR).** Shape (b): each PR below is a complete, usable
preview capability — not a partial slice. The shell alone isn't independently
useful, so it bundles with the cheap web renderers into the first PR; each later
renderer class is a complete feature on its own ("PDF preview works", "Office
preview works"). The whole line is **blocked on**
`workspace-tabs-to-single-pane`. Gate per PR: protocol/shared + UI → `/code-review
ultra` + visual verification (light + dark).

- [ ] **PR 1 — Shell + web-native renderers (the first usable feature).**
  `local://` protocol + main path-read/validate; `PreviewSource(file)`; preview
  pane shell (back / file identity / source-aware open-externally /
  loading·error·unsupported); renderer registry + `fallback` metadata-card entry;
  unified click router wired into all entry points (coverage checklist); plus the
  cheap web-native renderers — text/code (shiki), markdown (react-markdown +
  DOMPurify), images (SVG-as-img), CSV/TSV. *Outcome: every file opens the pane
  and the common types render — a complete, usable preview.*
- [ ] **PR 2 — PDF.** pdfjs-dist → canvas; local worker; same-origin serving;
  per-type toolbar (page/zoom).
- [ ] **PR 3 — Media.** `<video>`/`<audio>` + `local://` Range streaming; codec
  failure → fallback card.
- [ ] **PR 4 — Office.** docx (mammoth/docx-preview), xlsx (SheetJS + react-data-grid;
  CSV reuse), **pptx (best-effort; library selection + verification first)**.
- [ ] **PR 5 — url-reader.** `PreviewSource(url)`; main fetch + defuddle + DOMPurify
  + remote-image policy; router url arm; "Open original" escape; `remote-url`
  `ReferenceTarget` kind interface-first.
