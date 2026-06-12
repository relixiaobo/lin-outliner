---
status: in-progress
priority: P2
owner: relixiaobo
created: 2026-06-03
updated: 2026-06-12
---

# File Preview Pane

Open any file-shaped reference in a workspace panel and inspect it inside Lin.
The target is broader than "open a local path": files can come from outliner
local-file refs, outliner attachment/image assets, agent message references,
agent answer attachments, agent-generated payloads, and captured URLs. One panel
shell and one renderer registry should serve all of them.

Plain click opens the preview in the current panel with Back returning to the
previous view. Cmd/Ctrl-click opens the preview in a split panel so a user can
read beside their outline. URLs use reader-mode preview with "open original" as
the escape hatch.

## Goal

- A unified **preview panel**: one shell (Back / identity / source-aware open
  externally / reveal or copy where safe / loading, error, unsupported states)
  hosting a swappable per-type renderer chosen from a registry.
- A unified **PreviewTarget** model keyed by source authority, not by local path:
  `local-file`, `asset`, `agent-payload`, and `url`.
- A unified click router wired into every file-shaped surface: outliner inline
  refs, attachment/image rows, agent message file refs, agent answer attachments,
  agent persisted payloads/tool outputs, and URLs.
- Byte delivery from main to renderer through source-owned protocols/endpoints:
  path-backed files are validated before a `local://` token is minted; assets are
  served from the asset jail; agent payloads are read only through their
  conversation/run-scoped payload authority.
- Inline rendering for high-value web-native types; a metadata card + safe open
  externally for everything else.
- Cross-platform web rendering only. No QuickLook dependency and no
  OS-specific preview renderer.

## Non-goals

- **Annotation / Reader**: highlights, comments, quote insertion, and
  bidirectional anchors are deferred. The registry leaves room for later
  capability flags and per-type anchors, but this plan does not design them.
- **A long-lived artifact editor**: preview is read-only inspection plus safe
  external open/copy/reveal. Editing generated artifacts belongs to the natural
  owner: outliner nodes, file tools, or a future artifact editor.
- **Replacing inline block rendering**: `ImageRow` and `AttachmentRow` keep
  rendering files inside the outline. This plan is the destination opened from
  those rows.
- **An in-app live browser**: remote URLs are reader-mode static previews only.
  Real interactive pages belong to the browser-extension/CDP plan.
- **Embeds**: YouTube/Twitter iframes and other live embed cards are separate
  (`embed-strategy.md`). Reader-mode article extraction is not an embed.
- **High-fidelity Office rendering**: docx/xlsx/pptx are best-effort
  web-native readers. No LibreOffice or external conversion binary.
- **Back-compat migrations**: pre-release policy still applies. Do not add
  legacy readers only to preserve dev data.

## Current State And Collision Check

Run 2026-06-12:

- `gh pr list` shows #208 (`codex-3/tana-style-references`) touching reference
  derivation/UI/core files, but not this plan. Future implementation must
  re-check collision before wiring the click router because #208 changes nearby
  reference surfaces.
- `workspace-tabs-to-single-pane` shipped as PR #85. The old blocker is gone.
  The spec now records an extensibility seam for `file-preview`, but per-panel
  history is still outliner-only (`pageBackStack: NodeId[]`). PR 1 must
  generalize panel current view and history to a discriminated `PanelView`; do
  not build preview against the interim `rootId + NodeId[]` shape.
- Generalizing panel history changes the persisted workspace-layout shape. Per
  pre-release policy, PR 1 should wipe/bump the dev layout state and rewrite
  `sanitizePanel` for the new shape instead of carrying a migration reader.
- `file-attachments` shipped as PR #204 + PR #206. Attachment/image rows store
  asset ids and use `asset://`; preview must support assets directly rather than
  forcing them through original filesystem paths.
- Inline local-file hover preview/open shipped earlier. Keep the hover metadata
  popover; plain click behavior changes from OS open to in-panel preview only
  where the click router is installed. Composer editing chips remain editor
  owned and should not surprise-jump during text editing.
- Agent event storage already has `AgentPayloadRef` for large outputs, media,
  PDFs, diffs, debug payloads, and answer attachments. Agent-generated files are
  therefore first-class preview inputs, not an afterthought.
- `launcher-provider-expansion` separately tracks preview/open-original for
  capture `OriginalResourceRef` and local-file capture. File preview should
  provide the destination and target model that launcher capture can call.

## Product Model

### 1. PreviewTarget, Not Path

Every entry point normalizes to a `PreviewTarget`:

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
      kind: 'agent-payload';
      conversationId: string;
      runId?: string;
      payloadId: string;
      label?: string;
    }
  | {
      kind: 'url';
      url: string;
      label?: string;
    };
```

Rationale:

- Local files are live paths. They need realpath validation, local-root policy,
  executable/bundle denial for external open, and a tokenized `local://` URL for
  renderer fetches.
- Assets are Lin-owned stored bytes under the asset jail. Their identity is
  `assetId`; original paths may be absent, stale, or intentionally irrelevant.
- Agent payloads are event-store files with conversation/run scope. Their
  identity is `(conversationId, runId?, payloadId)`; renderer code must not
  infer payload filesystem paths.
- URLs are remote resources. Main fetches/extracts/sanitizes; renderer receives
  static reader content, never a live remote page.

### 2. PreviewSource

Main resolves a target into a renderer-facing `PreviewSource`:

```ts
type PreviewSource =
  | {
      kind: 'file';
      sourceKind: 'local-file' | 'asset' | 'agent-payload';
      id: string;
      name: string;
      ext: string;
      mimeType: string;
      entryKind: 'file' | 'directory';
      sizeBytes: number;
      lastModified?: number;
      streamUrl?: string;
      readText(): Promise<string>;
      readBytes(): Promise<ArrayBuffer>;
    }
  | {
      kind: 'url';
      id: string;
      url: string;
      title: string;
      html: string;
      byline?: string;
      siteName?: string;
    };
```

`readText` and `readBytes` are conceptual renderer API hooks; implementation can
use preload IPC or fetchable internal URLs. Large binary media must stream from
main and support Range before media preview ships.

### 3. Unified Panel Shell

A `file-preview` panel view renders the same shell for every source:

- Back pops the panel view-state stack.
- Breadcrumb/title shows source identity: display name, type, and source label
  (`Local file`, `Lin asset`, `Agent output`, `URL`).
- Primary escape hatch:
  - local file -> `shell.openPath` after path policy validation;
  - asset -> open/reveal/copy the stored asset copy after asset jail validation;
  - agent payload -> copy/export/open a temporary materialized file only through
    main-owned payload APIs;
  - URL -> `shell.openExternal` for `https?://` only.
- Loading/error/unsupported states are owned by the shell.
- Renderers may contribute a compact toolbar slot (PDF page/zoom, table sheet
  selector, etc.).

Design-system constraints: opaque content base; preview chrome is not
user-selectable; icon controls deepen by color rather than getting rounded-square
fills; respect reduced motion/transparency/contrast.

### 4. Renderer Registry

Every body is selected from the same registry:

```ts
interface PreviewRendererEntry {
  id: string;
  priority: number;
  match(source: PreviewSource): boolean;
  component: PreviewRendererComponent;
  toolbar?: PreviewToolbarComponent;
}
```

The fallback metadata card is a normal registry entry with `priority =
-Infinity`. Unsupported is a render choice, not a separate navigation path.

Initial renderers:

| Type | Renderer | Dependency | Notes |
|---|---|---|---|
| Directory | directory listing | none | local-file directories only at first; no recursive indexing |
| Text / source code | shiki read-only | already bundled | Size-capped text read; no editor |
| Markdown | react-markdown + remark-gfm + DOMPurify | DOMPurify missing today | Sanitize all HTML output |
| Images, including SVG | `<img>` from internal URL | none | SVG as image only, never inline |
| CSV / TSV | table renderer | none for first pass | Add SheetJS only when xlsx lands |
| PDF | pdf.js canvas | missing today | Local worker; same-origin internal URL |
| Audio/video | native media elements | none | Requires streaming/Range |
| Office | docx/xlsx/pptx best effort | missing/TBD | Separate PR after library verification |
| URL article | sanitized static reader HTML | defuddle/linkedom present | Remote image policy required |
| Unknown/binary | fallback metadata card | none | Open/reveal/export only |

## Routing Coverage

The click router takes `(target, clickModifiers, sourceSurface)` and dispatches:

```text
node          -> existing node navigation
local-file    -> file-preview target
asset         -> file-preview target
agent-payload -> file-preview target
url           -> url-reader target
```

Surfaces to wire:

- Outliner inline local-file refs.
- Outliner link marks (URL reader target).
- Outliner `AttachmentRow` and `ImageRow` open actions (`asset` target).
- Agent message inline file refs (`local-file` target when path-backed).
- Agent user/answer attachments with payload refs (`agent-payload` target).
- Agent persisted tool-output rows and debug/payload rows (`agent-payload`
  target where safe for normal conversation UI; debug-only payloads stay behind
  debug affordances).
- Future launcher captures via `OriginalResourceRef` (`local-file`, `asset`,
  or `url` target).

Edge cases:

- Directory targets render a directory listing, not a read error.
- Agent inline text attachments without a payload/path degrade to the existing
  inline text rendering and are not preview targets.
- Snapshot vs live path: path-backed agent references continue to preview the
  live materialized/read path, matching file tools. Agent payload refs preview
  the immutable stored payload.
- Composer chips stay edit-context controls. Plain click should not navigate
  away while editing; use hover metadata and explicit picker/actions only.
- If a target has both `path` and `payload`, prefer the identity carried by the
  visible reference: file marker path -> `local-file`; payload chip -> payload.
- Agent dock-originated clicks need an explicit host-panel rule because the dock
  is not itself a workspace panel. PR 1 must choose the focused panel, active
  panel, first panel, or split-panel behavior deliberately.

## Main-Process Authority

### `local://`

Path-backed local files use a tokenized `local://<token>` URL:

- Register as standard + secure + stream + `supportFetchAPI`.
- Do not set `bypassCSP`.
- Token maps to an absolute realpath validated in main.
- Reject missing, non-regular, symlink-escaped, NUL-containing, oversized
  memory reads, and external-open denied targets.
- Text reads are capped; binary/media streams are Range-capable before media
  ships.

### `asset://`

Assets stay on the existing `asset://<assetId>` authority:

- Asset lookup validates ids and resolves inside the asset directory.
- Media preview should add streaming/Range to asset serving before depending on
  large audio/video seeking.
- Open/reveal/copy reuse existing asset commands and local-file open policy.

### Agent payload delivery

Agent payload preview needs a new read surface rather than renderer filesystem
paths:

- Resolve by current conversation plus `payloadId`; include `runId` when needed
  to enforce scope.
- Only payloads present in replay state for the active conversation/run are
  readable.
- Text reads can reuse the existing `agent_payload_text` behavior with a preview
  cap; binary preview needs a fetchable internal URL or byte IPC with caps.
- Opening externally materializes a temporary/export file from main, never a
  renderer-supplied path.
- Debug-only payloads remain debug-scoped unless a normal conversation row
  explicitly references them.

### URL reader

- Main fetches `https?://` URLs only.
- Extract with defuddle + linkedom.
- DOMPurify all generated HTML before rendering.
- Remote images are not allowed directly by CSP. Choose one policy in the URL
  PR: proxy-through-main, inline cached images, or strip/placeholders.
- "Open original" uses `shell.openExternal` after URL validation.

## Security Checklist

- Treat every source as untrusted bytes even when Lin owns the storage.
- Keep Node out of renderer; renderer sees only internal URLs/metadata/preload
  methods.
- DOMPurify every file-to-HTML product: markdown, docx, pptx, and URL reader.
- Render SVG as `<img>`, never inline.
- Do not expose raw local paths in internal URLs.
- Do not let payload refs become arbitrary file-read handles; scope them through
  event-store replay state.
- External open is always source-aware and main-owned:
  `shell.openPath` for files/assets/materialized payload exports,
  `shell.openExternal` for validated URLs.
- Raw `.html` files render as text or fallback in v1; no trusted renderer HTML
  execution for arbitrary local HTML.
- pdf.js runs with bundled worker and no eval. If this proves too risky, isolate
  PDF rendering in a later hardening plan.

## Relationship To Plans And Specs

- `workspace-tabs-to-single-pane`: shipped PR #85. Its remaining preview
  implication is the unbuilt `PanelView` history/current-view generalization.
- `file-attachments`: shipped PR #204/#206. This plan consumes attachment/image
  assets as preview targets.
- `outliner-local-file-references`: shipped PR #80. This plan consumes
  `ReferenceTarget.local-file` and may later add `remote-url` only when URL
  references become first-class rich refs.
- `agent-conversation-model`: result routing says durable results live as nodes
  or files and replies point at them. This plan provides the file side's
  click-through destination.
- `docs/spec/agent-event-log-rendering.md`: payload refs are authoritative
  large-output storage. This plan adds user-facing preview for the payloads that
  are meant to be visible in conversation UI.
- `launcher-provider-expansion`: captures need preview/open-original for
  `OriginalResourceRef`. This plan should be the shared destination.
- `browser-extension-integration`: remote rich capture/control is separate; URL
  reader remains static preview.
- `embed-strategy`: live embeds stay separate from reader-mode URL preview.

## Open Questions

- Should `PreviewTarget.agent-payload` use a new `agent-payload://` protocol, a
  preload `readPayloadBytes` API, or a shared generic `preview://` URL? Decide in
  PR 1 after checking CSP and payload scoping.
- What is the exact export/open behavior for agent payloads: temp file, "Save
  As", or open a materialized copy under the agent local file root?
- Which workspace panel hosts a preview opened from the agent dock: focused
  panel, active panel, first panel, or always a split panel?
- URL reader remote image policy: proxy, inline cached image, or strip.
- docx renderer: mammoth (semantic) vs docx-preview (visual).
- pptx renderer library remains unverified.
- Whether URL rich refs should become `ReferenceTarget.remote-url` in PR 5, or
  stay as link marks plus router handling.

## Complete PRs

Shape (b): a set of independent complete features. Each PR must leave a usable
preview capability, not a partial scaffold. Gate per PR: protocol/shared + UI
requires ultra review plus light/dark visual verification.

PR 1 is intentionally the first usable preview feature, but it is large. If gate
risk is too high, split out **PR 0 - Panel view-state refactor** as a complete
internal refactor: rename/introduce `PanelView`, update persisted layout
sanitization with a pre-release wipe/bump, and preserve current outliner and
agent-debug behavior with tests. The preview shell then becomes PR 1 on top of
that settled shape.

- [ ] **PR 1 - Panel shell, target model, and web-native basics.**
  Generalize panel current view/history to `PanelView`; add `PreviewTarget` /
  `PreviewSource`; implement preview shell and registry; add local-file,
  asset, and agent-payload source resolution; wire outliner local-file refs,
  attachment/image rows, agent message file refs, and visible agent payload rows;
  ship directory, text/code, markdown, image, CSV/TSV, and fallback metadata
  renderers. Outcome: every file-shaped source opens the same panel, and common
  formats render.
- [ ] **PR 2 - PDF.** Add pdf.js canvas renderer over local-file, asset, and
  agent-payload sources; bundle the worker; add page/zoom toolbar; preserve
  fallback for parse failures.
- [ ] **PR 3 - Media streaming.** Add Range-capable local/asset/payload streams
  and audio/video renderers; codec failures fall back to metadata card. This also
  removes the current whole-file-read limitation for large asset media.
- [ ] **PR 4 - Office.** Add docx/xlsx/pptx best-effort renderers after library
  verification; reuse CSV/table infrastructure; sanitize all generated HTML.
- [ ] **PR 5 - URL reader.** Add URL `PreviewTarget`, main fetch/extract/sanitize,
  remote image policy, link-mark router wiring, "Open original", and optional
  `ReferenceTarget.remote-url` interface-first if first-class URL refs are needed.
