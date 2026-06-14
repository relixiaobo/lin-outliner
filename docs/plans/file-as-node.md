# File as Node

## Goal

Files (`attachment` / `image` nodes) become first-class outliner nodes. In the
outline a file is a normal **expandable** row whose **bullet is the file-type
icon** and whose **text is the (editable) filename**. Expanding the row reveals
an **inline preview block**. Clicking the node opens it as an ordinary **node
page** (NodePanel) whose body is the full-size file preview. The standalone
`file-preview` panel kind is retired for document nodes; only non-node sources
(`agent-payload` / `local-file` / `url`) keep a **lightweight info preview**.

This subsumes the earlier "make the file-preview header match the node panel"
ask — the back button + breadcrumb come from NodePanel for free.

## Non-goals

- No change to the `core/types.ts` protocol — `attachment` / `image` node types
  already exist with `assetId` / `originalFilename` / `mimeType` / `fileSize`.
- No on-disk file rename. Editing the filename edits the node's display label
  only; the stored asset is untouched.
- File nodes do not host arbitrary user child nodes yet — their expanded child
  level is the synthetic preview block.
- No data migration (pre-launch): a persisted layout holding a `file-preview`
  view whose target is a document asset is **sanitized**, not migrated.

## Design

### The model

A file's "body" is its preview, surfaced in exactly two shapes that reuse one
renderer set:

- **inline** — expanding the file row shows a bounded preview block as its
  (synthetic) child level;
- **page** — opening the file node as a NodePanel root renders the full-size
  preview as the page body.

Uniform across every file kind (image / audio / video / pdf / md / code / csv /
unknown). Images and A/V are **no longer permanently inline**; like every file
they collapse to an icon+name row and reveal their media on expand or on the
node page. Expand uses the normal per-node persisted `ui.expanded`.

### Shared preview renderers

Extract the renderer registry + helpers out of `FilePreviewPanel.tsx` into
`preview/previewRenderers.tsx`: the `FILE_PREVIEW_RENDERERS` registry (markdown /
code / image / pdf / delimited / directory / metadata), `usePreviewText`, the
source/MIME predicates, `formatBytes` / `formatModifiedDate`, and the glyph.
Three consumers:

1. file-node **page body** (full),
2. **inline preview block** (bounded height),
3. **lightweight non-node preview** (basic info only — name / type / size /
   glyph / open; no content render).

### Outline row (file node)

- `isBlockNodeType` no longer routes `attachment` / `image` to `BlockNodeRow` +
  card. They render through the normal row path with:
  - a **file-type-icon bullet** — a new `RowLeading` marker variant driven by
    `inlineFileIconKind` (image nodes may show a tiny thumbnail when one exists);
  - **filename text** — the row editor shows `content.text`, falling back to
    `originalFilename` when empty; editing writes `content.text` (display label).
- The row is expandable whenever the file resolves to a preview body. The
  chevron toggles `ui.expanded`; expansion renders the synthetic preview block.
- The old `AttachmentRow` card (open / reveal / copy actions + meta) is retired
  from the row; those actions move to the node-page header. The always-inline
  `ImageRow` behavior is removed from the row (the image shows in the preview
  block / page).

### Inline preview block

- A **synthetic child row** under an expanded file node, built in `row-model.ts`
  (a `preview-block` row kind keyed off the file node id) and rendered by a new
  `FilePreviewBlock` on top of `OutlinerRowShell` / `OutlinerPreviewRow`.
- Bounded max-height with internal scroll; not editable; not text-selectable as
  outline content. Derived from the file node, like other synthetic rows — never
  a persisted node.

### Node page (file node as NodePanel root)

- `NodePanel` detects a file root node (attachment / image) and renders a
  `<FilePreviewBody>` (full renderers) instead of the outliner body. The title
  editor (filename), breadcrumb, back control, and backlinks stay.
- The header gains a file **action group** (open / reveal-in-Finder / copy) and a
  **meta line** (type · size · pages · modified).
- Navigation: the file row's open affordances (click-to-zoom, the "Open in split
  pane" context item) call `onRoot(nodeId, { newPane? })` — no longer
  `dispatchPreviewTargetOpen`. All node navigation (panes, history, breadcrumb)
  then works for free.

### Retiring file-preview for document nodes

- `dispatchPreviewTargetOpen` callers that hold a **document node** (the
  attachment row) switch to `onRoot(nodeId)`.
- Callers that hold only a **non-node source** (agent tool-call `agent-payload`,
  inline `local-file`, `url`) keep dispatching; the `file-preview` panel now
  renders the **lightweight info preview**.
- The `file-preview` PanelView, its `useWorkspaceLayout` helpers, and the
  `WorkspaceCanvas` branch stay, but render the lightweight panel. The layout
  sanitizer drops any persisted file-preview view whose target is a document
  asset (pre-launch — no migration).

### Filename ⇄ node text

- Display: `content.text || originalFilename`.
- Edit: writes `content.text` through the existing text-patch command path (no
  new core command).
- Agent / ingest-created attachments already set `originalFilename` and may leave
  `content.text` empty → display falls back. Verify the F4 ingest, paste, and
  drop ingest paths set a sensible label or rely on the fallback.

## Open questions

- Inline preview block height cap, and whether very large / binary files
  inline-render or show only an "open as page" affordance. Lean: cap ~40vh with
  scroll; pdf / media render compact.
- Image bullet: plain file glyph vs tiny thumbnail. Lean: thumbnail when a
  `thumbnailAssetId` exists, else the glyph.
- Whether a file node may also carry real user child notes later (out of scope
  now).

## Build order (single PR)

This is one complete feature; the steps are build-order within the PR
(foundation before consumers, A7), not separate releases.

1. Extract shared `preview/previewRenderers`.
2. File-node row: file-icon bullet + editable filename; retire the card;
   navigation → node page.
3. NodePanel file body + header action group / meta line.
4. Inline expandable preview block (row-model synthetic child + `FilePreviewBlock`).
5. Lightweight non-node `FilePreviewPanel`.
6. Layout sanitize; tests (row-model, NodePanel file body, navigation, guards);
   spec sync (`workspace-layout.md`, fold `file-preview.md`, `ui-behavior` notes).
