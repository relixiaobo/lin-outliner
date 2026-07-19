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

Every asset sidecar is a versioned `AssetMetadata` record carrying the stable
logical `id`, exact `byteSize`, and lowercase SHA-256 digest. Buffer-backed and
path-backed ingest share this contract, and generated PDF thumbnails receive the
same integrity metadata. `AssetService.readVerified()` is the portable byte-read
boundary: it returns the stored bytes only after both length and digest match,
and reports corruption explicitly. Local `asset://` range serving remains
streaming and does not pre-read an entire video merely to render it.

Path-backed assets hash the final stored file through a read stream. Buffer
ingest, derived thumbnails, and verified reads hash in bounded 1 MiB turns that
yield to the event loop between chunks, keeping Electron main responsive for
large assets. `bun run probe:asset-hashing` compiles the probe and runs it in
Electron main, where it asserts and reports the Electron runtime version before
measuring total hashing time and maximum event-loop stall for both paths;
`ASSET_HASH_PROBE_MIB` overrides its 512 MiB fixture size.

Document-referenced source assets are portable. PDF thumbnails are derived
outputs rather than portable source assets; their ids may appear in source
metadata, but this integrity layer neither deletes nor rebuilds them. Future
preview formats follow the same ownership rule only when they are reproducible.
A digest never replaces `assetId`; it is an integrity and future object-store
idempotency key, not user-visible identity. The pre-release v1 sidecar has no
legacy reader.

Preview translation persistence is a separate local-derived-data boundary, not
an asset or workspace fact. Electron main owns a bounded cache under `userData`;
the renderer can only submit validated translation batches through the existing
translation command, and the preload exposes only a Settings-window clear action,
not arbitrary cache reads. Webpage, prerecorded-caption, and reflowable-EPUB
source/configuration identities are hashed before persistence. Cache shards store
opaque digests, validated translated text or explicit unchanged-output sentinels,
and recency metadata, never source text, URLs, local paths, readable model
configuration, credentials, pending work, or failures. The cache does not
participate in document persistence, Loro
replication, asset export, diagnostics export, or backup portability; loss or
corruption is an ordinary cache miss.

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
    loroPendingUpdates: string[];
    operationHistory: OperationHistoryEntry[];
  };
}
```

`installation.json` holds the stable identity of one Electron `userData`
installation and is created with the private atomic JSON store. The local
envelope section repeats that id as its ownership marker. It is not a hardware
identity and can be duplicated with a complete `userData` copy. Loading the
envelope under the same installation restores the document replica, operation
journal, and unresolved Loro updates. Loading a copied envelope under a
different installation keeps the shared workspace/document identities but
mints a new replica and discards copied local history. A shared-state bootstrap
always follows the same fresh-replica rule. The retired top-level Loro v2 format
has no compatibility reader; pre-release development data must be reset after
this format change.

Local undo/redo and local operation-history metadata are intentionally bounded.
The Loro `UndoManager` instances for all, agent, and user scopes each retain the
latest 100 steps. The JavaScript operation journal is metadata for listing and
stack guards, not an unbounded audit log; Core restores, serves, and persists only
the latest 500 entries for the owning installation. Each entry stores at most a
bounded deterministic sample of affected node ids plus the total count and a
diagnostic hash, so bulk operations do not pin every touched id in local history.

Every Core construction uses a fresh random Loro peer id for new operations;
the active peer is never persisted. This remains safe when a complete
`userData` directory is cloned or an older workspace snapshot is restored:
neither process can reuse an already-synchronized `{peer, counter}` range.
Historical peer ids remain intrinsic to operation ids in the snapshot. The
trade-off is one version-vector peer per editing session.

The shared Loro record contains portable Loro bytes but no field designating the
active local peer. Core exports a compact Loro snapshot by default. If the
materialized outline is deeper than 1,024 rows, Core writes a full Loro update
instead (`exportMode: "update"`), because Loro's snapshot/shallow-snapshot export
path fails in wasm on very deep tree nesting while update export remains
iterative enough for the same structure. Loro import accepts both encodings, so
reload and replication bootstrap use the same shared-state path. Two converged
replicas can therefore emit different byte encodings; convergence is the same
materialized state and semantic version vector, not byte-identical snapshot
encoding.

Core exposes provider-neutral replication primitives for a full shared
snapshot, encoded version vectors, updates since a version vector, committed
local-update subscription, and idempotent batch import. Imports accept
out-of-order and duplicate Loro updates, never re-emit them as local updates,
leave replica identity and the local operation journal untouched, and report
accepted operations, unresolved dependencies, and persistence changes
separately from materialized node changes. Newly accepted operations are
durable even when conflict resolution leaves the visible state unchanged.
For the common single-update path, Core derives candidate node ids from Loro's
import event tree/map/text/list paths, materializes only those candidates, and
compares them against the committed state before reporting `changedNodeIds`.
Multi-update batches, dependency-pending updates that become applicable later,
and accepted imports with no usable event candidates fall back to a full-state
diff. Duplicate or still-pending imports do not invalidate materialized caches
or clear redo.

The Loro document wrapper materializes and deletes document trees with explicit
work stacks rather than recursive JS traversal. Core's permanent-delete
dependency collection uses the same iterative discipline, so valid deep outline
chains do not fail from JavaScript call-stack depth in these paths.
Yielding tree materialization honors `commitEveryNodes` even when called directly
without an outer service transaction: Core opens an internal transaction and undo
group so chunk commits are real Loro commits while undo still removes the import
as one operation. Each chunk drains, materializes, and patches its touched nodes
before committing, then Core records one revision and operation-history entry at
the final transaction boundary. That keeps the public mutation atomic while
avoiding one large end-of-import materialization stall. The tree-materialization
context also caches active tag definitions, `childSupertag` config for inherited
child tags, and field definition name/type resolution for pasted `field:: value`
metadata, so importing many children under a tagged parent such as Today or a
field-heavy import does not re-materialize the whole document for every inserted
row or field. The agent import service chooses its `yieldEveryNodes` /
`commitEveryNodes` chunk size from Import Pack stats: plain large outlines keep
larger chunks, while field-heavy packs yield more often because each field
materializes an entry plus a value/reference child.

Shared-state export, version-vector reads, incremental export, and remote
import are available only at a committed Core boundary. They reject both an
active explicit transaction and a standalone async mutation while it has
yielded. Loro export can otherwise auto-commit pending operations, so this guard
prevents a failed Core transaction from publishing data that its rollback later
removes locally.

Loro snapshots omit updates whose causal dependencies are still missing. The
local envelope therefore keeps only base64 update blobs whose end versions are
not yet covered by the current oplog. Reload replays those blobs; they are
removed once their operations enter the oplog. This list is CRDT dependency
durability, not a network outbox, acknowledgement cursor, or retry queue.
Loading an already-normalized snapshot reopens it only when reconciliation
actually created a pending transaction, so normal reload performs one snapshot
import while still preventing no-op reconciliation from becoming a hidden
dependency of the first real local update.

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
  exposes this explicit projection-read surface; its internal `CommandOutcome`
  carries only local interaction hints and does not force projection
  materialization on the mutation path.
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
