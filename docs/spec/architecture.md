# Tenon Architecture

Tenon is a clean rebuild of the nodex outliner experience.

The repository does not carry migrated nodex product code. nodex remains an
external behavior reference only.

## Runtime Boundaries

- `src/core`: pure TypeScript outliner state machine.
- `src/main`: Electron main process, persistence, IPC command bridge, and agent runtime.
- `src/preload`: narrow Electron preload bridge exposed as `window.lin`.
- `src/renderer`: React view and interaction layer.

There is no Rust, Cargo, Tauri, or `src-tauri` product runtime in this repository.
Document state, agent tools, parser logic, preview/validation, and persistence
are all implemented in TypeScript.

The TypeScript core is the only document writer. React keeps UI-only state such
as focus, expanded rows, selection, popovers, and transient editor drafts.

Binary assets are outside the CRDT document. The document stores stable asset
ids and derived metadata on `image` / `attachment` nodes; `src/main/assetService`
owns bytes and sidecar metadata under the workspace asset directory. Renderer
flows ingest files through asset commands, then mutate the document only through
core commands such as `create_image_node`, `set_node_image`, and
`create_attachment_node`.

The asset directory is treated as a local-file jail. Path-backed ingest resolves
the source with `realpath` and accepts regular files only. Asset reads and system
actions resolve the stored file with `realpath`, require the result to remain
inside the asset root, and reject missing, non-file, or escaped paths before the
renderer can serve, open, reveal, or copy the asset.

## Command Flow

```txt
React interaction
  -> preload IPC command
  -> Electron main document service
  -> TypeScript core mutation
  -> persisted workspace snapshot
  -> ProjectionUpdate (delta | full) folded into the renderer index
```

No renderer module may directly mutate document state. UI changes that affect
document content or tree structure must use commands.

## Projection Updates (incremental delta)

The renderer holds its projection index across edits and folds **change sets**
into it, instead of receiving and re-deriving the whole document each mutation.
Per-edit cost scales with what changed, not document size.

- **Wire type** (`src/core/types.ts`): `ProjectionUpdate` is a discriminated
  union — `{ kind: 'full'; revision; projection }` for init / resync / whole-tree
  rewrites, or `{ kind: 'delta'; revision; todayId; changedNodes; removedIds }`
  for normal mutations. Both renderer-facing payloads carry it: a command's
  `CommandResult.update` and the `DocumentProjectionChangedEvent.update`.
- **Main boundary builder** (`documentService.buildProjectionUpdate`): mirrors
  the text-search delta logic. It reads core's `revisionDelta()` and emits a
  `delta` (changed nodes via `projectionNodesFor`, with absent ids becoming
  `removedIds`) for a clean `+1` revision step; any discontinuity, or core's
  `requiresFullSearchRebuild` (undo/redo/import/load), falls back to `full`. Core
  is untouched — the delta is assembled at the process boundary from existing core
  APIs.
- **Renderer reducer** (`reduceProjection` in `renderer/state/document.ts`): a
  `full` rebuilds the index; a `delta` patches a copy of the previous `byId` —
  `set` each changed node, `delete` **exactly** `removedIds` (no stale-subtree
  walk: core enumerates every genuinely-removed node, and a merge survivor whose
  grandchildren re-parented out arrives in `changedNodes`). Every unchanged node
  keeps its object reference, the stable identity the outliner's `React.memo`
  relies on. A revision gap or a delta with no base returns `null`, triggering the
  `get_projection` → `ProjectionSnapshot` resync valve (belt-and-suspenders; in
  steady state the single ordered channel never needs it).
- **Re-render closure** (`renderer/state/renderRev.ts`): a per-node revision
  counter drives the memo. From the change set, `propagateDirty` walks a held
  reverse-edge index (`ReverseEdges`: target → referrers, for reference targets /
  tag definitions / inline-ref targets) plus structural ancestors to mark exactly
  the nodes that must re-render. The index is carried across edits and patched per
  delta (`patchReverseEdges`, copy-on-write with a same-keys skip so a plain text
  edit allocates nothing), never rebuilt by scanning the document. Consistency
  against a full rebuild is asserted after every command in
  `tests/renderer/projectionDeltaIntegration.test.ts`.

## Type Boundary

Protocol-shaped TypeScript types live in `src/core/types.ts` and are re-exported
to the renderer through `src/renderer/api/types.ts`. The renderer API client
keeps command names stable so UI code does not depend on Electron internals.
