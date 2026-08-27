# Tenon Architecture

Tenon is a clean rebuild of the nodex outliner experience.

The repository does not carry migrated nodex product code. nodex remains an
external behavior reference only.

## Runtime Boundaries

- `src/core`: pure TypeScript outliner state machine.
- `src/content`: neutral exact-revision admission, retention, verification, and
  physical garbage collection shared by Host processes.
- `src/outline/contract`: public Selector, Projection, ChangeSet, Diff,
  Operation, Event, asset, envelope, and capability schemas.
- `src/outline/runtime`: standalone document domain, transactional persistence,
  recovery, events, and asset reachability.
- `src/outline/client`: Runtime discovery, startup, protocol negotiation, and
  authenticated request/stream client.
- `src/main`: Electron native host, typed Runtime adapter, OS effects, and Agent
  runtime. It does not own document state or workspace persistence.
- `src/preload`: narrow Electron preload bridge exposed as `window.lin`.
- `src/renderer`: React view and interaction layer.

There is no Rust, Cargo, Tauri, or `src-tauri` product runtime in this repository.
Document state, Agent integration, parser logic, preview/validation, and
persistence are all implemented in TypeScript.

The standalone Outliner Runtime is the sole live document authority. It owns one
Core instance, one serialized writer, the transaction log, Operation history,
recovery patches, ordered Events, and asset reachability. Electron main, the
renderer, the CLI, Skills, and import helpers are clients; none imports Core or
opens workspace files. React keeps UI-only state such as focus, expanded rows,
selection, popovers, and transient editor drafts.

Agent Memory keeps published content in ordinary Daily Notes Nodes. Electron
main owns its local control database under `userData/agent/memories.sqlite` and
settles receipt-bearing Runtime mutations against that control state. The
control database is not portable workspace content. See
[`agent-memory.md`](agent-memory.md).

Binary assets are outside the CRDT document. The document stores stable logical
asset IDs on `image` / `attachment` Nodes. Runtime owns Outline `AssetRecord`
metadata, staging leases, live-Node and recovery-patch reachability, and the
transaction that changes those facts. The neutral `ContentStore` stores immutable
exact revisions, admission leases, opaque mechanical retention anchors,
admission-staging/publication/deletion journals, physical-integrity quarantine,
and physical GC
under the explicit `{userData}/content/` root. It does not know Outline or Agent
identity, filenames, MIME presentation, document reachability, or recovery
policy.

An `AssetRecord` contains one Host-private
`ExactRevisionReference { anchorId, byteLength }`. The ContentStore anchor binds
that handle to one reconciliation namespace, one opaque domain record key, and
one physical revision; a released anchor ID is permanently retired and can
never be rebound. Public `AssetMetadata`, `AssetLease`, CLI JSON, renderer DTOs,
ChangeSets, and Operations expose neither physical digests nor anchor IDs;
clients name only logical asset and lease IDs. Many logical records may retain
one deduplicated exact revision through independent anchors. A physical
digest/length mismatch quarantines that revision for every reference, while
invalid Outline metadata degrades only its AssetRecord and never moves shared
valid bytes.

Logical AssetRecord collection pauses while any AssetRecord is degraded because
its dependency edges, including thumbnail references, cannot be enumerated
reliably. Healthy records remain readable and ordinary document work continues;
the conservative pause prevents one damaged record from collecting another
healthy logical record or releasing its anchor.

ContentStore persists `state.sqlite`, `blobs/`, `staging/`, and `quarantine/`.
Runtime and ContentStore roots are derived independently from the same explicit
userData authority; neither root is inferred from `cwd` or from the other root.
Both Host processes use the same WAL/busy-retry and per-digest publication
protocol. There is no workspace asset blob directory, sidecar reader, migration,
dual write, or automatic startup deletion path. The shared-content-aligned
Runtime workspace and ContentStore are storage version 2; earlier formats fail
closed until the documented manual userData reset is completed.

Asset admission publishes or verifies bytes under an admission lease. Runtime
then holds its Outline namespace mutation/reconciliation barrier from before
anchor creation through durable AssetRecord commit or failed-commit release.
Creating the anchor atomically consumes the admission lease and returns only the
Host-private exact-revision handle. Cross-store interruptions may leak an anchor
but cannot leave a committed record whose revision was collected.
Reconciliation first completes and validates the entire `(assetId, anchorId)`
enumeration against the stored namespace/record coordinate, then releases only
absent Outline anchors; unavailable, corrupt, missing, or mismatched state
releases none.

Before creating or writing an admission staging file, ContentStore persists its
stage ID, writer PID, opaque owner token, and timestamps. A publication claim
atomically transfers that staging ownership into the per-digest publication
journal. Normal cleanup unlinks the staging file and fsyncs the staging directory
before removing its ownership row. Publication rename fsyncs both the destination
and staging directories before clearing its journal. Startup preserves staging
owned by a live process and reclaims a file only after its recorded writer is
proven dead, so concurrent stores cannot delete an active stream and a crash
before publication cannot leak untracked bytes. The same dead-writer repair runs
during central GC, so cleanup does not depend on all surviving Host processes
restarting.

Record deletion uses the opposite order: Runtime durably removes an unreachable
AssetRecord, then releases its anchor. ContentStore GC selects only published
revisions with no active admission lease and no anchor in one SQLite transaction,
marks them `deleting`, unlinks them, fsyncs the containing directory, and only
then settles the deletion journal. Admission and anchor cloning cannot attach to
a deleting revision. Startup repairs interrupted admission staging, publication,
and deletion states.

Recovery policy remains Runtime-owned, but physical accounting remains neutral:
Runtime supplies the exact-revision handles for live and recovery-protected
AssetRecords, and ContentStore returns their distinct physical byte total
without exposing its digest key. A revision shared by multiple recovery records
is charged once, and a revision still retained by a live logical record is not
charged as recovery-only storage.

Renderer flows stage files through public asset capabilities and reference the
returned lease in an ordinary ChangeSet. Native pickers, open, Reveal in Finder,
copy, and external URL handling remain Electron-main OS effects rather than
Runtime document capabilities. Local `asset://` range serving streams verified
Runtime bytes and does not pre-read an entire video merely to render it. PDF
thumbnails are separate logical AssetRecords over ordinary exact revisions; the
parent relationship protects them through lease, live, recovery, and GC rules.

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

Path-backed ingest resolves the source with `realpath` and accepts regular files
only. Reads and exports resolve an AssetRecord through its Host-private anchor
and exact-revision coordinate, then ContentStore verifies the bytes. Electron
main system actions consume that verified stream through a private
materialization; the renderer never receives a ContentStore path.

## Command Flow

```txt
React interaction
  -> desktop intent builds a public ChangeSet
  -> preload forwards a versioned Runtime request
  -> Electron main authenticates and forwards without document logic
  -> Runtime direct commit for ordinary non-destructive writes, or reviewed Diff apply
  -> one durable Operation and ordered projection Event
  -> renderer folds the Event delta into its projection index

terminal or Agent intent
  -> registry-derived outline parser/help/schema contract
  -> one complete-resource porcelain command, or one dependent ChangeSet
  -> authenticated Runtime direct commit, preview, or exact reviewed Diff apply
  -> one durable Operation with bounded returned Projection
```

No renderer module may directly mutate document state. UI changes that affect
document content or tree structure must use a public ChangeSet. Desktop intent
helpers preserve focus and interaction hints locally; those hints are not part
of the persisted contract. Renderer text-edit undo groups may span adjacent
direct-commit Operations for undo/redo selection, but recovery remains durable
and Operation-addressed.

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

The Runtime publishes no successful mutation before one fsynced transaction-log
commit contains the document update, Operation metadata, recovery patch,
idempotency result, asset-reference delta, and Event sequence. A client timeout
or disconnect never retries a mutation automatically; it resolves unknown
settlement through the idempotency key or Operation log.

The CLI is a formal client boundary, not a thin exposure of the Runtime's generic
MutationInput. One resource uses one porcelain command; complex state for that
resource uses the same command's exact `--input` schema; dependent, cross-date,
or bounded bulk work uses one ChangeSet with bindings. Parser options, root and
family help, exact command help, completion metadata, and command schemas share
the executable capability registry. Help is local and cannot start Runtime.
No client uses a shell mutation loop or intermediate created-ID query to replace
ChangeSet composition.

Desktop mutation admission is serialized around the latest projected revision.
Ordinary non-destructive edits use direct commit; destructive or review-bound
work applies an exact Diff. The adapter then waits for the matching Operation
Event. A missing or discontinuous Event triggers a bounded full Projection
resync. Quit freezes new desktop admissions and drains accepted requests;
Runtime durability is already complete before each response.

## Workspace Persistence And Replication Boundary

The standalone Runtime owns the only writable workspace store. It persists a
versioned snapshot plus an append-only transaction log beneath its private
workspace root. A committed transaction record binds one Core update and the
local metadata required to settle and recover the public Operation:

```ts
interface WorkspaceTransactionRecord {
  sequence: number;
  revisionBefore: number;
  revisionAfter: number;
  documentUpdate: string;
  operation: Operation;
  recoveryPatch: RecoveryPatch;
  idempotency?: IdempotencyReceipt;
  assetDelta: AssetReferenceDelta;
  events: OutlineEvent[];
}
```

Apply keeps Core's rollback frontier live until this record is encoded, written,
and fsynced. A write, encode, or recovery-capacity failure therefore admits no
document state. Runtime replays the verified prefix at startup, discards only a
provably torn final record, and fails closed on corruption that could admit an
unknown state. Snapshot compaction never removes retained recovery or asset
reachability information. Pre-release formats have no compatibility reader.

Core startup reconciliation can create durable system state, such as the current
local-date Daily Note. When `requiresInitialPersist()` reports that condition,
Runtime atomically compacts the reconciled Core into the verified snapshot/log
baseline before publishing its descriptor or accepting requests. Startup fails
if that baseline cannot be persisted; no later transaction may depend on
process-local reconciliation state. Runtime resolves its new instance identity before
that compaction and supplies it to any recovery-expiry maintenance Event. The workspace
keeps the pre-compaction Event sequence as its replay baseline, so a startup Event is
visible to watches under the identity that will publish the descriptor.

Storage maintenance derives all work from the committed log and indexes. It
repairs a torn tail, expires eligible recovery, removes orphan recovery blobs,
durably removes unprotected AssetRecords before releasing their anchors, invokes
central ContentStore GC, and compacts a log after its record/byte threshold.
Runtime schedules it after startup once the descriptor is serviceable, during
foreground-idle windows, and before idle shutdown. A watch stream keeps Runtime
alive but does not count as foreground work, so ordinary desktop sessions still
receive maintenance while the live event stream is open. Successful mutation
acknowledgement never waits for post-commit cleanup, asset garbage collection,
or compaction. Recovery expiry that is required for admission may still run
before a write; recovery expiry is durable and observable before blob unlink.
Cleanup or compaction failure cannot reverse an already acknowledged Operation.
A failed compaction invalidates the process-local log cache so the next write
reloads the authoritative snapshot/log boundary before admission.

Every successful mutation, including desktop editing and history reversal,
creates one durable `Operation`. A revert is a new guarded Operation and never
erases its target. Recovery patches retain the complete affected state even when
the public Operation returns only a bounded ID sample. Purged subtrees,
dependent references, and referenced asset records remain recoverable until the
retention boundary expires.

The Loro document remains Runtime-internal. It uses a fresh peer for new
operations, supports compact snapshots and full updates for deep trees, and
materializes and deletes with explicit work stacks rather than recursive JS
traversal. Neither its snapshot bytes nor Core commands cross the public
protocol.

Asset ingest admits one exact revision, settles its anchor and logical
AssetRecord in anchor-first order, and returns a staged Outline lease before a
document mutation. Apply atomically consumes referenced leases into live asset
reachability. Runtime recovery and lease policy decides when a logical record is
unreachable; ContentStore alone decides when an unleased, unanchored revision is
physically collectible. There is no public physical-delete capability.

`media add PATH|-` composes staging and media-Node creation as one common CLI
intent while retaining the same internal lease boundary. `asset ingest` remains
available when automation deliberately separates staging from reviewed document
mutation. A failed media creation leaves the staged bytes governed by lease
expiry; a successful Operation and its recovery patch protect the asset.

Import is ordinary ChangeSet composition. The `outline` Skill's import helper
inspects source data, accounts for coverage, and emits a ChangeSet plus evidence.
It may use `ensure` bindings to create multiple canonical dates and attach all
imported trees in one Diff and one apply. The helper never opens Core,
persistence, or an import-only write endpoint.

The Runtime process is discovered through a user-private descriptor and local
authenticated transport. The descriptor and socket/token paths are derived by
`src/outline/runtimePaths.ts`, shared by client and server without making the
client depend on Runtime implementation. An ordinary desktop or CLI request may
start the bundled Runtime; `--no-start` returns a stable unavailable error. If
automatic start finds an older bundled contract, the client first authenticates
the private Runtime identity and requires the descriptor to match the private
writer-lock owner exactly. A current Runtime then retires through its private
lifecycle route; a legacy Runtime that predates that route receives `SIGTERM`
only after the same identity and ownership checks. The client waits for that
exact instance to release its descriptor before launching one replacement, so
an atomic private retirement claim makes simultaneous desktop and CLI starts
converge on one signaler and one writer; a claim whose owner died is recovered.
Unowned, unverifiable, or live-status drift remains `protocol_incompatible`;
inspection through `status` and `--no-start` never retires or starts a process.
The Runtime imports neither Electron nor renderer code.

These are local persistence contracts only. Tenon currently starts no account,
network transport, outbox, retry loop, Cloudflare resource, or sync UI. Future
replication must enter through the public Runtime contract rather than opening
Core or workspace files from another process.

## Runtime Events And Projection Updates

The renderer holds its projection index across edits and folds **change sets**
into it, instead of receiving and re-deriving the whole document each mutation.
Per-edit cost scales with what changed, not document size.

- **Desktop wire type** (`src/core/types.ts`): `ProjectionUpdate` is a discriminated
  union — `{ kind: 'full'; revision; projection }` for init / resync / whole-tree
  rewrites, or `{ kind: 'delta'; revision; todayId; changedNodes; removedIds }`
  for normal mutations. It is a desktop adapter DTO, not a second mutation
  protocol.
- **Runtime event** (`src/outline/contract/schemas.ts`): every committed change
  emits an ordered `outline.event` carrying its sequence, revision, Operation ID,
  changed-node Projection records, and removed IDs. `watch` resumes from an
  opaque cursor; a retention gap emits `resync.required`.
- **Client adapter** (`src/outline/client/documentProjection.ts`): converts a
  Runtime projection Event into the existing renderer delta and reads a bounded
  complete Projection when initialization or resync requires `full`.
- **Subscription lifetime** (`src/outline/client/client.ts`): public CLI streams
  retain their finite command deadline. Desktop Event subscriptions use that
  deadline only until the first validated `hello`, then remain open until caller
  cancellation, transport closure, or a Runtime `end` record.
- **Renderer reducer** (`reduceProjection` in `renderer/state/document.ts`): a
  `full` rebuilds the index; a `delta` creates a new immutable snapshot backed by
  a bucketed copy-on-write `byId` map and a lazy `projection.nodes` array view.
  It writes only the delta keys: upsert each changed node, remove **exactly**
  `removedIds` (no stale-subtree walk: core enumerates every genuinely-removed
  node, and a merge survivor whose grandchildren re-parented out arrives in
  `changedNodes`). Every unchanged node keeps its object reference, and the
  snapshot objects still get fresh identities so existing React dependency keys
  update without requiring a component-level rewrite. A revision gap or a delta
  with no base returns `null`, triggering a complete Runtime Projection resync.
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

Public cross-process schemas and DTOs live in `src/outline/contract/`. Desktop
projection and focus adapter types remain in `src/core/types.ts` and are
re-exported through `src/renderer/api/types.ts`; they do not expose the Core
engine. Preload exposes a typed Outline request/stream bridge, never the socket,
bearer token, filesystem, or Node APIs.
