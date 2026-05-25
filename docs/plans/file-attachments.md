---
status: draft
priority: P1
owner: relixiaobo
created: 2026-05-25
updated: 2026-05-25
---

# File Attachments

Add a generic `attachment` node type for any local file: PDFs, audio, video,
documents, source files. nodex cannot support this well — browser extensions
choke on multi-MB IndexedDB storage and can't reveal in Finder. Lin can,
because it is Electron.

This is a deliberate **superset** of nodex, not a parity feature. It is
listed in [`nodex-parity-decisions.md`](nodex-parity-decisions.md) as a
local-app-specific extension.

Depends on [`asset-subsystem.md`](asset-subsystem.md).

## Goal

- New `attachment` NodeType representing an arbitrary file.
- Drag from Finder, paste from clipboard (Finder-copy file), file picker.
- Display per MIME class:
  - Image MIME types route to `image` node creation (see
    `image-rendering.md`) — do not create an attachment with an image MIME.
  - PDF: inline first-page thumbnail + filename + page count, click opens
    Quick Look or system default.
  - Audio: inline `<audio controls>` player.
  - Video: inline `<video controls>` player with poster.
  - Other (zip, doc, code, etc.): file card with icon + filename + size +
    "Reveal in Finder" / "Open with default app" buttons.

## Non-goals

- Built-in PDF viewer beyond a thumbnail. Use the OS.
- Built-in zip browser, hex viewer, etc.
- Cloud-stored attachments. Local-only for v1.
- Format conversion.

## Design

### Node shape

```ts
{
  id,
  type: 'attachment',
  assetId: string,
  mimeType: string,
  originalFilename: string,
  fileSize: number,
  // Optional derived:
  audioDurationMs?: number,
  videoDurationMs?: number,
  pdfPageCount?: number,
}
```

All of these except `assetId / mimeType / originalFilename / fileSize` are
derived once at ingest by the AssetService and cached on the node so the
renderer doesn't probe the file on every render.

### Display dispatch

Single `AttachmentRow.tsx` switches on `mimeType`:

```tsx
if (mimeType.startsWith('audio/')) return <AudioAttachment ... />;
if (mimeType.startsWith('video/')) return <VideoAttachment ... />;
if (mimeType === 'application/pdf') return <PdfAttachment ... />;
return <GenericFileCard ... />;
```

Each branch is small. `lin-asset://<id>` works for `<audio>`, `<video>`, and
PDF embeds.

### PDF thumbnail

AssetService renders page 1 to PNG at ingest via the existing `pdftoppm`
binary the agent file tools already depend on (see `agent-progress.md`
"local tool capability parity pass"). Cache the thumbnail as a second
asset id stored in the sidecar of the source asset. The renderer loads the
thumbnail via `lin-asset://<thumbnail-id>`.

### System integration

Right-click on an attachment row offers:

- **Open** — `shell.openPath(filepath)`.
- **Reveal in Finder** — `shell.showItemInFolder(filepath)`.
- **Copy file** — `clipboard.writeBuffer('NSFilenamesPboardType', ...)` so
  the file can be pasted into other apps.

These are Electron features unavailable to nodex.

### Ingest paths

Same three as images: paste, drag, file picker. The dispatcher routes:

- `mimeType.startsWith('image/')` → image node (see image-rendering plan).
- otherwise → attachment node.

## Open questions

- Audio/video duration probing: use ffprobe if installed, or `<audio>`
  metadata load? Probably the latter, populated lazily by the renderer once
  on creation.
- Should attachment rows be expandable to show inline preview/metadata, or
  is the always-on card enough? v1: always-on card.
- Maximum attachment size warning threshold (e.g. 500 MB). Show but allow.

## Implementation sketch

1. Add `'attachment'` to `NodeType` and the new fields to `Node`.
2. Core command `create_attachment_node({ parentId, index, assetId,
   mimeType, originalFilename, fileSize, ...metadata })`.
3. AssetService extension: PDF page-1 thumbnail generation, audio/video
   duration probe.
4. Renderer `AttachmentRow.tsx` + sub-components.
5. Drop-zone in OutlinerView container that routes non-image files to
   attachment creation.
6. Context menu items for Open / Reveal / Copy file.

## Test plan

- Core: `create_attachment_node` produces a valid projection.
- E2E: drop a PDF fixture, verify thumbnail + page count render; click
  Open, verify `shell.openPath` is invoked (mock the shell in test).
- E2E: drop an audio fixture, verify `<audio>` renders with `lin-asset://`
  src.
- Smoke: a 100 MB attachment ingests in reasonable time and renders
  without locking the UI.
