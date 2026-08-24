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
  Projection, ChangeSet, Diff, Operation, Event, asset, response, and stream
  schemas. Runtime request and descriptor schemas remain private transport
  implementation.
- `src/outline/contract/capabilities.ts` is the executable public capability
  registry. Each entry owns its name, exact CLI request and result schema,
  command-family placement, help and completion metadata, parser options,
  streaming/destructive flags, mutation semantics, audit category, summary,
  examples, and coverage.
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
| Porcelain mutation | `add`, `set`, `text replace`, `move`, `duplicate`, `merge`, `indent`, `outdent`, `done set`, `done cycle`, `tag add`, `tag remove`, `field define`, `field set`, `field clear`, `field remove`, `field reuse`, `field select`, `definition create`, `definition configure`, `definition merge`, `reference add`, `reference set`, `reference inline`, `reference restore`, `view set`, `view group set`, `view sort add`, `view sort set`, `view sort remove`, `view sort clear`, `view filter add`, `view filter set`, `view filter remove`, `view filter clear`, `view display add`, `view display set`, `view display remove`, `search create`, `search ensure-tag`, `search set`, `search refresh`, `template apply`, `daily ensure`, `capture add`, `media add`, `media set`, `trash`, `restore`, `purge` | Lowers one intent into the public ChangeSet contract. `--preview` returns its Diff; apply returns its Operation. |

`capabilities` is executable authority rather than a hand-maintained help list.
`outline --help`, family help, exact command help, shell completion metadata,
parser option admission, `outline schema COMMAND`, and the built-in Skill's
generated `references/commands.md` derive from that registry.
Porcelain command schemas describe their resource-specific input rather than the
generic Runtime MutationInput. Drift tests compare the exact published options,
schemas, positionals, completion data, and generated Agent command inventory.
Capability kind and audit category drive host classification; execution context
never removes a public schema field or document capability.

Root help lists command families and direct commands. Family help lists its
subcommands. Exact command `--help` and `-h` show syntax, positionals, options,
defaults, selectors, cardinality, argv versus `--input FILE|-`, output,
create/patch/replace/ensure/destructive and idempotency semantics, plus two or
three canonical examples. Destructive help requires `--preview`, reviewed
`--expect-diff`, and `--yes`, and states that `--yes` alone is invalid. Help is
plain text even with `--json` or `--human` and runs without Runtime. Unknown
paths/options and missing arguments provide the nearest command or exact help
next step.

Non-TTY stdout defaults to one versioned JSON response envelope, or JSONL for a
stream. `--human` forces human presentation and `--json` explicitly forces the
machine form; combining them is invalid. Output mode never changes selection,
mutation, or error semantics. `SIGINT` and `SIGTERM` abort every command path and
use exit codes 130 and 143 respectively.

### Porcelain intent routing

The public product rule is:

- one complete resource intent uses one porcelain invocation;
- complex state for that resource uses the same command with `--input FILE|-`;
- multiple resources, dependencies, cross-date work, or bounded bulk edits use
  one ChangeSet with bindings, one Diff, and one apply.

No common flow requires a shell mutation loop, intermediate created-ID lookup,
or multiple mutation Operations. Create and ensure results include created or
bound IDs through the Operation result's bounded Projection. Common
single-resource writes also return the smallest bounded Projection that
identifies or verifies their primary target. The convenience Projection is not
independent verification; callers still use `show`, `find`, or `log` when the
workflow requires a separate observation. Repeated `set`,
`configure`, and `ensure` calls converge or return `outline.no-change` without
creating another Operation. `create` and `add` remain explicit creation.

`add` accepts a complete typed `NodeDraft` tree, including rich content,
description, code, checkbox/done state, tags, fields, references, media, and
children. `definition create` owns complete reusable tag/field definitions and
their type-specific configuration, templates/options, defaults, inheritance,
and constraints. `field define` instead creates or reuses a field on one target
and may set its initial value. `tag add` applies an existing definition.

`search create` accepts title, canonical query or `--match` STRING_MATCH
shorthand, and initial mode, ordered sort, filters, group, display fields, and
toolbar state. Its default parent is `@saved-searches`. `search set` atomically
patches Search title/query/view state and refreshes materialized results. `view
set` applies one complete declarative view patch; omitted properties preserve
state and only its explicit `replace` object replaces sort/filter/display
collections. The view leaf commands remain for small edits.

`capture add` accepts exactly one parent or local date, ensures the date when
needed, preserves capture provenance, and creates its typed child tree in the
same Operation. `media add` accepts a local path or stdin, stages the asset lease,
and creates the image/attachment Node in one invocation. `asset ingest` remains
the explicit primitive for automation that deliberately separates staging and
review. Root `set` patches generic Node properties; `media set` owns media
source/geometry; `search set` owns Search query/view configuration.

`text replace` is a general bounded literal transform over Node content,
description, or both. It accepts one exact target, STRING_MATCH `--matching`
shorthand, or the canonical structured query. Query selection requires an
explicit Node `max`; `max-replacements` independently bounds total matches across
the selection. Planning reads one bounded Projection and writes its revision into
the ChangeSet base, so an intervening mutation invalidates exact apply. The
transform preserves marks and inline references outside replacement ranges and
rejects a range that would consume an inline reference. It lowers to ordinary
text-patch updates, requires destructive Diff review, creates one Operation, and
returns semantic no-change when repeated after convergence.

`status` never starts Runtime. Absence is exactly `{ running: false }`. A live
result includes the Runtime instance, exact contract digest, runtime and storage
versions, document revision, transaction/snapshot/Event sequences, verified and
total log bytes,
torn/stale/inconsistent flags, pending-maintenance state, recovery lifecycle
counts, retained recovery bytes and budget, and orphan-blob count. Log health is
`healthy`, `degraded` while recoverable maintenance remains, or `blocked` when
the verified prefix is readable but mutation admission is closed.

## CLI And Runtime Boundary

The supported integration boundary is the `outline` CLI plus its public domain
schemas, response envelope, and stream records. The Unix socket, HTTP routes,
descriptor, bearer token, and `OutlineRequest` envelope are private and may
change with the bundled product. `outline schema` therefore does not publish
`OutlineRequest` or `RuntimeDescriptor`.

CLI and Runtime currently ship together. The Runtime descriptor and live status
both carry the SHA-256 digest of the canonical capability manifest. Every attach
compares both values with the bundled CLI digest, including ordinary commands;
same-major drift fails closed with `protocol_incompatible`. Minor-version
negotiation is deferred until CLI and Runtime can be distributed independently.

Startup discovery uses `--startup-timeout`, defaulting to 10 seconds. Every
request, response body, upload, asset transfer, and stream has a separate hard
`--timeout`, defaulting to 60 seconds and capped at 300 seconds. A live process
with an unresponsive socket therefore settles as unavailable instead of hanging.
Both deadlines compose with the caller's `AbortSignal`.

## Selector And Projection

A `Selector` is independent of renderer state:

- `{ by: 'id', id }` selects one exact Node ID.
- `{ by: 'alias', alias }` selects `home`, `inbox`, `schema`, `trash`,
  `daily-notes`, `library`, `saved-searches`, or `today`.
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
bounded return Projections. The CLI generates `cli:<uuid>` before dispatch when
porcelain or direct `diff` input does not provide a key; direct `diff` fixes the
key into the reviewed artifact. Operations use this stable top-level vocabulary:

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
acknowledgement before executing. Node/definition merge, purge, and empty-Trash
flows require a Diff-bound explicit acknowledgement; acknowledgement alone is
insufficient.

Human destructive porcelain on a TTY first prints the exact Runtime-produced
Diff and asks for confirmation. Acceptance submits that same artifact to
`apply`; rejection writes nothing, and a revision change during review returns a
stale conflict without recomputing or retrying. JSON and non-TTY callers must
provide both `--yes` and either a reviewed Diff artifact or `--expect-diff`.
Porcelain preview and apply invocations use the same `--idempotency-key`; a new
key changes the normalized Diff and therefore its hash. `--yes` alone is
rejected by the parser.

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

Operation summaries aggregate ChangeSet operations by change kind, so their
encoded size remains bounded even when one legal ChangeSet contains tens of
thousands of leaf operations.

`log` returns an `OperationLogPage` in newest-first order. Opaque cursors bind
the origin, Thread/Turn/Item causation, affected-Node, Operation, and idempotency
filters used to create the page. `log --operation OPERATION_ID` also pages the
complete affected-Node IDs from retained recovery data; the bounded cursor on a
truncated Operation resumes the same affected-ID sequence. Expired recovery is
reported explicitly rather than returning an incomplete affected set.

Idempotency keys are scoped to workspace and protocol major. Reuse with the same
canonical payload returns the settled Operation; reuse with another payload is a
conflict. `revert`, `undo`, and `redo` also carry durable CLI-generated keys.
`apply` rejects an unkeyed Diff instead of modifying reviewed content. Clients
never automatically retry after an unknown settlement. A timeout, disconnect,
`SIGINT`, or `SIGTERM` after mutation dispatch returns
`operation_settlement_unknown`, includes the exact key, and names the precise
next command: `outline log --idempotency-key KEY`.

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
