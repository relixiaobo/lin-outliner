# Outline Command Protocol

All persisted Outliner reads and mutations use the versioned public contract in
`src/outline/contract/`. The standalone Runtime owns document execution and
durability. Electron main, the renderer, the `outline` CLI, built-in Skills, and
external automation are clients of that same contract.

Agent Core remains a separate strict Thread/Turn/Item protocol. Native pickers,
window state, focus, selection, clipboard, Reveal in Finder, file opening, and
external URL opening are Electron or renderer effects and are not Outline
Runtime capabilities.

## Sources Of Truth

- `src/outline/contract/schemas.ts` defines the exact Selector, TargetSpec,
  Projection, ChangeSet, Diff, Operation, Event, asset, request, response, and
  stream schemas.
- `src/outline/contract/capabilities.ts` is the executable public capability
  registry. Each entry owns its name, request and result schema, kind,
  streaming/destructive flags, audit category, summary, and coverage.
- `src/core/commands.ts` remains the Runtime-internal mutation protocol. Public
  Change variants lower to Core commands only inside Runtime.

The parity guard derives its queue from `DOCUMENT_COMMANDS` and `ASSET_COMMANDS`.
Every persisted document command maps to exactly one public capability;
`init_workspace` is Runtime initialization, and native OS/UI effects stay main
owned. Missing and duplicate owners both fail the guard.

## Public Capabilities

| Kind | Capabilities | Contract |
| --- | --- | --- |
| Local metadata | `version`, `status`, `capabilities`, `schema` | Runs without document access; `status` never starts Runtime. |
| Read | `find`, `show`, `export` | Resolves deterministic selectors and returns bounded Projections. |
| Observe | `watch` | Streams ordered resumable Events as JSONL. |
| Mutation kernel | `diff`, `apply` | Previews one ChangeSet, then atomically applies that exact Diff. |
| History | `log`, `revert`, `undo`, `redo` | Reads durable Operations or records a guarded reversal as another Operation. |
| Asset | `asset ingest`, `asset show`, `asset export` | Stages verified bytes, reads metadata, or streams verified bytes. |
| Porcelain mutation | `add`, `set`, `move`, `duplicate`, `merge`, `indent`, `outdent`, `done set`, `done cycle`, `tag add`, `tag remove`, `field define`, `field set`, `field clear`, `field remove`, `field reuse`, `field select`, `definition create`, `definition configure`, `definition merge`, `reference add`, `reference set`, `reference inline`, `reference restore`, `view set`, `view group set`, `view sort add`, `view sort set`, `view sort remove`, `view sort clear`, `view filter add`, `view filter set`, `view filter remove`, `view filter clear`, `view display add`, `view display set`, `view display remove`, `search create`, `search ensure-tag`, `search set`, `search refresh`, `template apply`, `daily ensure`, `capture add`, `media add`, `media set`, `trash`, `restore`, `purge` | Lowers one intent into the public ChangeSet contract. `--preview` returns its Diff; apply returns its Operation. |

`capabilities` is executable authority rather than a hand-maintained help list.
`schema` exposes the exact current JSON Schema for public types. Capability kind
and audit category drive host classification; execution context never removes a
public schema field or document capability.

`status` never starts Runtime. Absence is exactly `{ running: false }`. A live
result includes the Runtime instance, runtime and storage versions, document
revision, transaction/snapshot/Event sequences, verified and total log bytes,
torn/stale/inconsistent flags, pending-maintenance state, recovery lifecycle
counts, retained recovery bytes and budget, and orphan-blob count. Log health is
`healthy`, `degraded` while recoverable maintenance remains, or `blocked` when
the verified prefix is readable but mutation admission is closed.

## Selector And Projection

A `Selector` is independent of renderer state:

- `{ by: 'id', id }` selects one exact Node ID.
- `{ by: 'alias', alias }` selects `home`, `inbox`, `schema`, `trash`,
  `daily-notes`, or `today`.
- `{ by: 'date', date }` selects one canonical local date.
- `{ by: 'query', query, within?, includeTrash?, order?, limit }` uses the shared
  structured search grammar.

`TargetSpec` adds `one`, `zero-or-one`, or bounded `many` cardinality. Mutation
resolution never picks the first fuzzy match. Missing, ambiguous, over-limit,
or cardinality-invalid targets fail before any write.

A `Projection` chooses `summary`, `node`, `outline`, `backlinks`, `view`, or
`export`; it declares targets, bounded depth, included fields, pagination, and
format. Pagination cursors bind the Projection hash and revision. A Projection
contains document facts only, never selection, focus, expansion, pane placement,
sidebar pins, or Agent-specific filtering.

## ChangeSet

One mutation request carries one `outline.changeset` with optional base revision
and Node digests, idempotency key, source metadata, ordered operations, and
bounded return Projections. Operations use this stable top-level vocabulary:

| Change | Purpose |
| --- | --- |
| `resolve` | Resolve and bind an exact target set without changing state. |
| `ensure` | Resolve or create a canonical date, tag search, tag definition, or field definition, then bind it. |
| `create` | Create typed Node trees under one or many targets and optionally bind their IDs. |
| `update` | Apply ordered typed content, description, code, done, tag, field, reference, view, search, icon, banner, or image instructions. |
| `move` | Reparent or reorder bounded targets. |
| `duplicate` | Copy bounded targets to an explicit destination and optionally bind the copies. |
| `merge` | Merge Nodes or compatible definitions under Core invariants. |
| `template` | Apply tag-template backfill to the Diff-computed affected set. |
| `lifecycle` | Trash, restore, or purge bounded targets. |

Bindings are unique within one ChangeSet, cannot be forward-referenced, and
freeze their ordered target set. They let a later change consume a resolved,
ensured, created, or duplicated result without another process round trip.
`NodeDraft` and every update instruction are typed unions; the public contract
does not accept a generic property bag, JSON Patch, or serialized Core command.

Normalization validates schema and limits, resolves all selectors at one base
revision, assigns new IDs, records target and structural-parent preconditions,
lowers porcelain, executes Core validation on a disposable frontier, and hashes
canonical JSON. Invalid semantic keys, unresolved bindings, protected targets,
or stale preconditions write nothing.

`diff --input-format jsonl` uploads a header, bounded operation records, and a
count/SHA-256 trailer as a stream. After transport authentication, Runtime writes
the upload to a `0700` private spool directory using a `0600` temporary file,
checks the 64 MiB upload and 8 MiB record bounds while receiving it, then parses
and validates records incrementally. Runtime removes the spool file on success
or failure. An idempotency key supplied by the CLI is checked or injected only
after the trailer digest authenticates the uploaded ChangeSet.

## Diff, Apply, And Operations

`diff` normalizes a ChangeSet and returns an `outline.diff` containing its
canonical normalized ChangeSet, hashes, base revision, bindings, affected
before/after digests, destructive summary, warnings, and size estimate. It does
not advance document revision, create an Operation, or retain staged assets.

`apply` accepts the reviewed Diff, not an unreviewed private mutation. Runtime
rechecks its hashes, base revision, target digests, asset leases, and destructive
acknowledgement before executing. Purge and empty-Trash flows require a Diff-bound
explicit acknowledgement; acknowledgement alone is insufficient.

Human destructive porcelain on a TTY first prints the exact Runtime-produced
Diff and asks for confirmation. Acceptance submits that same artifact to
`apply`; rejection writes nothing, and a revision change during review returns a
stale conflict without recomputing or retrying. JSON and non-TTY callers must
provide both `--yes` and either a reviewed Diff artifact or `--expect-diff`.

Canonical Diff responses stream from Runtime while SHA-256 and byte count advance
over the same chunks. Results up to 8 MiB may be collected into the single JSON
envelope. Larger results require an atomic `--output` file or raw `--output -`;
the client verifies response identity, length, and digest as the stream is
consumed and never retains the whole encoded artifact merely to hash it.

Apply is atomic. Runtime keeps Core rollback live until one fsynced transaction
record contains the document update, Operation, recovery patch, idempotency
receipt, asset-reference delta, and Event sequence. Only then does it return the
`outline.operation`. Any validation, execution, encode, capacity, or durability
failure leaves document state, projections, history, and asset reachability
unchanged.

An Operation records origin, optional trusted causation, source, summary,
bounded affected IDs plus complete-set count/hash, before/after revisions,
recovery state, and requested bounded result Projections. `revert` checks the
retained recovery patch and current affected state; a conflict returns a typed
`RevertConflictDiff` in `revert_conflict.error.details.conflictDiff` and writes
nothing. The Diff identifies each changed Node precondition by its expected
post-Operation and actual digest. A successful revert is a new Operation linked to its target.
`undo` and `redo` are convenience selection over the same retained history and
do not expose a separate stack authority.

`log` returns an `OperationLogPage` in newest-first order. Opaque cursors bind
the origin, Thread/Turn/Item causation, affected-Node, Operation, and idempotency
filters used to create the page. `log --operation OPERATION_ID` also pages the
complete affected-Node IDs from retained recovery data; the bounded cursor on a
truncated Operation resumes the same affected-ID sequence. Expired recovery is
reported explicitly rather than returning an incomplete affected set.

Idempotency keys are scoped to workspace and protocol major. Reuse with the same
canonical payload returns the settled Operation; reuse with another payload is a
conflict. Clients never automatically retry after an unknown apply settlement.

## Events And Desktop Intents

Every commit appends ordered `projection.changed`, `operation.committed`,
`operation.reverted`, or recovery-lifecycle Events. `watch` resumes from an
opaque cursor and emits `resync.required` when retained history cannot bridge a
gap. Desktop adapters convert projection Events to the renderer's incremental
`ProjectionUpdate`; revision gaps trigger a complete Projection read.

Recovery expiry appends its maintenance record before removing unreferenced
blobs and emits `operation.recovery-expired` with the expired Operation and patch
IDs. Its cursor uses the active Runtime instance, current document revision, and
durable Event sequence, so a live watcher can resume across maintenance.

Renderer intent helpers in `src/renderer/api/outlineIntents.ts` map UI actions to
public Changes. Main-side actions use `src/main/outlineActionCommands.ts` for the
same purpose. These adapters may add local `FocusHint` behavior, but they contain
no Core switch, persistence logic, selector implementation, or alternate write
path.

Composer Node references remain renderer draft state until submission. Sending
one to Agent Core does not mutate the document. Launcher capture is a trusted
main-owned intent that builds the same public capture ChangeSet.

## Assets And Native Effects

`asset ingest` accepts a path, stdin, or bounded bytes and returns a staged lease
with exact size, lowercase SHA-256, MIME type, filename, and derived metadata.
The Runtime verifies stored bytes on reads and exports. A document ChangeSet
that references the lease atomically makes the logical asset reachable.

Physical bytes remain while referenced by a live Node, unexpired lease, or
retained recovery patch. Garbage collection is internal and recovery aware;
there is no public asset-delete capability.

Native file pickers, trusted Agent-file resolution, managed Thread-resource
reads, local open policy, Finder reveal, clipboard file flavors, and external URL
opening stay in Electron main. They may stage or export through the Runtime but
never mutate document state directly.

## Agent Core And Settings

The renderer sends strict `agentCoreRequest(method, input)` requests through
preload and subscribes to canonical notifications. Thread, Turn, Item, Goal,
user-input, Automation, and Agent lifecycle methods remain owned by the Agent
Core codecs and `ThreadService`; they are not added to the Outline capability
registry.

Provider, runtime, capability, OAuth, Skill-management, application Settings,
and update commands remain Electron-main IPC. They cannot read or mutate the
Outliner except by acting as an ordinary authenticated Runtime client.

## Invariants

- Every persisted mutation from desktop, CLI, built-in Agent, import, or
  external automation follows the same ChangeSet -> Diff -> Operation path.
- Agent causation changes immutable attribution, not public capability or
  projection shape. Only host attestation can record built-in Agent causation.
- Runtime is the only process importing Core, Loro document state, transaction
  storage, recovery storage, or the asset index.
- Public schema validation and conflict checks happen before write admission.
- Renderer and Electron main never open workspace persistence directly.
- Adding a Core document command requires exactly one capability owner; adding a
  public capability requires schema, admission, CLI, audit, and parity coverage.
