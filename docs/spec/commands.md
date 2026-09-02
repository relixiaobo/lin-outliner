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
  receipt family, command-family placement, help and completion metadata, parser options,
  streaming/destructive flags, mutation semantics, audit category, summary,
  examples, and coverage.
- `src/outline/contract/recipes.ts` owns bounded executable examples for common
  structured variants. Recipe stdin is validated against the same authoring
  schema used by the production parser.
- `src/core/commands.ts` remains the Runtime-internal mutation protocol. Public
  Change variants lower to Core commands only inside Runtime.

The parity guard derives its queue from `DOCUMENT_COMMANDS` and `ASSET_COMMANDS`.
Every persisted document command maps to exactly one public capability;
`init_workspace` is Runtime initialization, and native OS/UI effects stay main
owned. Missing and duplicate owners both fail the guard.

## Public Capabilities

The public CLI is organized by user intent. UI gestures and Core storage steps
are not public commands.

| Intent | Capabilities |
| --- | --- |
| Local discovery | `version`, `status`, `capabilities`, `example`, `schema` |
| Observe | `get`, `find`, `export`, `watch` |
| Author | `create`, `edit`, `replace text` |
| Organize | `move`, `duplicate`, `merge` |
| Define | `define create`, `define ensure`, `define edit` |
| Present | `view get`, `view set` |
| Query | `search create`, `search edit`, `search run` |
| Lifecycle | `trash`, `restore`, `purge` |
| Advanced | `transact`, `preview`, `apply` |
| Recovery | `history`, `revert`, `undo`, `redo` |
| Specialized | `asset ingest|get|export`, `import inspect|plan|verify`, `capture create`, `template apply`, `daily ensure` |

`capabilities` is executable authority. Root help, family help, exact command
help, completion metadata, parser admission, schema disclosure, recipes,
permissions, receipts, and tests derive from the same registry. There are no
public compatibility aliases for retired command names.

### Logical model

A **Node** is the only content and ordered-tree identity. A row, card, calendar
item, and outline item are the same Node under different presentation.

A **Field** is a reusable typed definition. Field values belong to Nodes and
point to that definition. A local key inside one authoring request connects a
declaration, Node values, and View display; it is not persisted as another
identity.

A **View** is projection configuration over a Node scope. Public modes are
`outline`, `table`, `cards`, and `calendar`. Core may encode Outline as
`list`, but that token never appears in public author input or results. Every
scope has an effective Outline View when no explicit configuration is stored.
Changing View mode or configuration never copies, reparents, converts, or
rewrites Nodes or Field values.

An **Operation** is the atomic settlement and recovery unit. One complete intent
creates at most one Operation. Rejected and semantic no-change requests create
none. A successful semantic receipt is derived from the committed revision and
contains the Operation identity, bounded result handles, verification evidence,
and exact recovery command.

### Progressive disclosure

The Skill supplies the logical model, routing rules, common `create` shape,
and recovery policy. It does not duplicate a command manual.

- Use obvious argv syntax for a scalar task.
- Execute the Skill's validated common `create` shape directly when it covers
  the task; otherwise use `outline example COMMAND VARIANT` for an unfamiliar
  structured form.
- Use exact `outline COMMAND --help` when the example does not cover a needed
  option.
- Use `outline schema COMMAND --path JSON_POINTER` for one unresolved schema
  fragment.
- Use a full command or named schema only for integration work or diagnosis that
  genuinely needs the complete contract.

Bare `outline schema` returns a compact catalog of schema and command names,
not every schema body. `--part request|result|both` selects a command side.
`--path` follows RFC 6901 and returns only that fragment plus reachable
definitions. Missing paths return one exact validation error. Catalog output is
guarded below 8 KiB and common fragments below 4 KiB.

CLI and Runtime schema rejection returns bounded validation issues with JSON
Pointer paths, schema paths, keywords, and messages without echoing rejected
values. A useful validation error names the accepted vocabulary or one precise
next command; an Agent should repair that property once instead of dumping the
full schema.

Help is plain text and Runtime-independent. TTY state never changes output
semantics. Default success and failure receipts are deterministic, ANSI-free,
one-line-safe, and capped at 4 KiB. `--json` explicitly requests the complete
versioned envelope or JSONL stream. Large artifact and byte transfers use
`--output`; stdout remains exclusively the selected raw bytes.

### Semantic authoring

One complete resource uses one semantic invocation. Complex state for that
resource uses the same command with `--input FILE|-`. Only genuine dependent
or cross-resource work escalates to one `transact` ChangeSet with bindings.
No routine workflow requires a shell mutation loop, an intermediate created-ID
lookup, a speculative schema dump, or a separate verification read.

`create` creates plain, nested, Field-backed, and View-backed content with one
shape:

```json
{
  "at": { "parent": "@today", "position": "first" },
  "fields": [
    { "key": "weather", "name": "Weather", "type": "text" },
    { "key": "low", "name": "Night low (C)", "type": "number" }
  ],
  "node": {
    "text": "Chengdu district weather",
    "description": "Sunny throughout.",
    "children": [
      {
        "text": "Central districts",
        "fields": { "weather": "Sunny", "low": 21 }
      }
    ]
  },
  "view": { "mode": "table", "display": ["weather", "low"] }
}
```

Node text accepts plain text or the public rich-text object. Nodes may include
description, code language, checkbox/done state, tags, one explicit reference,
typed Field values, and recursively nested children. A Node cannot be both a
code block and a reference. Tags and references must resolve to persisted exact
identities before admission.

Collection-wide summaries belong to the owner Node description. Direct
children are the item identities projected as rows, cards, or calendar entries.

Public Field types are `text`, `select`, `select-from-tag`, `date`,
`number`, `url`, `email`, and `checkbox`. One boundary codec maps these
terms to Core tokens. A declaration ensures a compatible same-name definition:
all explicitly supplied constraints must equal its effective configuration,
while omitted constraints do not constrain reuse. Incompatible definitions
reject the entire request and return the existing ID plus differing properties.
The Agent does not pre-search Field IDs or manually recover from a compatible
reuse.

`edit` converges Node text and metadata, done/checkbox state, tags, Field
values, references, and Sources in one request. Omitted properties preserve
state; explicit actions or replacement collections express removal. Source
storage remains the ordinary built-in URI Field shape and is not exposed as a
parallel resource model.

`view get` returns the effective View, including the default Outline View.
`view set` applies one declarative patch. Omitted scalar properties preserve
state; only an explicit `replace` member replaces sort, filter, or display
collections. View switches preserve Node IDs, hierarchy, and Field values.

`search create` creates a Saved Search with a canonical query or `match`
shorthand and optional View. `search edit` converges title, query, and View.
`search run` executes the live query read-only and never refreshes or
materializes alternate Node truth.

Create, move, and duplicate use first/last/index/before/after placement. Move
and duplicate additionally support relative previous/next placement. Exact
locators are Node IDs, typed IDs, stable aliases, and local-date aliases.
Structured many-target requests require an explicit `max`.

`replace text` performs a bounded reviewed literal transform over content,
description, or both. Bulk selection and total replacements have independent
bounds. Planning captures a base revision, preserves rich-text marks and inline
references outside the range, and rejects consuming an inline reference.

`capture create` accepts exactly one parent or local date, preserves capture
provenance, derives an HTTP(S) Source when present, and creates the complete tree
in one Operation. `asset ingest` remains the byte-staging primitive; assets do
not create another Node or View identity model.

Destructive or explicitly reviewed work uses one immutable `preview`, then
`apply` of that exact artifact. The same idempotency key binds preview and
application. `--yes` alone is invalid. Ordinary semantic commands perform
their own atomic commit and committed-state verification.

`status` never starts Runtime. A live result includes contract identity,
document and log health, recovery capacity, and maintenance state. An absent
Runtime returns exactly the absent state rather than causing startup.
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

The public `transact` and `apply` capabilities always use durable settlement. The
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

`get ID...` lowers multiple exact IDs to one ordered `ids` selector. Runtime
defaults lower `ids`, `query`, and `search` selectors to bounded `many` targets
using the selector's exact list length or declared limit; exact IDs, aliases, and
dates lower to `one`. `get` and `export` also accept a complete Projection with
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
porcelain or direct `preview` input does not provide a key; `preview` fixes the
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

Validation covers the complete semantic frontier before settlement. Changing a field
definition type validates every existing value against the proposed type.
Lifecycle targeting collapses selected ancestors and descendants so Trash moves
each covered subtree once and never strands descendants. These checks apply to
desktop and CLI callers through the same ChangeSet executor.

`preview --input-format jsonl` uploads a header, bounded operation records, and a
count/SHA-256 trailer as a stream. After transport authentication, Runtime writes
the upload to a `0700` private spool directory using a `0600` temporary file,
checks the 64 MiB upload and 8 MiB record bounds while receiving it, then parses
and validates records incrementally. Runtime removes the spool file on success
or failure. An idempotency key supplied by the CLI is checked or injected only
after the trailer digest authenticates the uploaded ChangeSet.

## Preview, Transact, Apply, And Operations

`preview` normalizes a ChangeSet and returns an `outline.diff` containing its
canonical normalized ChangeSet, hashes, base revision, bindings, affected
before/after digests, destructive summary, warnings, and size estimate. It does
not advance document revision, create an Operation, or retain staged assets.

`transact` accepts the same ChangeSet contract and uses the same normalization,
selector, binding, asset-lease, idempotency, transaction-log, recovery, and
Operation semantics as `preview` followed by `apply`, but skips constructing a
reviewed Diff artifact. It is only valid for non-destructive writes. Runtime
rejects purge, empty-Trash purge, merge, and explicitly reviewed destructive text
replacement on this path with `confirmation_required`; those calls must use
`preview` followed by `apply`.

`apply` accepts the reviewed Diff, not an unreviewed private mutation. Runtime
rechecks its hashes, base revision, target digests, asset leases, and destructive
acknowledgement before executing. Node/definition merge, purge, and empty-Trash
flows require a Diff-bound explicit acknowledgement; acknowledgement alone is
insufficient.

After payload hash and key validation, Runtime resolves an existing idempotency
receipt before base-revision and Node-precondition checks. Reviewed apply binds
the key to the canonical Diff payload. Direct transaction settlement binds the key to the
original submitted ChangeSet payload, then records the normalized ChangeSet hash
on the Operation. The same key and canonical payload returns the original
Operation even when its base is now historical; the same key with another payload
remains an idempotency conflict.

Interactive destructive porcelain on a TTY first prints the exact Runtime-produced
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
consumed and never retains the whole encoded artifact merely to hash it. File
output writes those verified chunks unchanged: its byte count and raw-file
SHA-256 exactly match the returned receipt.

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

`history` returns an `OperationLogPage` in newest-first order. Opaque cursors bind
the origin, Thread/Turn/Item causation, affected-Node, Operation, and idempotency
filters used to create the page. `history --operation OPERATION_ID` also pages the
complete affected-Node IDs from retained recovery data; the bounded cursor on a
truncated Operation resumes the same affected-ID sequence. Expired recovery is
reported explicitly rather than returning an incomplete affected set.

Idempotency keys are scoped to workspace and protocol major. Reuse with the same
canonical payload returns the settled Operation; reuse with another payload is a
conflict. `transact`, `revert`, `undo`, and `redo` also carry durable CLI-generated
keys. `apply` rejects an unkeyed Diff instead of modifying reviewed content.
Clients never automatically retry after an unknown settlement. A timeout,
disconnect, `SIGINT`, or `SIGTERM` after mutation dispatch returns
`operation_settlement_unknown`, includes the exact key, and names the precise
next command: `outline history --idempotency-key KEY`.

Semantic no-change returns `outline.no-change` at the current revision without
creating an Operation or Operation Event. Desktop clients consume that result
directly, refresh or reuse their current Projection as appropriate, and never
wait for an Operation Event that cannot exist.

## Events And Desktop Intents

Every committed mutation appends ordered `projection.changed`, `operation.committed`,
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
  non-destructive semantic settlement, or reviewed Diff apply when review/destructive
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
