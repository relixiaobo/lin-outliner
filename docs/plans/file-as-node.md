# File as Node

## Goal

Files (`attachment` / `image` nodes) become first-class outliner nodes. In the
outline a file is a **normal node** whose **bullet is the file-type icon** and
whose **text is the (editable) filename**. It behaves like any node: the chevron
expands its **children**, and it can be moved, referenced, pinned, and opened in a
split pane. Its preview is not inline — it is the **hero** of the file's **node
page** (NodePanel), shown above the node's children outline. The one inline
affordance is a bounded **row-level thumbnail for image nodes** (an image's
content is its identity). The standalone `file-preview` panel kind is retired for
document nodes; it now serves only non-node sources (`agent-payload` /
`local-file` / `url`), reusing the same node-page preview body and offering "add
to outline".

This subsumes the earlier "make the file-preview header match the node panel"
ask — the back button + breadcrumb come from NodePanel for free.

## Non-goals

- No change to the `core/types.ts` protocol — `attachment` / `image` node types
  already exist with `assetId` / `originalFilename` / `mimeType` / `fileSize`.
- No on-disk file rename. Editing the filename edits the node's display label
  only; the stored asset is untouched.
- No data migration (pre-launch): a persisted layout holding a `file-preview`
  view whose target is a document asset is **sanitized**, not migrated.

## Design

### The model

A file node is a normal node, with no special-casing of the chevron, children, or
trailing draft. Its file-ness is expressed in three places:

- **bullet** — a file-type glyph (`RowLeading` `file` variant, driven by
  `fileNodeIconKind`); drilling it opens the node page like any node.
- **node page** — the file's preview is the page **hero**: the rendered file with
  a meta + actions strip, rendered above the node's children outline. This is the
  single full-preview surface (plus split-pane peek). There is no inline preview
  block in the outline.
- **image thumbnail** — an image node additionally renders a bounded row-level
  `<img>` under its filename (part of the row, not a child block, so it never
  collides with the chevron's children). Clicking it opens the node page.

Uniform across non-image kinds (audio / video / pdf / md / code / csv / unknown):
they are plain icon + filename rows; their content shows on the node page or a
split-pane peek.

### Shared preview renderers

The renderer registry + helpers live in `preview/previewRenderers.tsx`: the
`FILE_PREVIEW_RENDERERS` registry (markdown / code / image / pdf / delimited /
directory / metadata), `usePreviewSource` / `usePreviewText`, the source/MIME
predicates, `formatBytes` / `formatModifiedDate`, and the shared body shell
`FilePreviewShell` (a `meta · actions` toolbar over the rendered content). Two
consumers, reading identically:

1. the file-node **page body** (`FilePreviewBody` → `FilePreviewShell`);
2. the **non-node preview pane** (`FilePreviewPanel` → `FilePreviewShell`).

The light `preview/fileNode.ts` (`isFileNode`, `fileNodeTarget`,
`fileNodeIconKind`) and `preview/ImageThumb.tsx` carry no heavy deps, so the
outliner hot path stays cheap; `previewRenderers` (shiki / pdf.js / markdown) is
imported only by the page body and the pane.

### Outline row (file node)

- `isBlockNodeType` no longer routes `attachment` / `image` to `BlockNodeRow` +
  card. They render through the normal row path with:
  - a **file-type-icon bullet** (`RowLeading` `file` variant);
  - **filename text** — the row editor shows `content.text`, falling back to
    `originalFilename` when empty; editing writes `content.text` (display label).
- The chevron, children, and trailing draft are the **default** node behavior —
  no `previewExpandable` / leaf special-casing in `useOutlinerRowInteraction` or
  `visualRows`. A childless file node is a leaf; a file node with children expands
  to show them.
- An **image** file node renders `<ImageThumb>` inside `row-content-line`, below
  the filename. It reads bytes through the sandboxed preview API → a bounded
  `<img>`; click → `onRoot(nodeId)` (open the node page).
- The old `AttachmentRow` card and always-inline `ImageRow` behavior are retired;
  open / reveal / copy + meta move to the node-page preview hero.

### Node page (file node as NodePanel root)

- `NodePanel` detects a file root node and renders `<FilePreviewBody>` (full
  renderers) as the page **hero**, then the normal children `OutlinerView` below
  it (`showOutliner` is true for a file root, with a trailing draft to add notes).
  Title editor (filename), breadcrumb, back control, and backlinks stay.
- The hero carries the file **action group** (open / reveal-in-Finder / copy) and
  a **meta line** (type · size · pages · duration).
- Navigation: the file row's bullet and the image thumbnail call
  `onRoot(nodeId, { newPane? })` — never `dispatchPreviewTargetOpen`. All node
  navigation (panes, history, breadcrumb) then works for free.

### Retiring file-preview for document nodes

- Callers that hold a **document node** open it via `onRoot(nodeId)`.
- Callers that hold only a **non-node source** (agent `agent-payload`, inline
  `local-file`, `url`) keep dispatching; the `file-preview` panel renders the
  shared preview body (full content, identical to the node page) inside a pane
  with a filename header + Back.
- The non-node preview offers **add to outline** for ingestible kinds
  (`local-file` full-file ingest, `agent-payload` bounded byte read; not `url`):
  it copies the source into the asset store, creates a file node under Today, and
  navigates the pane to the new node page. The pane reaches App's document state
  through a single-handler request bridge (`previewIngest`, mirroring
  `agentFileInsert`); no new command surface — anything the preview can resolve it
  can ingest, behind the same security boundary.
- The `file-preview` PanelView, its `useWorkspaceLayout` helpers, and the
  `WorkspaceCanvas` branch stay. The layout sanitizer drops any persisted
  file-preview view whose target is a document `asset` (pre-launch — no
  migration); `asset` stays in the `PreviewTarget` union because the file-node
  body resolves its preview source through it.

### Filename ⇄ node text

- Display: `content.text || originalFilename`.
- Edit: writes `content.text` through the existing text-patch command path (no
  new core command).
- Agent / ingest-created attachments already set `originalFilename` and may leave
  `content.text` empty → display falls back.

## Open questions

- Whether `url` sources become ingestable ("add to outline") once a URL reader
  ships. Out of scope now.

## Build order (single PR)

This is one complete feature; the steps are build-order within the PR
(foundation before consumers, A7), not separate releases.

1. Extract shared `preview/previewRenderers` + `FilePreviewShell`.
2. NodePanel renders a file root's preview hero above its children outline.
3. File-node row: file-icon bullet + editable filename; retire the card;
   navigation → node page; image row-level thumbnail.
4. Non-node `FilePreviewPanel` reuses the node-page body + "add to outline".
5. Layout sanitize; tests (row interaction, NodePanel file body, navigation,
   add-to-outline, image thumbnail, guards); spec sync (`workspace-layout.md`,
   `ui-behavior.md`).
