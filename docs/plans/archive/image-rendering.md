---
status: done
priority: P1
owner: relixiaobo
created: 2026-05-25
updated: 2026-06-03
shipped: PR #8, #10
---

> **Status close-out (2026-06-03).** Shipped: inline `image` nodes on the shared
> `BlockNodeRow` shell, clipboard/`/image` ingest, caption-as-description, and
> the hover toolbar (PR #8); the dual local-`assetId` / remote-`mediaUrl` source
> model + `asset://` rename (PR #10). Deferred items live in follow-on backlog
> plans: drag-from-Finder + inline alt-text → `asset-gc`; remote-media
> content-type autodetect → `media-types`. (The deferred CSP was since shipped
> independently by native-feel stage 1, PR #43.) Kept in `docs/plans/` (not
> archived) because active plans (`file-preview`, `file-attachments`) link it by
> path and its design is not yet folded into `docs/spec/` (open A6 debt).

# Image Rendering

> **Progress (branch `cc/asset-subsystem-images`).** `image` nodes carry an
> `assetId` (plus `imageWidth`/`imageHeight`/`mediaAlt`).
>
> **Architecture.** Non-text "block" nodes (image today; attachments / embeds /
> media players later) render through a shared focusable shell,
> `BlockNodeRow.tsx`, which *replaces* the row's text editor (the way
> `CodeBlockRow` does) rather than sitting beside a hidden one. The shell owns
> the one shared interaction contract — focus-request handshake and
> caret-less keyboard nav (↑↓ move, Enter opens a sibling, Backspace removes the
> block, Tab indents, Esc/Shift+Arrow exit to selection) — and dispatches the
> presentational body by `node.type` in `renderBlockBody`. `isBlockNodeType`
> gates the row in `OutlinerItem`. Adding a type later = one `case` + one view
> component; `OutlinerItem` is untouched. The image view is `ImageRow.tsx`
> (purely presentational: `<img>` + hover toolbar + lightbox).
>
> **Caption.** A block node's caption is its `description` field, added on demand
> via the toolbar's "Add caption" button and rendered below as a
> `NodeDescription` — there is no always-visible caption line and no hidden text
> editor. The hover toolbar (caption / fullscreen / open-original) follows the
> design-system floating-control grammar: inverse surface, overlay shadow, no
> outer border, tokenized sizes.
>
> Core commands `createImageNode` + `setNodeImage` (convert in place) with
> `create_image_node` / `set_node_image` IPC. Ingest paths shipped: clipboard
> paste (image items) and the `/image` slash command (native file picker); both
> land the image on the current row when it is plain and childless rather than
> spawning an empty sibling.
>
> **Dual source (local + remote).** An image node's source is exactly one of a
> local `assetId` (served via the `asset://` privileged protocol — renamed from
> `lin-asset://`; the bare id is what persists, so no migration) or a remote
> `mediaUrl`. `mediaSource(node)` resolves either into a `{ src, isRemote }` the
> view loads; `isBlockNodeType` accepts either. Pasting a lone remote image URL
> (no active selection) creates a remote image node (`imageUrlFromText` +
> `onPasteMediaUrl`). "Open original" routes to the OS app for local, the
> browser for remote (`open_external_url`, http(s)-only). `ingest_asset` over
> IPC is buffer-only (path ingest stays main-process-internal).
>
> **Deferred:** drag-from-Finder; inline alt-text editing; remote-media
> autodetect by content-type (HEAD) rather than extension; and **a
> Content-Security-Policy** — none ships today, and direct remote `<img>`/
> `<video>` is inert (no script execution), but a CSP (`img-src`/`media-src`
> `asset:`/`https:`, `script-src 'self'`) should be added and verified against a
> packaged build, since dev (HMR) and prod (`file://`) need different directives.

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
  src={`asset://${node.assetId}`}
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
5. E2E test: paste image → verify `<img>` with `asset://` src renders.

## Test plan

- Core: `create_image_node` produces a valid projection entry; trash/restore
  preserves `assetId`.
- E2E: paste image into a row; reload; verify it still renders.
- E2E: drag image file from a test fixture path; verify ingest and render.
