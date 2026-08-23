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

Agent Memory keeps published content in ordinary Daily Notes Nodes. Electron
main owns its local control database under `userData/agent/memories.sqlite` and
uses trusted receipt-bearing document transactions to reconcile SQLite with the
Loro document. The control database is not portable workspace content. See
[`agent-memory.md`](agent-memory.md).

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

Application update discovery is another inspection-only main-process boundary.
`AppUpdateService` checks the fixed public `relixiaobo/lin-outliner` GitHub
Releases endpoint after the first window exists, never on the awaited startup
path. Packaged builds opt into automatic checks by default; an attempted check
throttles later ambient attempts for six hours, while an explicit Settings check
bypasses the throttle. One `AbortController` bounds an attempt to five seconds.
Main strictly decodes a bounded release/asset response, ignores drafts,
prereleases, and invalid SemVer tags, and selects the highest stable version
rather than trusting API order. It fetches `CHANGELOG.md` from that exact tag and
reuses `parseChangelogReleases` for the user-register note; note failure does not
hide an otherwise verified release, while an exact section's empty note is cached
distinctly from failure. Both requests disable automatic redirects, validate
every hop against their fixed GitHub host, and accept at most two hops. Both
remote bodies are read incrementally; Main cancels the stream as soon as its byte
ceiling is crossed.

The versioned private `userData/app-update-state.json` record stores the automatic
check preference, attempt/success timestamps, and the last verified release.
Malformed reads and failed writes report diagnostics and degrade to defaults;
network failure preserves the last valid release. This cache is neither document
state nor a startup dependency. Release-page and `.dmg` destinations remain Main
private and are revalidated on decode/load. The Settings preload can request
`get`, `check`, `set automatic`, or `open`; it cannot submit a URL, and the
launcher receives no update capability. Main accepts those IPC calls only from
the live Settings window. Only the direct response to a current explicit check
may carry its bounded failure code; ordinary reads and change broadcasts clear
that field, so reopening About cannot replay an old failure.

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
  -> ProjectionUpdate (delta | full) folded into the renderer index
  -> background incremental persistence handoff
```

No renderer module may directly mutate document state. UI changes that affect
document content or tree structure must use commands.

Surfaces that act on a presented object go through the **action seam** rather
than assembling commands themselves — see [`action-registry.md`](action-registry.md):

```txt
right-click / summon
  -> InvocationSeed (renderer FACTS, sender-checked)
  -> main constructs the objects, mints the refs, owns the lifetime
  -> ActionRequest { actionId, invocationRef, subjectRef, typed arguments }
  -> main RE-EVALUATES against the latest projection
  -> ordered ActionEffectPlan, executed BY main (renderer legs routed + acked)
```

A renderer may NAME an action; it may never author one. Effect plans travel
main -> renderer only.

The document service keeps command application and projection emission
synchronous from the renderer's point of view, while workspace persistence is a
separate handoff. A changed command advances a monotonic persistence revision and
returns at the **accepted** tier; the background `WorkspaceSaver` captures an
incremental Loro update and appends it durably after a 700 ms idle window. A
first-dirty max-wait of 5 seconds bounds the crash window during sustained
typing. Structural edits, undo/redo, and the text-edit undo-group boundary use
the same saver; they do not wait for a whole-document snapshot or file write on
the mutation queue. Trusted document-system transactions are the explicit
exception and await the **durable** acknowledgement before their control-plane
commit is considered complete. Failed background writes remain dirty and retry
with exponential backoff capped at 30 seconds; an explicit trusted-transaction,
flush, or quit retry starts immediately.

`WorkspacePersistenceStore` owns two files under `userData`: the authoritative
`workspace.loro.json` v3 snapshot and
`workspace.loro.updates.jsonl`. Every log header carries the SHA-256 digest of
the snapshot it extends. The snapshot records the persistence-revision and
local-metadata-sequence baselines. Each append contains the update bytes,
version vector, later persistence revision, and local operation-history delta;
the record is written and fsynced before the saver acknowledges durability.
After validating a log once, the store keeps its append handle and a cursor over
the verified header, file size, identity, ordering frontier, and final-record
digest. Ordinary appends therefore validate against O(1) state instead of
reopening and decoding the previous update. An ambiguous write failure
invalidates the cursor and forces one full log validation before retry. If the
active log path is deleted, replaced, or changes size outside the store, the
saver does not append from a potentially unrelated version frontier: it captures
the current document once, atomically compacts that full snapshot, and resumes
incremental appends from the replacement snapshot.

Compaction atomically writes a complete snapshot, fsyncs it and its parent
directory, then replaces the log header. The snapshot raw bytes, revision,
metadata sequence, and Loro version are captured as one frontier before I/O;
mutations accepted while the write is in flight remain dirty against that
frontier. Compaction is considered after 64 log records or 2 MiB (including the
matching log loaded at startup), but the full snapshot capture waits for a real
700 ms idle window rather than running at the sustained-typing max-wait
checkpoint.

On startup the store validates the header, replica identity, monotonic metadata,
and the Loro version reached by each update before exposing records to Core. A
missing newline with an incomplete final JSON record is a recoverable torn tail.
Other log anomalies never make a readable snapshot unopenable: the original log
is durably copied to an `*.unreadable-*` quarantine file, the verified prefix is
kept, and the active log is rewritten without the unreadable suffix. After Core
replays that prefix, `DocumentService` immediately compacts it into a new
snapshot; recovery and any repair-write failure are reported through the
persistence error channel. A log whose digest belongs to an older snapshot is
discarded without quarantine only when every intact record has the same replica
identity, lies at or behind the snapshot's revision baselines, and its version
is contained by the snapshot. Otherwise it follows the same quarantine recovery.

A snapshot that parses as a `tenon-workspace` envelope but carries **no**
`persistenceRevision` field is a pre-update-log workspace (the pre-release
no-migration policy: formats break, old readers are deleted). The store renames
the snapshot and any co-resident log to `*.incompatible-*` set-aside files —
never deleting them — syncs the directory, and reports a fresh-start load with
the decode error in the recovery channel; `DocumentService` then creates a new
workspace exactly as on first run. A **present but invalid**
`persistenceRevision` means corrupt current-format data and stays fail-closed:
only the provably older shape is set aside.

Quit is a two-phase operation. Phase 1 freezes new mutation admission, queues
later mutation requests, waits for all admissions that already passed the gate,
closes any open text undo group, and drains to a linearizable durable-revision
barrier. Retry keeps the queue frozen; Cancel resumes every queued request while
leaving all services live. Only a successful barrier or explicit **Quit Anyway**
choice rejects the still-unaccepted queue and enters Phase 2, which tears down
auxiliary services and force-exits the process. The coordinator exists before
workspace initialization so startup-time quits still run auxiliary teardown.
Concurrent quit requests share one request and cannot bypass the drain or run
teardown twice. There is no automatic total-attempt exit after a failed drain:
the per-attempt deadline returns to the native Retry / Quit Anyway / Cancel
decision, and the app remains in reversible Phase 1 until the user chooses a
terminal outcome.

## Workspace Persistence And Replication Boundary

`WorkspacePersistenceStore` atomically persists `workspace.loro.json` as a
versioned v3 envelope. The envelope separates portable workspace facts from
state owned by one local replica while keeping both sections in one atomic
snapshot:

```ts
interface WorkspacePersistenceEnvelopeV3 {
  kind: 'tenon-workspace';
  schemaVersion: 3;
  persistenceRevision: number;
  persistenceMetadataSequence: number;
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

Native Daily Note import uses the same Core boundary across multiple parents.
`DocumentService.createImportTreeBatchesYielding` resolves and ensures every
canonical year/week/day target inside one Core transaction, preflights every
tree, and materializes the date batches plus an optional non-date staging tree
with one shared resolution cache. Chunk commits retain one rollback frontier,
one undo group, and one operation-history entry. A failure removes all imported
roots and any date scaffolding created by that operation; existing day nodes and
their prior children are untouched. Post-import verification traverses only the
returned roots, so pre-existing Daily Note content cannot contaminate counts.

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
  `full` rebuilds the index; a `delta` creates a new immutable snapshot backed by
  a bucketed copy-on-write `byId` map and a lazy `projection.nodes` array view.
  It writes only the delta keys: upsert each changed node, remove **exactly**
  `removedIds` (no stale-subtree walk: core enumerates every genuinely-removed
  node, and a merge survivor whose grandchildren re-parented out arrives in
  `changedNodes`). Every unchanged node keeps its object reference, and the
  snapshot objects still get fresh identities so existing React dependency keys
  update without requiring a component-level rewrite. A revision gap or a delta
  with no base returns `null`, triggering the `get_projection` →
  `ProjectionSnapshot` resync valve (belt-and-suspenders; in steady state the
  single ordered channel never needs it).
- **Re-render closure** (`renderer/state/renderRev.ts`): a per-node revision
  counter drives the memo. From the change set, `propagateDirty` walks a held
  reverse-edge index (`ReverseEdges`: target → referrers, for reference targets /
  tag definitions / inline-ref targets) plus structural ancestors to mark exactly
  the nodes that must re-render. Both the reverse-edge index and the per-node
  revision map are carried across edits and patched per delta (`patchReverseEdges`
  and `patchRevisions`), never rebuilt by scanning the document. A same-edge plain
  text edit reuses the reverse-edge object while only the affected revision buckets
  are copied. Consistency against a full rebuild is asserted after every command in
  `tests/renderer/projectionDeltaIntegration.test.ts`.

## Agent Core Updates

Agent Core uses its own strict request and notification transport rather than the
document projection stream. Main persists canonical Thread notifications before
publishing them. Renderer `threadStore` applies decoded notifications to loaded
Thread pages and reloads paginated history when it cannot prove a local update is
complete. There is no second renderer projection schema.

The durable source is each Thread rollout; SQLite catalog and history tables are
rebuildable projections. See [`agent-core.md`](agent-core.md).

## Type Boundary

Protocol-shaped TypeScript types live in `src/core/types.ts` and are re-exported
to the renderer through `src/renderer/api/types.ts`. The renderer API client
keeps command names stable so UI code does not depend on Electron internals.
