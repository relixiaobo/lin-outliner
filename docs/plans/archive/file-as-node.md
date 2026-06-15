# File as Node

## Goal

Files (`attachment` / `image` nodes) become first-class outliner nodes. In the
outline a file is a **normal node** with a plain node-handle bullet: the chevron
expands its **children**, and it can be moved, referenced, pinned, and opened in a
split pane. Its row is **click-to-open** with a non-editable filename. Its row
**content** depends on the kind: a non-image file renders a uniform **file card**
(file-type icon · display-only filename · meta · `⋯` menu); an **image** renders
the image **itself** inline (an image's content is its identity) with no card and
no filename. Its preview is not inline — it is the **hero** of the file's **node
page** (NodePanel), shown above the node's children outline. The standalone
`file-preview` panel kind is retired for document nodes;
it now serves only non-node sources (`agent-payload` / `local-file` / `url`),
reusing the same node-page preview body and offering "add to outline".

This subsumes the earlier "make the file-preview header match the node panel"
ask — the back button + breadcrumb come from NodePanel for free.

## Non-goals

- No change to the `core/types.ts` protocol — `attachment` / `image` node types
  already exist with `assetId` / `originalFilename` / `mimeType` / `fileSize`.
- No on-disk file rename. The filename is the node's display label (renamed on the
  node-page title, not inline); the stored asset is untouched.
- No data migration (pre-launch): a persisted layout holding a `file-preview`
  view whose target is a document asset is **sanitized**, not migrated.

## Design

### The model

A file node is a normal node, with no special-casing of the chevron, children, or
trailing draft. The bullet is the **plain content handle** (drilling it opens the
node page like any node); the row is **click-to-open** and the filename is never
edited inline. The file-ness lives in the row **content** and the node page:

- **file card** (non-image) — the row content is a uniform card: a file-type icon
  (driven by `fileNodeIconKind`), the display-only filename on a single truncated
  line, a `type · size · pages/duration` meta line (`fileNodeMeta`), and a `⋯`
  menu. Clicking the card opens the node page (the preview). The leading
  bullet/chevron stay on the row, so it is still a full node.
- **inline image** — an image node renders the image **itself** as the row content
  (a bounded `<img>`) instead of a card: no file-type icon, no filename. Its `⋯`
  menu floats at the image's top-right (hover-revealed). Clicking the image
  maximizes it (opens the node page).
- **keyboard parity** — neither presentation has a visible editor, so the filename
  editor still mounts, visually hidden (`sr-only`), as the row's focus target: arrow
  nav, Enter to add a sibling, etc. keep working. (`readOnly` editors aren't
  keyboard-focusable — focus uses `view.dom.focus()`, which needs `contenteditable`
  — so the anchor stays editable but off-screen.)
- **`⋯` action menu** — a type-specific primary action — **Maximize** for an image
  (open the node page) or **Open in split** for other files (open it in a split
  pane) — plus **Reveal in Finder** (the stored asset).
- **node page** — the file's preview is the page **hero**: the rendered file with
  a meta + actions strip, above the node's children outline. This is the single
  full-preview surface (plus split-pane peek). There is no inline preview block.

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
`fileNodeIconKind`, `fileNodeMeta`, `formatBytes`) and the row-content components
(`FileNodeCard`, `FileNodeImage`, shared `FileNodeActionMenu`) carry no heavy
deps, so the outliner hot path stays cheap; `previewRenderers` (shiki / pdf.js /
markdown) is imported only by the page body and the pane.

### Outline row (file node)

- `attachment` / `image` render through the **normal row path** (no `BlockNodeRow`
  routing). The shared `rowEditorElement` (the row's text editor) is extracted so a
  file node can wrap it in its card chrome while every other node renders it bare.
  The bullet is the plain `content` leading variant; the dead `RowLeading` / `RowMarker`
  `file` variant is removed.
- A **non-image** file wraps `rowEditorElement` (the filename editor) in
  `<FileNodeCard>` — icon + filename + meta + `⋯` menu. CSS keeps the filename a
  single truncated line; editing writes `content.text` (display label only).
- An **image** renders `<FileNodeImage>` as the row content (the bounded `<img>`,
  read through the sandboxed preview API → object URL) plus a hidden
  (`sr-only`) `rowEditorElement` for keyboard parity. Click → `onRoot(nodeId)`.
- The chevron, children, and trailing draft are the **default** node behavior —
  no `previewExpandable` / leaf special-casing in `useOutlinerRowInteraction` or
  `visualRows`. A childless file node is a leaf; a file node with children expands.
- The old `AttachmentRow` card and always-inline `ImageRow` behavior are retired;
  open / reveal / copy + meta move to the node-page preview hero (and the `⋯` menu).

### Node page (file node as NodePanel root)

- `NodePanel` detects a file root node and renders `<FilePreviewBody>` (full
  renderers) as the page **hero**, then the normal children `OutlinerView` below
  it (`showOutliner` is true for a file root, with a trailing draft to add notes).
  Title editor (filename), breadcrumb, back control, and backlinks stay.
- The hero carries the file **action group** (open / reveal-in-Finder / copy) and
  a **meta line** (type · size · pages · duration).
- Navigation: the file row's bullet, the card body / inline image click, and the
  `⋯` menu's primary action all call `onRoot(nodeId, { newPane? })` — never
  `dispatchPreviewTargetOpen`. The image's **Maximize** and the card click open in
  the current panel; the card's **Open in split** passes `{ newPane: true }`. All
  node navigation (panes, history, breadcrumb) then works for free.

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
3. File-node row content: a uniform `FileNodeCard` (icon + filename + meta + `⋯`
   menu) for non-image files; `FileNodeImage` (inline image) for images; plain
   bullet; navigation → node page.
4. Non-node `FilePreviewPanel` reuses the node-page body + "add to outline".
5. Layout sanitize; tests (row interaction, NodePanel file body, navigation,
   add-to-outline, file card + inline image, guards); spec sync
   (`workspace-layout.md`, `ui-behavior.md`).
