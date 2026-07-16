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

Derived metadata is extracted at ingest from the bytes alone — PDF page count by
scanning for page objects, audio/video duration parsed from WAV/MP4 container
headers. PDF thumbnails are an exception: they shell out to poppler's `pdftoppm`
(spawned with fixed args, no shell, a short timeout, and a scratch dir cleaned up
after). `pdftoppm` is an **optional** system dependency — when it is missing or
fails, ingest degrades gracefully and the attachment simply renders with its
file-type icon instead of a thumbnail.

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
  -> persisted workspace snapshot (coalesced for bursty edits)
  -> ProjectionUpdate (delta | full) folded into the renderer index
```

No renderer module may directly mutate document state. UI changes that affect
document content or tree structure must use commands.

The document service keeps command application and projection emission
synchronous from the renderer's point of view, but it does not write the whole
workspace snapshot after every bursty mutation. Text edits keep a 700 ms undo
group before save, and structural mutations use the same 700 ms coalescing
window. Starting a text edit, starting an eager-materialized row, undo/redo
history work, explicit transactions, and app `before-quit` all flush pending
document writes before continuing.

## Workspace Persistence And Replication Boundary

`DocumentService` atomically persists `workspace.loro.json` as a versioned v3
envelope. The envelope separates portable workspace facts from state owned by
one local replica while keeping both sections in one atomic save:

```ts
interface WorkspacePersistenceEnvelopeV3 {
  kind: 'tenon-workspace';
  schemaVersion: 3;
  shared: {
    workspaceId: string;
    documentId: string;
    document: SharedLoroDocumentState;
  };
  local: {
    installationId: string;
    replicaId: string;
    loroPeerId: string;
    operationHistory: OperationHistoryEntry[];
  };
}
```

`installation.json` holds the stable identity of one Electron `userData`
installation and is created with the private atomic JSON store. The local
envelope section repeats that id as its ownership marker. Loading the envelope
under the same installation restores the document replica and Loro peer ids.
Loading a copied envelope under a different installation keeps the shared
workspace/document identities but mints a new replica and peer and discards the
copied operation journal. A shared-state bootstrap always follows the same
fresh-replica rule. The retired top-level Loro v2 format has no compatibility
reader; pre-release development data must be reset after this format change.

The shared Loro record contains a snapshot but no field designating the active
local peer. Historical peer ids remain intrinsic to Loro operation ids inside
the snapshot. Two converged replicas can therefore emit different snapshot
bytes; convergence is the same materialized state and semantic version vector,
not byte-identical snapshot encoding.

Core exposes provider-neutral replication primitives for a full shared
snapshot, encoded version vectors, updates since a version vector, committed
local-update subscription, and idempotent batch import. Imports accept
out-of-order and duplicate Loro updates, never re-emit them as local updates,
leave replica identity and the local operation journal untouched, and force a
full projection/search cache rebuild when materialized nodes change. Loading an
already-normalized snapshot also discards reconciliation operations that made
no logical change, so the first real local update has no replica-private hidden
dependencies.

These are local persistence contracts only. Tenon currently starts no account,
network transport, outbox, cursor, retry loop, Cloudflare resource, or sync UI.
Future transport remains owned by Electron main and must not introduce
Cloudflare SDK types into Core.

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

## Agent Runtime Projection Updates

Agent conversations use the same stable-identity rule, but with a separate
renderer projection type:

- The renderer still accepts a full agent `projection` event for initial load,
  revision gaps, multi-field changes, and any case where the runtime cannot prove
  a patch is safe.
- High-frequency direct-message streaming emits `projection_patch` for the
  single active assistant message when the previous emitted projection is exactly
  the patch base revision. The patch carries `baseRevision`, `revision`, the
  changed message entity, and `dmStreaming`; unchanged entity maps keep their
  object references.
- The renderer folds patches with `applyAgentRenderProjectionPatch`. A revision
  mismatch returns `null` and triggers a full conversation reload instead of
  guessing across a gap.
- Multi-agent Channel turns remain result-first and transcript-atomic, so they
  continue to use the full-projection fallback for transcript changes. Channel
  live activity is still surfaced through the activity/detail projection fields.

## Type Boundary

Protocol-shaped TypeScript types live in `src/core/types.ts` and are re-exported
to the renderer through `src/renderer/api/types.ts`. The renderer API client
keeps command names stable so UI code does not depend on Electron internals.
