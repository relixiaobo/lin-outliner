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

- `src/outline/contract/schemas.ts` defines the exact QueryExpression, Selector,
  TargetSpec, placement, Projection, ChangeSet, Diff, Operation, Event, asset,
  response, and stream schemas. Runtime request and descriptor schemas remain
  private transport implementation.
- `src/outline/contract/queryOperators.ts` owns every executable public query
  operator, its exact required and optional operands, value format, summary, and
  canonical example. The generated QueryExpression schema excludes internal but
  non-executable operators.
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
| Mutation kernel | `diff`, `commit`, `apply` | Previews one ChangeSet, directly commits a non-destructive ChangeSet, or atomically applies one exact reviewed Diff. |
| History | `log`, `revert`, `undo`, `redo` | Reads durable Operations or records a guarded reversal as another Operation. |
| Asset | `asset ingest`, `asset show`, `asset export` | Stages verified bytes, reads metadata, or streams verified bytes. |
| Porcelain mutation | `add`, `set`, `text replace`, `move`, `duplicate`, `merge`, `indent`, `outdent`, `done set`, `done cycle`, `tag add`, `tag remove`, `field define`, `field set`, `field clear`, `field remove`, `field reuse`, `field select`, `definition create`, `definition configure`, `definition merge`, `reference add`, `reference set`, `reference replace`, `reference inline`, `reference restore`, `view set`, `view group set`, `view sort add`, `view sort set`, `view sort remove`, `view sort clear`, `view filter add`, `view filter set`, `view filter remove`, `view filter clear`, `view display add`, `view display set`, `view display remove`, `search create`, `search ensure-tag`, `search set`, `search refresh`, `template apply`, `daily ensure`, `capture add`, `media add`, `media set`, `trash`, `restore`, `purge` | Lowers one intent into the public ChangeSet contract. `--preview` returns its Diff; destructive or review-bound writes apply an exact Diff, while ordinary non-destructive writes may commit directly. |

`capabilities` is executable authority rather than a hand-maintained help list.
`outline --help`, family help, exact command help, shell completion metadata,
parser option admission, `outline schema COMMAND`, and the built-in Skill's
generated `references/commands.md` derive from that registry.
Porcelain command schemas describe their resource-specific input rather than the
generic Runtime MutationInput. Drift tests compare the exact published options,
schemas, positionals, completion data, and generated Agent command inventory.
Capability kind and audit category drive host classification; execution context
never removes a public schema field or document capability.

`outline schema COMMAND` returns only the compact request schema by default.
`--part result` returns the result schema and `--part both` returns the explicit
request/result pair. Named public schemas such as `ChangeSet` and
`QueryExpression` retain their direct shape, reject `--part`, and use the same
compaction. Schema compaction hoists reusable cyclic definitions into one root
`$defs`; every published command request and named public schema is bounded to
512 KiB and guarded against duplicated nested `$defs` expansion.

CLI and Runtime schema rejection returns bounded structured validation details.
For a union, the validator follows the best matching discriminated branch before
collecting issues, so errors identify useful JSON Pointer paths instead of
exhausting the issue limit on unrelated alternatives. Details include path,
schema path, keyword, and message, but never echo the rejected input value.

Root help lists command families and direct commands. Family help lists its
subcommands. Exact command `--help` and `-h` show syntax, positionals, options,
defaults, selectors, cardinality, argv versus `--input FILE|-`, output,
create/patch/replace/ensure/destructive and idempotency semantics, plus two or
three canonical examples. Destructive help requires `--preview`, reviewed
`--expect-diff`, and `--yes`, and states that `--yes` alone is invalid. Help is
plain text even with `--json` or `--human` and runs without Runtime. Unknown
paths/options and missing arguments provide the nearest command or exact help
next step.

Advanced query help and completion metadata use the same executable operator
registry as `QueryExpressionSchema` and the generated Agent command reference.
`outline schema QueryExpression` is the exact public grammar. Each rule is a
closed operator-specific object: required field, tag, target, or value operands
cannot be omitted, unrelated operands cannot be supplied, and an operator absent
from that schema is not a supported CLI operator.

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

No complete command intent requires a shell mutation loop, intermediate
created-ID lookup, or several mutation Operations. Create and ensure results
include created or bound IDs through the Operation result's bounded Projection.
Common single-resource writes also return the smallest bounded Projection that
identifies or verifies their primary target. The convenience Projection is not
independent verification; callers still use `show`, `find`, or `log` when the
workflow requires a separate observation. Ordinary focused editor typing may
settle as several low-latency direct-commit Operations; when the renderer marks
adjacent materialize/text-patch Operations with the same text-edit undo group,
Runtime undo/redo selection treats them as one user action. Repeated `set`,
`configure`, and `ensure` calls converge or return `outline.no-change` without
creating another Operation. `create` and `add` remain explicit creation.

`add` accepts a complete typed `NodeDraft` tree, including rich content,
description, code, checkbox/done state, tags, fields, references, media, and
children. Authored Node IDs use the canonical `node:<uuid>` form: a lowercase
RFC 4122 variant v4 UUID matching the Core client-ID validator and every
Runtime-generated public Node ID. `NodeDraft` metadata is closed: capture
metadata uses the complete shared capture-provenance schema, query metadata uses
the public query grammar, and paste metadata may carry `pasteTags` plus
`pasteFields` so structured paste and slash-trigger trees preserve semantic
tags/fields through field-slot append paths. Arbitrary JSON is not admitted, and
invalid IDs, field types, or nested provenance are rejected at CLI and Runtime
admission with no write. `definition create` owns complete reusable tag/field
definitions and their type-specific configuration, templates/options, defaults,
inheritance, and constraints. `field define` instead creates or reuses a field on
one target and may set its initial value; an empty field name is valid only as an
editor placeholder slot and is still recorded through the public schema rather
than a renderer-only command. `tag add` applies an existing definition.

`search create` accepts title, canonical query or `--match` STRING_MATCH
shorthand, and initial mode, ordered sort, filters, group, display fields, and
toolbar state. Its default parent is `@saved-searches`. `search set` atomically
patches Search title/query/view state and refreshes materialized results. `view
set` applies one complete declarative view patch; omitted properties preserve
state and only its explicit `replace` object replaces sort/filter/display
collections. The view leaf commands remain for small edits.

A real table is represented by one owner Node with `viewMode: table`, direct
child row Nodes, reusable field definitions, field-backed cell values, and an
explicit display/sort/filter configuration. The built-in Skill's
`fixtures/table-view-changeset.json` is the canonical executable example: the
mandatory golden flow reads that fixture, creates the table below an ensured
Daily Note through one Diff/apply, verifies its fields/view, and exactly reverts
it. Markdown tables, aligned child text, and owner Nodes without a table
`viewDef` do not satisfy a table request.

`capture add` accepts exactly one parent or local date, ensures the date when
needed, preserves capture provenance, derives a canonical HTTP(S) Source from the
capture metadata when present, and creates its typed child tree in the same
Operation. The dedicated `source add`, `source replace`, `source reorder`,
`source remove`, and `source clear` commands own direct values under the protected
Source entry. `asset ingest` remains the explicit primitive for automation that
deliberately separates staging and review; the reviewed ChangeSet then adds its
canonical managed Source to an ordinary Node. Root `set` patches generic Node
properties, while `search set` owns Search query/view configuration.

Create, move, and duplicate use a public placement union rather than loosely
coupled parent/index fields. Destination placement is `first(parent)`,
`last(parent)`, `index(parent, index)`, `before(sibling)`, or `after(sibling)`.
Move and duplicate additionally accept `previous` and `next`; move shifts the
selected sibling block, while duplicate places each copy immediately before or
after its source. Porcelain exposes the same choices as `--first`, `--last`,
`--index`, `--before`, `--after`, `--previous`, and `--next`.

Reference commands have non-overlapping semantics. `reference set` retargets an
existing reference and rejects a content Node. `reference replace` inserts a tree
reference at a content Node's position and moves the complete original subtree to
Trash. `reference inline` converts a tree reference to inline form or replaces a
content Node with an inline reference. The argv shorthand may omit `REFERENCE`
only when `TARGET` is already a tree reference; content replacement and
structured input require an explicit reference target. Each is one reversible
Operation.

`text replace` is a general bounded literal transform over Node content,
description, or both. It accepts one exact target, STRING_MATCH `--matching`
shorthand, or the canonical structured query. Query selection requires an
explicit Node `max`; `max-replacements` independently bounds total matches across
the selection. Planning reads one bounded Projection and writes its revision into
the ChangeSet base, so an intervening mutation invalidates exact apply. The
transform preserves marks and inline references outside replacement ranges and
rejects a range that would consume an inline reference. It lowers to ordinary
text-patch updates carrying an explicit reviewed-replace marker, requires
destructive Diff review, creates one Operation, and returns semantic no-change
when repeated after convergence. Unmarked text-patch updates, including
`replace_all` patches produced by normal rich-text editor synchronization, are
ordinary reversible edits and do not require destructive acknowledgement.

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
same-major drift fails closed before any public command executes. When automatic
start is enabled, an authenticated Runtime whose private descriptor and writer
lock prove the same process identity is retired within the startup deadline and
replaced by the bundled Runtime. A legacy Runtime without the private retirement
route receives `SIGTERM` only after those checks. `status`, `--no-start`, an
unowned descriptor, or an unverifiable live identity remains
`protocol_incompatible` and never changes process state. Minor-version
negotiation is deferred until CLI and Runtime can be distributed independently.

Startup discovery uses `--startup-timeout`, defaulting to 10 seconds. Every
request, response body, upload, asset transfer, and public CLI stream has a
separate hard `--timeout`, defaulting to 60 seconds and capped at 300 seconds. A
live process with an unresponsive socket therefore settles as unavailable
instead of hanging. Both deadlines compose with the caller's `AbortSignal`.
Desktop Event subscriptions use the command deadline only until the first
validated `hello`; after that, cancellation, transport closure, or a Runtime
`end` record owns their lifetime.

The public `commit` and `apply` capabilities always use durable settlement. The
renderer does not receive a generic private Runtime router: its sender-checked
desktop IPC allowlist exposes the ordinary accepted mutation route, bounded
reads/search, byte upload and picker-owned asset actions, and lifecycle methods.
It cannot submit path-backed ingest/export or arbitrary public capabilities.

An accepted desktop receipt contains the exact `Operation` or no-change result,
the `ProjectionUpdate`, and the reviewed/direct Diff needed for local focus
derivation. A changed receipt is recorded with the transaction-log idempotency
entry and can be replayed exactly after Runtime restart for as long as that
Operation remains retained. Semantic no-change has no transaction record or
Event, so its exact accepted receipt is reused only by the live Runtime process.
The desktop client keeps these idempotency keys resident for sustained editing
rather than evicting unresolved accepted results.

## Selector And Projection

A `Selector` is independent of renderer state:

- `{ by: 'id', id }` selects one exact Node ID.
- `{ by: 'ids', ids }` selects an ordered, unique list of exact Node IDs.
- `{ by: 'alias', alias }` selects `home`, `inbox`, `schema`, `trash`,
  `daily-notes`, `library`, `saved-searches`, or `today`.
- `{ by: 'date', date }` selects one canonical local date.
- `{ by: 'search', id, limit }` executes one Saved Search live and does not trust
  or refresh its materialized reference children.
- `{ by: 'query', query, within?, includeTrash?, order?, limit }` uses the shared
  structured search grammar.

Query resolution evaluates the complete match set, removes Trash unless
`includeTrash` is true, applies `within`, and applies the requested stable order
before taking `limit`. The limit therefore bounds the final selector result, not
an intermediate relevance-ranked candidate set.

`show ID...` lowers multiple exact IDs to one ordered `ids` selector. Runtime
defaults lower `ids`, `query`, and `search` selectors to bounded `many` targets
using the selector's exact list length or declared limit; exact IDs, aliases, and
dates lower to `one`. `show` and `export` also accept a complete Projection with
no redundant Selector. If both are supplied, they must declare the same Selector,
and standalone read Projections cannot use ChangeSet bindings.

`find
--count` returns an exact count without a Node payload; `find --input` can return
several uniquely named counts with one optional `sharedQuery`, combined with each
query using canonical `AND`. One request builds and reuses its text selection
index. `find --search SEARCH_ID` executes a Saved Search live, including stale
materialized searches, and can also return an exact count.

`TargetSpec` adds `one`, `zero-or-one`, or bounded `many` cardinality. Mutation
resolution never picks the first fuzzy match. Missing, ambiguous, over-limit,
or cardinality-invalid targets fail before any write.

A `Projection` chooses `summary`, `node`, `outline`, `backlinks`, `view`, or
`export`; it declares targets, bounded depth, included fields, pagination, and
format. Pagination cursors bind the Projection hash and revision. A Projection
contains document facts only, never selection, focus, expansion, pane placement,
sidebar pins, or Agent-specific filtering.

`include` is an allow-list for optional Node metadata. In particular, `fields`
admits field-definition linkage, `view` admits view/sort/filter/display/query
metadata, `trash` admits the original-parent linkage used for restoration, and
`backlinks` returns a separate bounded backlinks collection without replacing the
selected Node result. Each Projection builds one reference summary and reuses it
across every selected target and page slice; pagination never triggers one
whole-document backlink scan per target. When one of these values is absent, its
metadata is redacted from Node results.

## ChangeSet

One mutation request carries one `outline.changeset` with optional base revision
and Node digests, idempotency key, source metadata, ordered operations, and
bounded return Projections. The CLI generates `cli:<uuid>` before dispatch when
porcelain or direct `diff` input does not provide a key; direct `diff` fixes the
key into the reviewed artifact. Desktop and Electron-main mutations, previews,
and history actions generate `desktop:<uuid>` keys. Operations use this stable
top-level vocabulary:

| Change | Purpose |
| --- | --- |
| `resolve` | Resolve and bind an exact target set without changing state. |
| `ensure` | Resolve or create a canonical date, tag search, tag definition, or field definition, then bind it. |
| `create` | Create typed Node trees at one explicit destination placement and optionally bind their IDs. |
| `update` | Apply ordered typed content, description, code, done, tag, field, reference, view, search, icon, banner, or image instructions. |
| `move` | Reparent or reorder bounded targets through one explicit placement. |
| `duplicate` | Copy bounded targets through one explicit placement and optionally bind the copies. |
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

Validation covers the complete semantic frontier before commit. Changing a field
definition type validates every existing value against the proposed type.
Lifecycle targeting collapses selected ancestors and descendants so Trash moves
each covered subtree once and never strands descendants. These checks apply to
desktop and CLI callers through the same ChangeSet executor.

`diff --input-format jsonl` uploads a header, bounded operation records, and a
count/SHA-256 trailer as a stream. After transport authentication, Runtime writes
the upload to a `0700` private spool directory using a `0600` temporary file,
checks the 64 MiB upload and 8 MiB record bounds while receiving it, then parses
and validates records incrementally. Runtime removes the spool file on success
or failure. An idempotency key supplied by the CLI is checked or injected only
after the trailer digest authenticates the uploaded ChangeSet.

## Diff, Commit, Apply, And Operations

`diff` normalizes a ChangeSet and returns an `outline.diff` containing its
canonical normalized ChangeSet, hashes, base revision, bindings, affected
before/after digests, destructive summary, warnings, and size estimate. It does
not advance document revision, create an Operation, or retain staged assets.

`commit` accepts the same ChangeSet contract and uses the same normalization,
selector, binding, asset-lease, idempotency, transaction-log, recovery, and
Operation semantics as `diff` followed by `apply`, but skips constructing a
reviewed Diff artifact. It is only valid for non-destructive writes. Runtime
rejects purge, empty-Trash purge, merge, and explicitly reviewed destructive text
replacement on this path with `confirmation_required`; those calls must use
`diff` followed by `apply`.

`apply` accepts the reviewed Diff, not an unreviewed private mutation. Runtime
rechecks its hashes, base revision, target digests, asset leases, and destructive
acknowledgement before executing. Node/definition merge, purge, and empty-Trash
flows require a Diff-bound explicit acknowledgement; acknowledgement alone is
insufficient.

After payload hash and key validation, Runtime resolves an existing idempotency
receipt before base-revision and Node-precondition checks. Reviewed apply binds
the key to the canonical Diff payload. Direct commit binds the key to the
original submitted ChangeSet payload, then records the normalized ChangeSet hash
on the Operation. The same key and canonical payload returns the original
Operation even when its base is now historical; the same key with another payload
remains an idempotency conflict.

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
recovery state, optional text-edit undo-group metadata, and requested bounded
result Projections. `revert` checks one retained recovery patch and current
affected state; a conflict returns a typed
`RevertConflictDiff` in `revert_conflict.error.details.conflictDiff` and writes
nothing. The Diff identifies each changed Node precondition by its expected
post-Operation and actual digest. A successful `revert OPERATION_ID` is a new
Operation linked to that exact target through `revertsOperationId`.
`undo` and `redo` are convenience selection over the same retained history and
do not expose a separate stack authority. They default to the authenticated
caller's origin, accept an explicit `--origin` scope, and can require the visible
stack head with `--expect-operation`. Consecutive available Operations with the
same text-edit `undoGroup.groupId` are selected together; the group recovery
Operation links the visible stack head in `revertsOperationId` and the complete
covered ordered set in `revertsOperationIds`. A mismatched guard returns a
conflict and creates no Operation.

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
conflict. `commit`, `revert`, `undo`, and `redo` also carry durable CLI-generated
keys. `apply` rejects an unkeyed Diff instead of modifying reviewed content.
Clients never automatically retry after an unknown settlement. A timeout,
disconnect, `SIGINT`, or `SIGTERM` after mutation dispatch returns
`operation_settlement_unknown`, includes the exact key, and names the precise
next command: `outline log --idempotency-key KEY`.

Semantic no-change returns `outline.no-change` at the current revision without
creating an Operation or Operation Event. Desktop clients consume that result
directly, refresh or reuse their current Projection as appropriate, and never
wait for an Operation Event that cannot exist.

## Events And Desktop Intents

Every commit appends ordered `projection.changed`, `operation.committed`,
`operation.reverted`, or recovery-lifecycle Events. `watch` resumes from an
opaque cursor and emits `resync.required` when retained history cannot bridge a
gap. Desktop adapters convert projection Events to the renderer's incremental
`ProjectionUpdate`; revision gaps trigger a complete Projection read.

For an ordinary initiating desktop edit, the accepted update is the first
authoritative fold. Its later durable Event is a same-revision confirmation and
is deduplicated; other windows fold that Event as propagation. An Event that
arrives before the accepted response is held until that response can advance the
mutation base. Held Events never advance a renderer subscription's folded
projection frontier. This keeps the admission revision and visible projection
revision aligned without applying one logical edit twice.

A watch that requests an attached Projection may receive one only when Runtime
can produce it at that Event's revision. If replay reaches a historical Event
whose Projection cannot be reconstructed, Runtime emits one `resync.required`
and closes instead of attaching the current workspace Projection to old history.

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
with logical asset/lease IDs, exact byte size, MIME type, filename, and derived
metadata. Public results never expose a physical digest, anchor, or ContentStore
path. The Runtime resolves the logical AssetRecord and ContentStore verifies its
exact revision on reads and exports. A document ChangeSet that references the
lease atomically makes the logical asset reachable.

Runtime retains logical records while protected by a live Node, unexpired lease,
or retained recovery patch. It durably removes an unreachable record before
releasing its opaque anchor; central ContentStore GC then collects only revisions
with no admission lease or retention anchor. There is no public asset-delete
capability. File export reports only destination and byte count.

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
  external automation follows the same public ChangeSet routing: direct
  non-destructive commit, or reviewed Diff apply when review/destructive
  semantics require it.
- Agent causation changes immutable attribution, not public capability or
  projection shape. Only host attestation can record built-in Agent causation.
- Runtime is the only process importing Core, Loro document state, transaction
  storage, recovery storage, or the asset index.
- Public schema validation and conflict checks happen before write admission.
  Process boundaries compile and cache validators from the exact registry
  schema object; large recursive ChangeSets, Diffs, normalized imports, and
  response envelopes do not fall back to interpretive union validation.
- Renderer and Electron main never open workspace persistence directly.
- Adding a Core document command requires exactly one capability owner; adding a
  public capability requires schema, admission, CLI, audit, and parity coverage.
