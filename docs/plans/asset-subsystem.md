---
status: draft
priority: P0
owner: relixiaobo
created: 2026-05-25
updated: 2026-05-25
---

# Asset Subsystem

Local-first asset store for binary content (images, files, banner art, future
audio/video). Loro stores stable asset IDs; the actual bytes live on disk in
the user data directory. The renderer loads assets through a custom
`lin-asset://` protocol served by the Electron main process.

This plan blocks `image-rendering.md`, `file-attachments.md`, and the
metadata-cached variant of `embed-strategy.md`.

## Why this is the right shape for a local app

- nodex stores `mediaUrl: string`. That works in a browser extension where the
  only persistence layer is IndexedDB. For an Electron app, encoding URLs (or
  worse, base64) into Loro is a regression: it ties the CRDT document to
  ephemeral or environment-specific strings, bloats document size, and
  prevents the eventual sync layer from streaming assets out-of-band.
- A content-addressed or UUID-keyed store decouples three concerns: identity
  in the document, bytes on disk, and how the renderer loads them.

## Goal

- Add an `AssetService` in `src/main/` that owns asset files under
  `<userData>/assets/<id>.<ext>` plus a metadata sidecar.
- Register a `lin-asset://<id>` custom protocol so the renderer can load
  assets with regular `<img>`/`<video>`/`<a>` tags.
- Provide IPC commands for asset ingest (paste, drag from Finder, file
  picker), lookup by id, and explicit deletion.
- Define the Loro schema for referencing assets (asset IDs only — no URLs,
  no paths, no base64).

## Non-goals

- Sync of assets across devices. Defer to whatever sync layer arrives later;
  the asset IDs are the sync handles, the bytes are a separate channel.
- Cloud storage, signed URLs, or third-party CDNs.
- Image transforms (resize, crop) beyond a single thumbnail. Done in renderer
  with CSS; do not bake variants into the store yet.
- Encryption at rest.

## Design

### Storage layout

```txt
<userData>/lin/assets/
  <id>.<ext>            // raw bytes (extension is informational only)
  <id>.meta.json        // metadata sidecar
```

`<id>` is a 21-char nanoid. Extension is derived from the detected MIME at
ingest time and is not part of the asset's identity.

Metadata sidecar shape:

```ts
interface AssetMetadata {
  id: string;
  mimeType: string;
  byteSize: number;
  originalFilename?: string;
  createdAt: number;
  // Optional, type-specific:
  imageWidth?: number;
  imageHeight?: number;
  audioDurationMs?: number;
  videoDurationMs?: number;
}
```

A single index file `<userData>/lin/assets/index.json` is rebuilt from the
sidecars on startup if missing. Sidecars are authoritative.

### Custom protocol

Register in main process before the first `BrowserWindow`:

```ts
protocol.registerSchemesAsPrivileged([
  { scheme: 'lin-asset', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: false } },
]);
// then in app.whenReady:
protocol.handle('lin-asset', async (req) => {
  const id = new URL(req.url).hostname; // lin-asset://<id>
  return assetService.serve(id);
});
```

Renderer usage:

```tsx
<img src={`lin-asset://${node.assetId}`} alt={node.mediaAlt ?? ''} />
```

`serve(id)` streams the file with the recorded MIME. Missing assets return
404 with a stable error body so the renderer can show a placeholder.

### IPC commands

Add to `DOCUMENT_COMMANDS` (or a new `ASSET_COMMANDS` set — to decide):

- `ingest_asset` — main receives a `Buffer | NativeImage | { path }`,
  computes MIME, picks an extension, writes file + sidecar, returns the new
  asset id + metadata. Used by paste, drag-from-Finder, and the file picker.
- `lookup_asset` — return metadata for an id.
- `delete_asset` — explicit removal. Reference counting is out of scope for v1;
  see "Garbage collection" below.

### Loro schema

The node-level fields stay as strings, but their semantics change:

- `bannerAssetId?: string` — already in `types.ts`. Already correct shape.
- For image nodes (see `image-rendering.md`), replace `mediaUrl` usage with
  an `assetId` field. Keep `mediaUrl` reserved for true external URLs (web
  clip cards), or remove it once embed-strategy resolves.
- New nodes referencing assets must put the id directly on the node.
  Never put paths or `file://` URLs into Loro.

### Renderer ingest paths

1. **Paste from clipboard** — clipboard image event in editor → IPC
   `ingest_asset` with the image buffer → assetId → insert image node /
   apply banner.
2. **Drag from Finder / desktop** — Electron's drop handler in renderer reads
   `event.dataTransfer.files[i].path` → IPC `ingest_asset` with the path →
   assetId. The main process copies the file in.
3. **File picker** — `dialog.showOpenDialog` in main → for each path,
   `ingest_asset` → return list of asset ids.

All three paths converge on `ingest_asset(payload)`.

### Garbage collection

V1: do not GC. Assets are cheap; explicit `delete_asset` only removes when
the caller knows the asset is no longer referenced (e.g., `set_node_banner`
to null with an "also delete asset" flag, only if the asset is not referenced
elsewhere).

V2 (later, in its own plan): periodic sweep that finds all `*AssetId` fields
across the projection and removes orphan files. Sweep should be off the hot
path.

## Open questions

- Should ids be content-addressed (sha256 of bytes) or random nanoids?
  Content addressing dedupes identical images (pasted twice) automatically
  but makes the protocol path leak content hashes. **Tentative:** random
  nanoid; revisit if dedup pressure shows up.
- Where does the user data root come from in dev vs packaged builds? Likely
  `app.getPath('userData')` plus a `lin/` subdirectory; confirm against the
  existing layout in `src/main/main.ts` and the Loro snapshot location.
- Should `agent-secrets.json` and `assets/` live as siblings under the same
  `lin/` root? Audit existing on-disk layout before deciding.

## Implementation sketch

1. New file `src/main/assetService.ts`: AssetService class with `ingest`,
   `serve`, `lookup`, `delete`, plus sidecar read/write helpers and the
   startup index rebuild.
2. Register `lin-asset` scheme + protocol handler in `src/main/main.ts`
   before window creation.
3. Wire IPC dispatch in `src/main/documentService.ts` (or a new asset
   dispatcher).
4. Add command names to `src/core/commands.ts` and renderer entries in
   `src/renderer/api/client.ts`.
5. Replace the `window.prompt` placeholder in
   `src/renderer/ui/outliner/NodeContextMenu.tsx` (banner) with a real
   ingest flow.
6. Add core tests for sidecar round-trip and protocol routing.
7. Add an E2E test that pastes an image into a row, verifies it renders, and
   reloads the app to confirm persistence.

## Test plan

- Unit: AssetService ingest+lookup+delete; sidecar resilience to missing
  index; MIME detection.
- E2E: paste image → banner set → restart → image still resolves.
- Failure modes: missing file at protocol time → renderer shows placeholder;
  asset with corrupted sidecar → AssetService logs and falls back to MIME
  guess from extension.
