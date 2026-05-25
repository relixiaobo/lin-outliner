---
status: draft
priority: P1
owner: relixiaobo
created: 2026-05-25
updated: 2026-05-25
---

# Image Rendering

Render `image`-type nodes inline in the outliner using the asset subsystem.
Today the `image` NodeType exists in `src/core/types.ts` and the
`mediaUrl / imageWidth / imageHeight / mediaAlt` fields persist, but no
component renders the image — the row falls through to the normal text path.
nodex ships `ImageNodeRenderer.tsx`; lin does not.

Depends on [`asset-subsystem.md`](asset-subsystem.md).

## Goal

- Render `image` nodes inline with the captured intrinsic dimensions.
- Support paste-image-from-clipboard, drag-image-from-Finder, and slash
  command "insert image" → file picker.
- Persist via the asset subsystem (no URLs, no base64 in Loro).

## Non-goals

- Image editing (crop, rotate, adjust). v1 is display-only.
- Multi-image galleries on a single node. Each image is its own node.
- Resizing handles in the renderer. v1 just respects intrinsic size with a
  max-width cap.
- Remote image URLs (web clip / hotlinked). Defer to embed strategy.

## Design

### Node shape

```ts
{
  id,
  type: 'image',
  assetId: string,        // replaces mediaUrl as the source of truth
  imageWidth?: number,    // captured at ingest (asset metadata)
  imageHeight?: number,
  mediaAlt?: string,      // editable in the row
  // No mediaUrl, no path. The asset subsystem owns the bytes.
}
```

Migration: `mediaUrl` may currently be empty or unused. If any real image
nodes exist in workspaces, write a one-shot migration that, for each
`type: 'image'` node with `mediaUrl`, ingests the URL via the asset service
and sets `assetId`. Drop `mediaUrl` from the schema once migration ships.

### Renderer

New `ImageRow.tsx` (or branch inside `OutlinerItem.tsx`) for `type ===
'image'`:

```tsx
<img
  src={`lin-asset://${node.assetId}`}
  alt={node.mediaAlt ?? ''}
  width={node.imageWidth}
  height={node.imageHeight}
  className="outliner-image"
  loading="lazy"
/>
```

CSS: `max-width: 100%; height: auto;`. Tap target wraps the image so click
focuses the row.

Alt-text editing: tiny text field below the image, only visible when row is
focused.

### Ingest flows

- **Paste**: `pmSchema.ts` already routes paste through the rich text editor;
  intercept `clipboard.items` for image MIME types and call `ingest_asset`,
  then `create_node({ type: 'image', assetId, ...meta })` as a sibling of
  the current row.
- **Drag-drop** from Finder: handle on `OutlinerView` container; for each
  image file, ingest then create node.
- **Slash command `/image`**: opens native file picker → ingest → create
  node.

### Trash/restore

Image nodes participate in normal trash/restore. The asset behind a trashed
image node is **not** deleted from the asset store — preserves restore. The
asset GC plan (in `asset-subsystem.md` V2) handles eventual cleanup.

## Open questions

- Should max display width be a per-user setting? Probably not in v1 — pick
  a sensible default (e.g. 640px) and let users zoom the workspace if
  desired.
- HEIC / AVIF support — depends on what Electron's Chromium ships. Confirm
  before claiming.
- Should the row support a caption? nodex doesn't; treating the row's text
  as caption is implicit but workable.

## Implementation sketch

1. Add `assetId?: string` to the image branch of `Node` in `src/core/types.ts`.
   Keep `mediaUrl?: string` reserved (or remove if embed-strategy says so).
2. New core command `create_image_node({ parentId, index, assetId, width,
   height, alt })`.
3. Renderer interaction: paste/drop/slash handlers calling
   `ingest_asset` + `create_image_node`.
4. New `ImageRow.tsx` rendered when `node.type === 'image'`.
5. E2E test: paste image → verify `<img>` with `lin-asset://` src renders.

## Test plan

- Core: `create_image_node` produces a valid projection entry; trash/restore
  preserves `assetId`.
- E2E: paste image into a row; reload; verify it still renders.
- E2E: drag image file from a test fixture path; verify ingest and render.
