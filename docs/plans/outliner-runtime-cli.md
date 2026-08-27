# Outliner Runtime, CLI, And Skills

## Goal

Replace every persisted Outliner access path with one formal contract served by
a standalone local TypeScript Runtime. The Runtime, not Electron main or the
CLI, is the sole owner of live document state, transaction settlement,
persistence, Operation history, recovery, events, and asset reachability.

The end state has one document implementation and three deliberate clients:

- the desktop renderer reaches Runtime through the context-isolated
  preload/Electron-main transport adapter;
- the `outline` CLI is the stable public interface for terminal users, scripts,
  external Agents, and harnesses; and
- the built-in `outline` Skill teaches ordinary and import workflows over that
  CLI without owning document logic.

Every persisted mutation from desktop, CLI, built-in Agent, or external client
is one atomic `ChangeSet`, produces one durable `Operation`, and has a guarded
exact-revert path across Runtime restart. Agent causation changes attribution,
not capability. All clients receive the same Selector, Projection, ChangeSet,
Diff, Operation, Event, invariant, and recovery contracts.

The CLI product contract is complete at the porcelain layer, not merely in the
ChangeSet kernel. One complete resource intent uses one porcelain invocation;
complex state for that resource uses the same command with `--input FILE|-`;
multiple dependent resources use one ChangeSet with bindings. No ordinary flow
requires a shell mutation loop, intermediate created-ID lookup, or several
Operations for one atomic intent.

This plan has shape **(a): ONE complete feature in one PR**. Standalone Runtime,
desktop cutover, CLI, complete document capability coverage, transactional
recovery, asset retention, the built-in Skill, import convergence, Agent
cutover, and legacy deletion are build-order steps inside one Draft PR. No
intermediate state is mergeable, releasable, or described as shipped.

The requirement and acceptance identifiers defined below are the traceability
contract for implementation and verification.

## Non-goals

- No renderer selection, focus, expansion, pane placement, sidebar pinning,
  native menu, clipboard, or other UI-session control.
- No Agent, Browser, launcher, Settings, workspace-management, publishing,
  messaging, or whole-application CLI namespace.
- No remote listener, LAN access, cloud service, multi-user principal model, or
  direct workspace-file mutation.
- No MCP server or second automation contract. A future adapter may invoke the
  CLI but may not reimplement Runtime behavior.
- No Node-root scopes, action grants, Agent-specific projections, or reduced
  Agent schema. Causation is attribution, not authorization.
- No public physical asset deletion. Document references are reversible and
  unreferenced bytes are removed only by recovery-aware garbage collection.
- No compatibility alias for `tenon`, `tenon-import`, the six native tool names,
  Import Pack writes, or old Runtime endpoints after cutover.
- No migration reader, dual-write period, or automatic startup deletion.
  Before cutover verification, stop Tenon and manually reset both the installed
  app's local userData and clone-scoped development userData; the Runtime starts
  only from its clean persisted format.
- No in-process document authority in Electron main after cutover and no
  renderer-only mutation contract parallel to ChangeSet.
- No second document engine in the CLI, Skill scripts, transport adapter, or
  import adapter.

## Design

### Purpose, decisions, constraints, and evidence

The selected target is the clean architecture independent of current code: a
formal CLI over native model tools, complete Agent capability with trusted
causation over scoped authority, general composition over scenario-specific
APIs, durable exact recovery over prohibition, and a standalone Runtime over
client-owned document authority.

Existing code is migration evidence, not design authority. Core behavior and
native-Daily import fixtures identify capabilities that must survive; the
current import socket proves local transport is feasible; current persistence
and operation history reveal failure cases to test. None justifies an Electron
process dependency, a second desktop mutation protocol, or an
Outliner-specific physical blob root in the target architecture.

The hard target constraints are one serialized Runtime writer, Core-command
mutation below the public domain model, context-isolated renderer security,
atomic ChangeSets, one durable document transaction commit point, user-private
local transport, actor-neutral recovery admission, and a multi-process-safe
neutral ContentStore for physical asset bytes.

The explicit traceability manifest is:

- flows: `FLOW-1`, `FLOW-2`, `FLOW-3`, `FLOW-4`, `FLOW-5`;
- functional requirements: `FR-1`, `FR-2`, `FR-3`, `FR-4`, `FR-5`, `FR-6`,
  `FR-7`, `FR-8`, `FR-9`, `FR-10`, `FR-11`, `FR-12`, `FR-13`, `FR-14`,
  `FR-15`, `FR-16`;
- non-functional requirements: `NFR-1`, `NFR-2`, `NFR-3`, `NFR-4`, `NFR-5`,
  `NFR-6`; and
- acceptance: `AC-1`, `AC-2`, `AC-3`, `AC-4`, `AC-5`, `AC-6`, `AC-7`, `AC-8`,
  `AC-9`, `AC-10`, `AC-11`, `AC-12`, `AC-13`, `AC-14`, `AC-15`, `AC-16`,
  `AC-17`, `AC-18`, `AC-19`, `AC-20`, `AC-21`, `AC-22`, `AC-23`, `AC-24`,
  `AC-25`, `AC-26`, `AC-27`, `AC-28`, `AC-29`, `AC-30`, `AC-31`, `AC-32`,
  `AC-33`, `AC-34`, `AC-35`, `AC-36`, `AC-37`, and `AC-38` through `AC-87`.

### Completion contract


- **FR-1:** The CLI exposes deterministic Selector and Projection contracts.
  - **AC-1:** When the same execution context issues the same read at one
    revision, human and JSON output shall represent the same Node set.
  - **AC-2:** If a mutation selector resolves ambiguously or violates its
    declared cardinality, the Runtime shall reject before producing a writable
    ChangeSet.
- **FR-2:** Machine output is stable and composable.
  - **AC-3:** With `--json`, a non-stream command shall write exactly one
    versioned result envelope to stdout and diagnostics only to stderr.
  - **AC-4:** Streaming commands shall emit independently parseable versioned
    JSONL records and expose a resumable revision cursor.
  - **AC-5:** Input artifacts shall be accepted from an explicit file or stdin,
    without argument-length dependence.
  - **AC-70:** Non-TTY stdout shall default to the versioned machine envelope;
    `--human` shall force human output, `--json` shall force machine output, and
    combining those flags shall fail before Runtime access.
- **FR-3:** Every document mutation normalizes to one ChangeSet path.
  - **AC-6:** Porcelain and direct ChangeSet forms that describe the same intent
    shall produce the same normalized Diff and Operation semantics.
- **FR-4:** Preview is non-mutating and binds exact apply input.
  - **AC-7:** `diff` shall not advance document or persistence revision.
  - **AC-8:** `apply` shall reject if the bound ChangeSet hash, base revision, or
    targeted expected revisions no longer match.
- **FR-5:** Apply is atomic, durable, auditable, and exactly reversible for every
  accepted Runtime mutation regardless of client.
  - **AC-9:** If any validation or mutation in a ChangeSet fails, no part of the
    ChangeSet shall remain in document state, projection, or operation history.
  - **AC-10:** A successful apply shall return one stable Operation ID and its
    revert state only after the document update, Operation, recovery patch,
    asset delta, idempotency result, and Event sequence share one fsynced
    transaction-log commit.
  - **AC-11:** A reversible Operation shall remain addressable for guarded exact
    revert after Runtime restart and within the documented retention boundary.
  - **AC-71:** Before any CLI mutation dispatch, the exact payload shall carry a
    durable idempotency key. Timeout, disconnect, `SIGINT`, or `SIGTERM` after
    dispatch shall return `operation_settlement_unknown` with that key and the
    exact `outline log --idempotency-key ...` recovery command; the CLI shall
    never retry the mutation automatically.
- **FR-6:** Destructive and concurrent behavior is explicit.
  - **AC-12:** Permanent delete and empty Trash shall require an interactive
    confirmation or explicit non-interactive acknowledgement after Diff.
  - **AC-13:** Stale revisions shall fail with a structured conflict result and
    no automatic write retry.
- **FR-7:** Complex workflows compose general ChangeSet capabilities without a
  scenario-specific Runtime write path.
  - **AC-14:** The import Skill shall block while source coverage is unaccounted
    or while its generated ChangeSet differs from the reviewed Diff binding.
  - **AC-15:** A generic ChangeSet targeting ordinary Nodes and multiple local
    dates shall settle as one normal Operation, including canonical structure
    created by that Operation.
  - **AC-23:** If source data already conforms to the Skill's normalized input,
    import shall permit ChangeSet generation without a cleaning transform.
  - **AC-24:** An unresolved Selector, invalid semantic key, or cardinality
    conflict shall block before mutation and identify the exact operation.
  - **AC-66:** The Tana adapter shall map only deterministic source structures,
    including ISO journal headings with an optional English weekday suffix and
    `Node supertags(s)` metadata tuples; all other Tana-only structures shall
    remain explicitly accounted as unsupported rather than being guessed.
- **FR-8:** Agent execution receives complete reversible Outliner capability
  with trusted attribution rather than fine-grained Runtime authority.
  - **AC-16:** Where `outline` is present in an Agent execution, its public read,
    write, batch, history, and observe schemas shall match local-user execution.
  - **AC-17:** Every successful Agent mutation shall record immutable
    Thread/Turn/Item causation and expose its Operation ID and revert state.
  - **AC-30:** If a declared built-in Agent execution lacks valid causation
    attestation, Runtime shall reject mutation rather than record it as an
    unattributed local-user Operation.
  - **AC-31:** Node-resource scopes, action-set grants, and Agent-specific Memory
    filtering shall not change the Runtime's public document schema or results.
  - **AC-80:** `agent.execution: "read-only"` shall impose a persisted
    Host-enforced action ceiling, reject Outline/file/process/network/external
    mutations at static and dynamic admission, and remain inherited by nested
    Agents and isolated Skills without reducing the public read schema.
- **FR-9:** Skill cutover preserves existing model workflows.
  - **AC-18:** Fixture coverage for all six native tools shall pass through the
    Skill and CLI before those tools are removed from the catalog.
  - **AC-19:** After cutover, the built-in Skill shall contain workflow guidance
    but no duplicated parser, selector, validation, or mutation implementation.
  - **AC-81:** The Outline Skill shall remain inline so it observes the exact
    parent request and document context; its table guidance shall include one
    executable field-backed Table View fixture exercised by the mandatory golden
    Diff/apply/revert flow.
- **FR-10:** Runtime lifecycle supports external automation.
  - **AC-20:** The supported packaged standalone Runtime shall serve every
    desktop and CLI document operation without importing Electron or renderer
    code.
  - **AC-21:** If Runtime start or discovery fails, the CLI shall return a stable
    unavailable result and shall not read workspace persistence directly.
  - **AC-37:** When Runtime is absent, an ordinary desktop or CLI document
    command shall start the standalone process within the documented timeout;
    `--no-start` shall instead return the stable unavailable result without
    starting it.
  - **AC-38:** With all Tenon processes stopped, the documented one-time manual
    reset shall remove installed and clone-scoped pre-cutover stores. The first
    subsequent packaged and development launches shall create only the new
    Runtime and ContentStore layout, while source and dependency guards find no
    migration reader, dual write, or automatic startup deletion path.
  - **AC-67:** Initial attach probes and every command, upload, asset transfer,
    and stream shall have separate finite deadlines. A process that remains
    alive while its socket stops responding shall not block a client past the
    applicable deadline.
  - **AC-68:** Every attach shall compare the exact bundled capability-contract
    digest with both the private Runtime descriptor and live status response.
    A same-major mismatch shall fail closed with `protocol_incompatible` before
    command execution. With automatic start enabled, a descriptor/live/lock-
    authenticated older bundled Runtime may be retired and replaced within the
    startup deadline; `status`, `--no-start`, unowned descriptors, and
    unverifiable identities shall not change process state.
  - **AC-69:** `SIGINT` and `SIGTERM` shall abort startup, ordinary reads,
    ordinary writes, uploads, assets, and streams, with shell-standard exit
    codes and unknown-settlement recovery for a dispatched mutation.
  - **AC-73:** The Unix socket, descriptor, bearer token, and request envelope
    are private implementation details. The public integration surface is the
    CLI plus its domain schemas, response envelope, and stream records.
- **FR-11:** UI/session state is isolated from the document contract.
  - **AC-22:** Document CLI contracts shall not encode selection, focus,
    expansion, pane position, or sidebar pin state.
- **FR-12:** ChangeSet composition minimizes process and model round trips.
  - **AC-25:** A workflow that ensures 100 date targets and creates content
    below each shall require one diff and one apply invocation, not target-ID
    discovery or one mutation invocation per date.
  - **AC-26:** A later operation shall be able to consume the binding of an
    earlier resolved, ensured, or created result in the same ChangeSet.
  - **AC-27:** Apply shall optionally return a bounded Projection of affected
    results in the same versioned envelope as the Operation.
  - **AC-28:** A non-destructive single-intent porcelain command shall complete
    through one CLI invocation, while its preview mode shall return the same
    normalized Diff without writing.
  - **AC-29:** The CLI shall expose the exact versioned Selector, Projection,
    ChangeSet, Diff, Operation, Event, and error schemas without requiring
    source-code inspection.
  - **AC-32:** Reverting an Operation whose affected state has since changed
    shall make no write and return a conflict Diff identifying the changed
    preconditions.
  - **AC-33:** A successful revert shall itself be a recorded Operation and
    shall never erase the original audit entry.
  - **AC-34:** If Runtime cannot persist a durable recovery form, it shall reject
    the mutation before document state changes for every caller.
  - **AC-35:** Purge and Empty Trash recovery shall include deleted subtrees,
    dependent references, and other document state changed by the Operation.
  - **AC-36:** Asset bytes referenced by a reversible Operation shall not be
    physically deleted until no live document reference or retained recovery
    patch requires them.
- **FR-13:** Porcelain expresses complete common resource intents without shell
  choreography.
  - **AC-38:** One complete resource shall be creatable with one porcelain
    invocation, including its typed content and initial configuration.
  - **AC-39:** Complex input for that same resource shall use the same command's
    command-specific `--input FILE|-` schema rather than a generic MutationInput.
  - **AC-40:** Multiple dependent resources shall use one ChangeSet with
    bindings, without intermediate created-ID reads or a shell mutation loop.
  - **AC-41:** Every successful atomic workflow shall produce exactly one
    Operation and one guarded revert shall restore its complete pre-state.
  - **AC-42:** Create and ensure forms shall return created or bound Node IDs in
    the Operation result or one bounded returned Projection.
  - **AC-72:** Common porcelain writes shall request the smallest bounded
    post-operation Projection that identifies or verifies their primary target;
    this convenience result shall not replace an independent verification read.
  - **AC-43:** Stable system locations needed by common flows shall have direct
    selectors, including `@library` and `@saved-searches`; Saved Search creation
    shall default to `@saved-searches`.
  - **AC-44:** Omitted patch properties shall preserve current state; collection
    or resource replacement shall be explicitly named and documented.
  - **AC-45:** Repeated `set`, `configure`, and `ensure` execution shall converge
    or return semantic no-change without another Operation; `create` shall remain
    explicit creation.
  - **AC-65:** One exact or bounded query-selected Node set shall support a
    reviewed literal text transform without a shell loop. The command shall
    independently bound selected Nodes and total replacements, bind planning to
    the read revision, preserve unaffected rich-text structure, reject ambiguous
    inline-reference consumption, settle as one Operation, converge on repeat,
    and exactly revert.
- **FR-14:** Help, parser behavior, schema discovery, and completion metadata
  form one drift-free public CLI contract.
  - **AC-46:** `outline --help` shall list command families and concise purposes,
    while `outline FAMILY --help` shall list that family's subcommands.
  - **AC-47:** Exact command `--help` and `-h` shall show exact syntax,
    positionals, options, defaults, selectors, cardinality, input/output forms,
    mutation semantics, destructive requirements, and two or three examples.
  - **AC-48:** Help shall distinguish argv shorthand from command-specific
    `--input FILE|-`; `--json` shall neither wrap help in a Runtime response nor
    start Runtime.
  - **AC-49:** Destructive command help shall require `--preview`, reviewed
    `--expect-diff`, `--yes`, and one idempotency key reused across preview and
    apply, and shall state that `--yes` alone is invalid.
  - **AC-50:** Capability help, completion metadata, parser option admission, and
    `outline schema COMMAND` shall derive from the same per-command registry
    contract; drift guards shall compare their exact option and schema data.
  - **AC-51:** Unknown families, commands, and options and missing arguments
    shall name the nearest valid command or the exact `--help` next step.
  - **AC-52:** One Search creation invocation shall match `module`, create table
    view state with updated-desc sort, materialize results, and exactly revert.
  - **AC-53:** One ChangeSet, Diff, and apply shall create a Projects table with
    definitions, rows, displayed columns, grouping, and sorting, then revert.
  - **AC-54:** One ChangeSet shall create a tag or field definition and consume
    its binding on new and existing Nodes, then revert.
  - **AC-55:** One ChangeSet shall ensure a date and create a typed tree below
    its binding without an ID lookup, then revert.
  - **AC-56:** One `capture add` invocation shall ensure an optional date,
    preserve provenance, create its typed tree, and revert.
  - **AC-57:** One `media add` invocation shall stage a local image or attachment,
    retain its asset through the Operation, and revert the media Node exactly.
  - **AC-58:** One bounded `many + max` selector mutation shall apply done, tag,
    and field changes to its exact query result, then revert.
  - **AC-59:** One ChangeSet shall create two Nodes and cross-reference them
    through bindings, without an intermediate read, then revert.
  - **AC-60:** Template backfill shall preview and apply as one Operation, then
    revert.
  - **AC-61:** Node merge, definition merge, purge, and Empty Trash shall each
    require exact preview/confirmation, settle once, and revert.
  - **AC-62:** Repeated configure, set, and ensure calls shall create no duplicate
    semantic state or additional Operation after convergence.
  - **AC-63:** Every golden mutation flow shall expose a visible Operation ID,
    affected count, and recovery state and assert final state, mutation invocation
    count, Operation count, and successful revert.
  - **AC-64:** Golden CLI tests shall cover root help, search-family help, exact
    `search create`, `view sort add`, and `purge` help with real options and
    examples rather than generic `[ARGS]` placeholders.
  - **AC-82:** Command schema discovery shall return compact request schema by
    default and expose result/both only through `--part`; command and named
    public schema output shall publish at most one root `$defs` and remain
    within 512 KiB.
  - **AC-83:** Invalid CLI and Runtime inputs shall report bounded branch-focused
    validation paths without echoing rejected values.
  - **AC-84:** Node drafts shall require canonical lowercase RFC 4122 variant v4
    UUID Node IDs from the shared Core validator, the closed shared field-type
    union, and complete capture provenance at every public admission boundary.
- **FR-15:** Common reads, placement, references, queries, and recovery guards
  compose as efficient general capabilities rather than scenario-specific CLI
  commands.
  - **AC-74:** One read invocation shall support ordered exact multi-ID results,
    selected Nodes plus backlinks, live Saved Search execution, exact count, and
    named batch counts with one shared canonical query. Batch query execution
    shall reuse one request-local selection index.
  - **AC-75:** Public create placement shall support first, last, zero-based
    index, before, and after. Move and duplicate shall additionally support
    previous and next. Argv, structured schema, help, Diff, Operation, and exact
    revert shall preserve the same placement semantics.
  - **AC-76:** `reference set` shall retarget only an existing reference;
    `reference replace` shall replace one content Node with a tree reference and
    Trash its complete original subtree; `reference inline` shall own inline
    conversion or replacement. These forms shall not silently overlap.
  - **AC-77:** One query-operator registry shall own every executable public
    operator's required and optional operands, value format, summary, and
    example. It shall derive the exact QueryExpression schema, completion
    metadata, and Agent command reference; non-executable operators shall be
    absent and rejected.
  - **AC-78:** A field type change shall validate all existing values before
    commit, and a lifecycle selection containing ancestors and descendants shall
    mutate each covered subtree once without stranding descendants.
  - **AC-79:** Undo and redo shall default to the authenticated caller's origin,
    support explicit origin scope, expected-Operation guards, and consecutive
    text-edit user-action groups, and write nothing when the visible stack head
    changed.
- **FR-16:** Agent collaboration evidence preserves user, Host, and peer
  authority across delivery and restart.
  - **AC-85:** Background notifications and peer messages shall start with empty
    canonical user input and project typed additional context with
    `systemContext`, never `userInput`, provenance.
  - **AC-86:** Agent-authored notification output and peer-message bodies shall
    remain `untrusted/observation`; Host metadata is
    `application/observation`, and only Host handling rules are
    `application/instruction`.
  - **AC-87:** Nested exhausted settlement shall verify its durable batch digest
    from the exact typed context payload during live admission and startup
    recovery rather than from synthetic user text.

### End-state authority and invariants

```text
renderer -> preload -> Electron main adapter --+
                                                |
outline CLI ------------------------------------+-> authenticated protocol -> Outliner Runtime
outline Skill -------- invokes CLI -------------+                              +-> Core
                                                                                +-> transaction log
                                                                                +-> Outline AssetRecords
                                                                                `-> exact revisions + anchors
```

The standalone Runtime process owns Core and the only writable workspace store.
Electron main owns native host behavior and a typed Runtime client; it holds no
document Core, persistence queue, Operation journal, recovery store, or asset
index. Preload exposes the same versioned read/mutation/event requests to the
renderer without exposing the socket or bearer token. The renderer never shells
out to the CLI. The CLI and desktop adapter never import Core or open workspace
files.

Renderer selection, focus, panes, expansion, menus, and optimistic editor drafts
remain UI-session state. When a draft becomes persistent, the desktop client
submits an ordinary ChangeSet. Desktop reads use Projection and desktop updates
arrive as Event records. There is no second renderer document protocol after
cutover.

The following invariants are release blockers:

1. Every persisted mutation, including desktop editing, maps to one Core
   transaction, one transaction-log record, one Operation ID, and one recovery
   patch.
2. `diff` and `apply` run the same normalizer and executor. Apply either produces
   the exact reviewed after-state or throws while Core's rollback frontier is
   still live.
3. Document update, Operation metadata, recovery-patch reference, idempotency
   result, asset-reference delta, and Event sequence share one durable commit
   record. Runtime publishes none of them before that record is fsynced.
4. Selector ambiguity, stale revisions, failed preconditions, invalid bindings,
   and destructive acknowledgement failures write nothing.
5. Causation fields supplied in a request body are untrusted metadata. Only a
   host-issued attestation can create trusted Thread/Turn/Item attribution.
6. Execution context never changes the public capability registry, Selector
   results, Projection fields, ChangeSet union, or destructive operations.
7. Desktop actions and CLI porcelain are syntax sugar over the same
   `diff`/`apply` kernel. Transport and argument parsing never call Core commands
   directly.
8. Scenario code may transform source data and verify results, but no scenario
   receives a private selector, write endpoint, transaction, or permission path.
9. Outline AssetRecords remain while referenced by live Nodes, unexpired Outline
   leases, or retained recovery patches. Each surviving AssetRecord references a
   exact revision through an opaque ContentStore retention anchor. Physical
   bytes remain while any central admission lease or retention anchor exists; no
   client or Runtime transaction names a raw digest as authority. The anchor is
   a liveness mechanism, not asset ownership or identity.
10. A parity guard derived from artifacts on disk must report no unclassified
    persisted Outliner capability and no live legacy write surface.

### Module and authority boundaries

The implementation uses six layers so process and responsibility boundaries
are obvious:

| Layer | Proposed authority | Responsibility | Forbidden dependencies |
| --- | --- | --- | --- |
| Shared content kernel | `src/content/` | exact-revision admission, opaque retention anchors, verification, multi-process publication/deletion state, physical GC | Electron, renderer, Core, Outline/Agent domain code, CLI argv, Skill code |
| Public contract | `src/outline/contract/` | DTOs, TypeBox/JSON Schemas, canonical JSON/hash rules, errors, capability registry | Electron, filesystem, Core, renderer, Agent runtime |
| Runtime domain | `src/outline/runtime/` | selection, projection, normalization, preview, execution, Operation ledger, recovery, events, asset reachability | Electron, renderer DOM, CLI argv, Skill/source formats |
| Runtime storage/process | `src/outline/runtime/storage/` and `src/outline/runtime/server/` | transactional log, snapshots, Outline AssetRecords and exact-revision integration, user-private socket, descriptor, authentication, lifecycle | CLI presentation, renderer state, Agent policy |
| Shared client | `src/outline/client/` | discovery/start, protocol negotiation, request/stream client | Core, workspace files, renderer, Agent services |
| Client adapters | `src/outline/cli/` and `src/main/outlineClient/` | CLI argv/rendering/porcelain; Electron supervision and preload-safe forwarding | document business rules, direct persistence |

The capability registry is executable authority. Each entry owns its public
name, request and result schema, read/mutate/destructive classification, audit
category, porcelain help, and mapping coverage. It generates:

- `outline capabilities`;
- `outline schema` output;
- CLI help and completion metadata;
- the generated Agent-facing `outline/references/commands.md` command map;
- Runtime admission and response validation;
- audit classification; and
- the document-command and asset-capability parity report.

Transport adapters parse a versioned request envelope, authenticate it, invoke
one Runtime handler, map the typed result or error, and serialize the response.
They contain no selector resolution, import routing, Core command switch, or
recovery policy.

Current `DocumentService` behavior, Core ownership, read model, persistence, and
asset indexing move behind Runtime ownership. Agent parser/projection/import
modules do not move with them; reusable document behavior is re-homed under the
Runtime domain and every client becomes a consumer. Electron main's old document
dispatcher and `agentNodeTool*` are deleted after desktop and Agent cutover.

### Protocol version and envelopes

Protocol major version `1` is explicit in every public artifact, response, and
stream record. While CLI and Runtime ship as one product, every attach also
compares the exact SHA-256 digest of the canonical capability manifest. A
same-major digest mismatch fails closed with `protocol_incompatible` before the
requested command runs. Automatic start may first retire an authenticated older
bundled Runtime whose private descriptor and writer-lock owner identify the same
live instance; this is lifecycle replacement, not permissive command fallback.
Minor-version negotiation is deferred until CLI and Runtime can be distributed
independently; there is no permissive same-major command fallback in the bundled
product.

A non-stream machine response writes exactly one JSON value to stdout:

```ts
type OutlineResponse =
  | {
      protocolVersion: 1;
      requestId: string;
      ok: true;
      command: string;
      revision?: number;
      data: unknown;
    }
  | {
      protocolVersion: 1;
      requestId: string;
      ok: false;
      command: string;
      error: OutlineError;
    };

interface OutlineError {
  code: string;
  category:
    | 'usage'
    | 'selection'
    | 'conflict'
    | 'confirmation'
    | 'unavailable'
    | 'protocol'
    | 'durability'
    | 'internal';
  message: string;
  retryable: boolean;
  details?: unknown;
  next?: readonly string[];
}
```

Human and machine output have identical behavior and target sets. A non-TTY
stdout defaults to the versioned machine envelope; `--human` forces human
output and `--json` explicitly forces machine output. The flags conflict, and
help remains plain text without Runtime access. Output mode changes presentation
only. Machine stdout never contains progress, warnings, logs, ANSI control
bytes, or diagnostic prose; those go to stderr.
An empty `find` result is a successful empty result, not an error.

Streaming commands use JSON Lines. Every line is independently parseable and
has `protocolVersion`, `requestId`, monotonically increasing `sequence`, and a
record `type`. A stream begins with `hello`, emits `data` or `event`, may emit a
terminal `error`, and ends with `end`. `event` and `end` records carry the most
recent opaque cursor.

Stable process exit codes are:

| Code | Meaning |
| --- | --- |
| `0` | Successful command, including an empty read result |
| `2` | Invalid argv, input framing, or public schema |
| `3` | Missing/ambiguous target, failed precondition, stale Diff, idempotency conflict, or revert conflict |
| `4` | Destructive acknowledgement or reviewed Diff binding required |
| `5` | Runtime unavailable or startup/discovery timeout |
| `6` | Authentication or protocol incompatibility |
| `7` | Recovery capacity, recovery decode, or durability failure |
| `8` | Unexpected Runtime failure |
| `130` | Client interrupted by `SIGINT`; mutation outcome must be resolved by idempotency key or `log` |
| `143` | Client terminated by `SIGTERM`; mutation outcome must be resolved by idempotency key or `log` |

The typed `error.code`, not the coarse exit code, is the automation decision
surface. Errors include at least `invalid_input`, `not_found`,
`ambiguous_selector`, `cardinality_mismatch`, `precondition_failed`,
`stale_revision`, `diff_mismatch`, `idempotency_conflict`,
`confirmation_required`, `revert_conflict`, `recovery_expired`,
`recovery_capacity_exceeded`, `operation_settlement_unknown`,
`runtime_unavailable`, `unauthorized`, and `protocol_incompatible`.

### Selector, binding, and projection contracts

`Selector` is deterministic and independent of renderer state:

```ts
type Selector =
  | { by: 'id'; id: string }
  | {
      by: 'alias';
      alias: 'home' | 'inbox' | 'schema' | 'trash' | 'daily-notes' | 'today';
    }
  | { by: 'date'; date: string }
  | {
      by: 'query';
      query: QueryExpression;
      within?: Selector;
      includeTrash?: boolean;
      order?: 'document' | 'created' | 'updated' | 'text';
      limit: number;
    };

interface TargetSpec {
  selector: Selector;
  cardinality: 'one' | 'zero-or-one' | 'many';
  max?: number;
}

type TargetRef =
  | { target: TargetSpec }
  | { binding: string };
```

Local dates are strict `YYYY-MM-DD` values interpreted in the workspace's local
calendar rules. They are never JavaScript UTC dates. Query selectors use the
existing structured search grammar, not a second text-query language.
`includeTrash` defaults to false. A `many` mutation must provide a finite `max`;
read projections receive bounded defaults from the registry.

Query resolution evaluates the complete matching set, removes Trash unless
requested, applies `within`, then applies the requested order with Node ID as a
stable tie breaker before taking `limit`. The default order is document order.
Mutations never pick the first fuzzy match. CLI shorthand is limited to exact
IDs and the semantic aliases `@home`, `@inbox`, `@schema`, `@trash`,
`@daily-notes`, `@today`, and `@date:YYYY-MM-DD`. Structured queries arrive
through `--query`, `--selector`, stdin, or a file.

A ChangeSet may assign a result to a `Binding`. Binding names match
`^[A-Za-z][A-Za-z0-9_-]{0,63}$`, are unique, cannot be forward-referenced, and
resolve to an immutable ordered target set. `resolve`, `ensure`, `create`, and
`duplicate` may bind results. Bindings exist only inside one ChangeSet and are
never persisted as global names.

`Projection` is a request, not an unrestricted document snapshot:

```ts
interface Projection {
  kind: 'summary' | 'node' | 'outline' | 'backlinks' | 'view' | 'export';
  targets: TargetRef;
  depth?: number;
  include?: readonly (
    | 'description'
    | 'children'
    | 'tags'
    | 'fields'
    | 'references'
    | 'media'
    | 'view'
    | 'trash'
  )[];
  page?: { limit: number; cursor?: string };
  format?: 'json' | 'jsonl' | 'markdown' | 'opml';
}
```

The schema sets finite maxima for depth, result count, text bytes, and expanded
field/reference data. Pagination cursors bind the Projection hash and revision;
changing either requires a fresh read. `export` streams large results and does
not weaken target or Trash visibility rules.

Projection `include` values are explicit optional-metadata gates. `fields`
admits field-definition linkage, `view` admits view/sort/filter/display/query
metadata, and `trash` admits the original-parent linkage used for restoration.
Omitting a gate redacts its metadata from Node results.

### ChangeSet and operation model

The public ChangeSet is declarative Outliner intent, not a serialized list of
Core command names:

```ts
interface ChangeSet {
  protocolVersion: 1;
  kind: 'outline.changeset';
  base?: {
    revision?: number;
    nodes?: { readonly [nodeId: string]: string }; // Node ID -> expected digest
  };
  idempotencyKey?: string;
  source?: {
    kind: 'cli' | 'skill' | 'import' | 'automation' | 'external';
    label?: string;
    uri?: string;
    fingerprint?: string;
  };
  operations: readonly Change[];
  return?: readonly Projection[];
}

type Change =
  | ResolveChange
  | EnsureChange
  | CreateChange
  | UpdateChange
  | MoveChange
  | DuplicateChange
  | MergeChange
  | TemplateChange
  | LifecycleChange;
```

The stable top-level change vocabulary is:

| Change | Purpose |
| --- | --- |
| `resolve` | Resolve a TargetSpec and bind its exact result without changing state |
| `ensure` | Resolve or create one canonical date, saved tag search, or reusable definition, then bind it |
| `create` | Create typed Node trees, capture Nodes, media/attachment Nodes, saved searches, tags, or field definitions under one or many bound parents |
| `update` | Apply an ordered list of typed content, description, code, checkbox, done, tag, field, reference, view, search, icon, banner, or image changes to bounded targets |
| `move` | Reparent or reorder bounded targets with explicit destination and index semantics |
| `duplicate` | Duplicate bounded targets under an explicit destination and optionally bind the copies |
| `merge` | Merge Nodes or compatible definitions under the existing Core invariants |
| `template` | Apply tag-template backfill to its computed affected set; ordinary Diff is the preview |
| `lifecycle` | Trash, restore, or purge bounded targets; purging Trash contents is an explicit target mode |

`NodeDraft` is a public, typed tree shape covering plain and rich content, code,
references, field entries, saved searches, images, attachments, descriptions,
children, tags, fields, done state, and closed metadata. Capture metadata uses
the shared provenance schema, query metadata uses the public query grammar, and
paste metadata may carry `pasteTags` plus `pasteFields` so structured paste and
slash-trigger trees preserve semantic tags/fields through field-slot append
paths. Runtime maps it to existing Core types after validation. It does not
expose renderer drafts or Core-only focus hints.

`UpdateChange.changes` is an ordered discriminated union. It covers content and
description replacement/patching; code language; checkbox and done state; tag
add/remove; field define/set/clear/remove/reuse and option selection; reference
add/retarget/inline/restore; view mode, toolbar, sort, filter, group, and display
fields; saved-search query and refresh; and icon, banner, and image assignment.
Every variant has one owner and validation path. No untyped property bag or
generic JSON Patch is admitted.

Normalization performs all of the following exactly once:

- validates schema and limits;
- resolves selectors and cardinality against one base revision;
- validates binding order and dependency cardinality;
- assigns every new Node ID, including canonical date scaffolding, before
  preview execution;
- lowers porcelain into the public Change union;
- records expected Node digests for every resolved target and structural parent;
- validates protected system objects and Core invariants through the preview
  executor; and
- emits canonical JSON with a SHA-256 ChangeSet hash.

Large ChangeSets use `--input-format jsonl`. The first record is a ChangeSet
header without `operations`, each following record is one `operation`, and the
last record contains operation count and SHA-256. Runtime parses bounded records
into a user-private spool file, validates the final digest, and cooperatively
executes chunks while preserving one Core rollback and Operation frontier. An
interrupted or malformed input before apply leaves no Operation.

### Diff, apply, and result contracts

`outline diff` accepts a ChangeSet and returns a self-contained `Diff` artifact:

```ts
interface Diff {
  protocolVersion: 1;
  kind: 'outline.diff';
  diffHash: string;
  changeSetHash: string;
  baseRevision: number;
  normalizedChangeSet: ChangeSet;
  bindings: { readonly [binding: string]: readonly string[] };
  affected: readonly {
    id: string;
    effect: 'create' | 'update' | 'move' | 'trash' | 'restore' | 'purge';
    beforeDigest: string | null;
    afterDigest: string | null;
  }[];
  destructive: readonly {
    kind: 'purge' | 'empty-trash' | 'replace' | 'merge';
    targetCount: number;
  }[];
  warnings: readonly OutlineWarning[];
  resultEstimate: { nodeCount: number; encodedBytes: number };
}
```

The `diffHash` covers the full canonical Diff except itself. Diff creates no
document revision, Operation, durable recovery patch, AssetRecord, or exact-
revision retention. It may use a disposable Core copy and temporary spool files
that are removed after the response.

`outline commit` consumes a non-destructive ChangeSet directly. Runtime verifies
the same public ChangeSet shape, selectors, bindings, staging leases, and
idempotency key as the reviewed path, then commits through the same transaction
log and Operation machinery without materializing a Diff artifact. It rejects
purge, empty-Trash purge, merge, and explicitly reviewed destructive text
replacement with `confirmation_required`.

`outline apply` consumes a Diff artifact, not an unreviewed private mutation
format. Runtime verifies protocol, hashes, base revision, targeted Node digests,
staging leases, and destructive acknowledgement before executing the embedded
normalized ChangeSet. Non-destructive porcelain without `--preview` or
`--expect-diff` may route to `commit`; `--preview` returns a Diff without writing,
and the same idempotency key plus `--expect-diff HASH` binds a later invocation
to the reviewed result.

Interactive destructive porcelain shows the Diff and asks for confirmation on
a TTY. Non-interactive destructive calls require both `--yes` and either a Diff
artifact or the preview's idempotency key plus `--expect-diff HASH`. `--yes`
alone is rejected. The confirmation is bound to the exact Diff, so a concurrent
change requires review again.

Commit and apply return one `Operation` and any requested bounded post-commit
Projection:

```ts
interface Operation {
  protocolVersion: 1;
  kind: 'outline.operation';
  operationId: string;
  changeSetHash: string;
  diffHash: string;
  origin: 'desktop' | 'local-user' | 'built-in-agent' | 'external-client';
  causation?: { threadId: string; turnId: string; itemId: string };
  source?: ChangeSet['source'];
  summary: string;
  affectedNodeIds: readonly string[];
  affectedNodeCount: number;
  affectedNodeIdsHash: string;
  affectedNodeIdsTruncated?: true;
  affectedNodeIdsCursor?: string;
  revisionBefore: number;
  revisionAfter: number;
  createdAt: string;
  recovery: {
    recoveryPatchId: string;
    state: 'available' | 'conflicted' | 'reverted' | 'expired';
    retainedUntilAtLeast: string;
  };
  undoGroup?: { groupId: string; kind: 'text-edit'; nodeId?: string };
  revertsOperationId?: string;
  revertsOperationIds?: readonly string[];
  result?: readonly ProjectionResult[];
}
```

Affected IDs are a bounded sample in Operation output, with count, full-set hash,
and a cursor when truncated. They are complete in the private recovery patch and
available through paginated `log --operation`. A returned Projection is bounded
by the same public limits and uses the committed revision, removing a mandatory
follow-up read without allowing unbounded apply output.

Small Diff results may be returned in the one-response JSON envelope. When the
canonical Diff exceeds 8 MiB, `diff` requires `--output DIFF_FILE`, streams to an
atomic file, and returns only path, byte count, and SHA-256 in its stdout
envelope. `--output -` streams one canonical JSON value to stdout for clients
that can consume it incrementally. Runtime and CLI never retain the whole
encoded Diff merely to calculate a hash; canonical serialization and hashing
advance together.

Idempotency keys are scoped to the workspace and protocol major. The CLI injects
`cli:<uuid>` when porcelain, direct `diff`, direct `commit`, `revert`, `undo`, or
`redo` does not receive an explicit key. Direct `diff` fixes that key into the
reviewed Diff; direct `commit` binds the key to the submitted ChangeSet payload
and records the normalized ChangeSet hash on the Operation. Desktop and
Electron-main mutation, preview, undo, and redo paths generate `desktop:<uuid>`.
`apply` rejects a Diff without a key rather than changing reviewed content.
Runtime checks a matching key and canonical payload before
base-revision and Node-precondition validation, so replay returns the original
Operation even after the workspace advances; a different payload returns
`idempotency_conflict`. A client disconnect never causes automatic mutation
retry. The client resolves an unknown settlement with the exact next command
emitted in the error:
`outline log --idempotency-key KEY`.

### One durable transaction and recovery patch

Process-local undo cannot satisfy exact recovery after restart. Runtime records
a Node-level recovery patch inside the same durable transaction that commits the
document update, Operation, idempotency result, asset-reference delta, and Event
sequence. Recovery is part of the storage model, not a sidecar workflow.

Core exposes a transaction-patch hook around `Core.transaction`. The hook
returns an immutable, sorted map of every touched Node's canonical `before` and
`after` value, using `null` for absence, while the rollback frontier is still
live. Structural parents, references healed by deletion/merge,
definition/template links, and every other touched Node are included. Every
persisted client mutation uses this patch-aware Runtime transaction.

Preview execution runs the normalized ChangeSet against an ephemeral Core
created from the current verified snapshot. Because all created IDs and binding
results are fixed during normalization, preview produces the expected patch and
digest without changing the live Core.

`WorkspaceTransactionLog` is the commit authority. A checksummed transaction
record contains or references:

- the exact CRDT/document update and resulting revision;
- complete Operation metadata and idempotency key/payload hash;
- the content-addressed recovery-patch blob;
- asset lease consumption and live-reference changes; and
- the monotonic Event sequence and cursor material.

Large recovery patches are immutable blobs. Runtime writes and fsyncs the blob
first, then appends and fsyncs the transaction record that makes it reachable.
An unreferenced blob is an inert orphan eligible for GC; it is never a prepared
document commit. Small patches may be inlined in the record. Snapshots compact
document updates but retain the bounded Operation index and live recovery-blob
references required by policy.

After replay, Core may reconcile durable system state that was absent from the
stored snapshot, including the current local-date Daily Note. Runtime must
atomically compact that reconciled Core into the verified snapshot/log baseline
before it publishes a descriptor or accepts a request. A later transaction may
therefore capture only its own update without depending on unpersisted startup
operations. Baseline persistence failure aborts Runtime startup.

Apply settlement is ordered as follows:

1. Enter Runtime's single workspace mutation queue, resolve an existing matching
   idempotency receipt, then recheck the Diff revision and expected Node digests
   only when no receipt exists.
2. Reserve recovery/asset capacity, execute the normalized plan tentatively in
   one Core transaction, and keep the rollback frontier live.
3. Compare the actual affected set, per-Node after values, and aggregate digest
   with preview. A mismatch throws and rolls back before durability.
4. Serialize the document update, Operation, recovery patch, asset deltas,
   idempotency result, and Event sequence. Fsync immutable blobs, append one
   checksummed transaction record, and fsync the log.
5. Only after the log commit point, finalize in-memory Core/index state, publish
   the Event, acknowledge the desktop/CLI client, and admit the next mutation.
   Post-commit cleanup, asset garbage collection, and compaction are scheduled
   maintenance work; they are not part of this acknowledgement path.

If blob or log durability fails, Core rolls back and no Operation is visible. If
the process exits after log fsync but before client acknowledgement, replay
reconstructs the committed state and the idempotency key returns the original
Operation. There is no state where document durability succeeded but recovery
or Operation metadata did not.

The private recovery patch contains storage and patch versions, Operation
identity, origin and trusted causation, ChangeSet/Diff hashes, revisions,
complete before/after Node maps, aggregate digests, protected asset-record IDs,
and lifecycle timestamps. It contains no bearer token, descriptor secret,
environment value, source file content, or credential.

### Revert and crash behavior

`outline revert OPERATION_ID` loads the retained recovery patch and compares
every affected Node's current canonical value with the patch's `after` value. It
does not write when any value differs. The conflict result is a Diff identifying
the changed Node preconditions; unrelated Nodes never block revert and are never
overwritten.

When every guard matches, Runtime applies the recovery patch's `before` map
through a trusted Core recovery command. The revert is itself a new public
Operation with its own transaction-log record, recovery patch, audit entry, and
`revertsOperationId`. The original Operation remains in `log`. Reverting the
revert provides exact redo semantics; desktop Undo/Redo and `outline undo` /
`outline redo` are convenience selection over these Operation-addressed rules,
not wrappers around a process-local stack.

`revert OPERATION_ID` always targets exactly that one Operation. Undo/redo may
select a consecutive group of available Operations with the same text-edit
`undoGroup.groupId`; the group recovery Operation records the visible stack head
in `revertsOperationId` and the complete covered ordered set in
`revertsOperationIds`. This preserves low-latency incremental editor commits
without regressing the user-facing rule that undoing a half-typed materialized
row removes the whole row.

Purge and Empty Trash recovery patches include every deleted subtree Node, every
reference or template link changed by healing, structural parents, and asset
references. They follow the same guard and revert path as ordinary edits. Agent
calls are neither blocked nor treated specially.

Startup loads the last verified snapshot and replays complete checksummed log
records. An incomplete final append is discarded because it never crossed the
commit boundary. A recovery blob with no committed log reference is collected
as an orphan. A missing/corrupt referenced blob or checksum failure inside the
committed prefix keeps verified reads/export available, blocks mutations with
`recovery_inconsistent`, and preserves diagnostic evidence. Runtime never
guesses a partial commit or overwrites state during repair.

### Recovery retention and capacity

Recovery blobs and their Operation metadata live in user-private Runtime
storage and are never exposed by filesystem path. A recovery patch remains
protected while either condition is true:

- it is younger than 30 days; or
- it belongs to the most recent 1,000 committed document Operations from any
  client.

Only patches older than 30 days and outside the newest 1,000 may expire. A log
maintenance record marks expiry before blob deletion so `log` reports `expired`
while Operation metadata remains retained. Snapshot compaction keeps at least
the most recent 1,000 Operation summaries and all newer-than-30-day summaries.

The recovery budget is 2 GiB per workspace. It counts recovery blobs and asset
bytes retained solely by those patches; assets still referenced by live Nodes
do not consume recovery budget. Before a mutation executes, Runtime evicts
eligible expired patches and computes the additional protected bytes. If the
new operation would exceed the budget while every remaining patch is
protected, it returns `recovery_capacity_exceeded` before changing document
state. The policy and error are identical for every caller, including purge and
Empty Trash.

Recovery pruning runs during mutation admission when needed for recovery-budget
decisions, and otherwise during scheduled maintenance after startup, after
foreground request quiescence, and before idle shutdown. It is derived from
committed log/index and blob reachability, not an in-memory checklist. Runtime
resolves the new instance identity before startup reconciliation can compact
or expire recovery. Any maintenance Event emitted after startup uses the new
identity and remains after the workspace's pre-maintenance replay baseline for
watch delivery.

### Asset staging, retention, and garbage collection

Runtime is authoritative for Outline `AssetRecord` identity, metadata, leases,
document reference deltas, and recovery roots. The neutral `ContentStore` under
`src/content/` stores exact revisions, admission leases, opaque retention
anchors, integrity state, and physical collection under `{userData}/content/`.
A logical `AssetRecord` contains user-facing metadata and a Host-private
`ExactRevisionReference`; many Outline records, and later Agent references,
may retain the same exact revision through distinct anchors. Nodes reference
AssetRecord IDs rather than anchor IDs, blob digests, paths, or mutable sidecars.
Neither the AssetRecord nor its anchor claims ownership or continuing identity
of an original live file.

Public `AssetMetadata`, `AssetLease`, CLI JSON, renderer DTOs, ChangeSets, and
Operations omit the physical digest and anchor ID. Runtime resolves an
AssetRecord through its exact-revision handle and ContentStore verifies the
anchor's record coordinate before serving bytes. MIME type, original filename,
dimensions, duration, and preview metadata remain Outline reference metadata
rather than physical integrity fields.

`outline asset ingest PATH|-` streams bytes to Runtime, hashes and validates
them through ContentStore, fsyncs the exact revision, creates a durable opaque
retention anchor for the future AssetRecord, appends the asset-stage record to
the Runtime log, and returns an `AssetLease`:

```ts
interface AssetLease {
  protocolVersion: 1;
  leaseId: string;
  assetId: string;
  metadata: AssetMetadata;
  expiresAt: string;
}
```

The default lease is 24 hours. A media/attachment/icon/banner ChangeSet consumes
the Outline lease in its atomic transaction record; clients cannot smuggle an
arbitrary path, digest, anchor, or ContentStore coordinate into a ChangeSet.
Successful apply changes only which live Nodes and recovery patches reference
the same AssetRecord. Failed or abandoned apply leaves the Outline lease until
expiry, so retries do not race AssetRecord collection.

ContentStore persists admission-staging ownership before creating or writing
the temporary file. The row records a stage ID, writer PID, opaque owner token,
and timestamps; the file path is derived internally from the stage ID. Claiming
publication transfers ownership from that row to the per-digest publication
journal in the same SQLite transaction. Cleanup unlinks and fsyncs the staging
directory before deleting the row. Publication rename fsyncs both its source and
destination directories before clearing the journal. On startup, a live writer's
staging file is retained, while staging whose writer is proven dead is unlinked,
fsynced, and settled. Central GC performs the same dead-writer-only repair so a
surviving Host need not restart after another Host dies. No untracked pre-claim
file or staging directory sweep is part of recovery.

Capture settlement is anchor-first across the ContentStore/Runtime-log boundary.
Runtime holds its namespace mutation/reconciliation barrier from before anchor
creation through AssetRecord stage commit or failed-commit release. If the
AssetRecord stage commit fails, Runtime releases the anchor best-effort before
leaving the barrier; a crash may leak the anchor but cannot lose an exact
revision required by a committed AssetRecord. Runtime reconciliation takes the
same barrier, enumerates verified `(assetId, anchorId)` pairs, and releases only
orphan Outline anchors after a successful enumeration. An unavailable or corrupt
Runtime store releases none.

`outline asset show` inspects metadata and `outline asset export` streams
verified bytes. There is no `outline asset delete`. Remove renderer/public
`delete_asset`; deleting or changing a document Node only changes references.

The Outline record collector derives its protected set from:

1. all asset and thumbnail IDs referenced by the live document;
2. all AssetRecord IDs named by retained recovery patches; and
3. all unexpired staging leases.

Only an AssetRecord absent from all three sets may be collected by the Runtime.
After the Runtime commit removes it, Runtime releases its retention anchor. A
crash between those actions leaks an anchor until reconciliation.

Physical GC does not enumerate or cache digest snapshots from domain databases.
In one central SQLite transaction it selects only blobs with no admission lease
and no retention anchor and marks them `deleting`; concurrent admission or
anchor cloning cannot attach to that state. It then unlinks the blob and settles
the deletion journal. Startup finishes or rolls back interrupted deletions.
Agent main and Outliner Runtime use the same WAL/busy-retry and per-digest
publication protocol, so atomic rename alone is never treated as multi-process
exclusion.

Physical corruption and domain-record corruption remain separate. A digest or
length mismatch against ContentStore metadata quarantines the physical blob for
all references to that exact revision. Invalid Outline metadata
quarantines/degrades only that AssetRecord and cannot move valid shared bytes
retained by another reference. GC and integrity maintenance run outside document
settlement; their failures are retryable and cannot change a committed
Operation. The old random-file/sidecar
format is deleted by the PM-ratified 2026-08-26 manual reset of
`~/Library/Application Support/Tenon/` and clone-scoped `~/.lin-outliner-*`
userData after all Tenon processes stop. No migration, legacy reader, or
automatic deletion path is carried into the new store.

### Runtime transport and lifecycle

Runtime is a standalone Node process with no Electron import. It uses a
user-private Unix socket and replaces the import-only API. The descriptor is stored at
`USER_DATA_DIR/outline-runtime/runtime.json`; the socket and descriptor have mode
`0600`, and the containing directory is user-only. The descriptor contains:

```ts
interface RuntimeDescriptor {
  descriptorVersion: 1;
  transport: 'unix-http';
  socketPath: string;
  bearerToken: string;
  pid: number;
  instanceId: string;
  protocolMajors: readonly [1];
  contractDigest: string;
  runtimeVersion: string;
  storageVersion: number;
  createdAt: string;
}
```

The socket path, descriptor, bearer token, and request envelope are private
implementation details, not public schemas or supported integration points.
The CLI, domain schemas, response envelope, and stream records are public. The
bearer token proves same-user descriptor access; it is never logged, persisted
in Operation metadata, or accepted from argv. The server validates authorization
before reading a request body. HTTP-over-Unix-socket routes are small private
adapters: health/discovery, one command call, and one streaming call. Request
bodies have schema and byte limits; JSONL uploads are parsed with per-record
limits and private spool files.

The packaged product contains separate `outline.mjs` client and
`outline-runtime.mjs` server entries. Development runs them with Bun; packaged
launch uses the app's bundled executable in Node mode, but the Runtime bundle
does not load Electron main, BrowserWindow, Agent/provider services, launcher,
or renderer code.

Runtime has its own single-writer lock, independent of Electron's application
single-instance lock. Startup contenders atomically claim a lock directory
under `USER_DATA_DIR/outline-runtime`, publish PID/instance metadata, then bind
the socket and descriptor. A loser waits for the winning descriptor. Stale-lock
recovery verifies both process liveness and descriptor/socket identity before
removing anything; no client unlinks a merely slow owner's socket.

Electron main and CLI both use the shared Runtime client/supervisor. Either may
start Runtime when absent, and both attach to the winner during a race. Opening
or quitting the desktop app neither promotes nor owns Runtime; it only adds or
removes a client lease. Electron's single-instance lock continues to govern UI
windows and is unrelated to document authority.

Runtime exits after five minutes with no client leases, watch streams, active
transaction, foreground-idle maintenance drain, or unflushed storage. It closes
the socket, removes only its own descriptor/lock identity, and exits. A desktop
connection or active watch holds a lifecycle lease. Watch streams do not count
as foreground work, so they do not prevent storage maintenance while the
desktop event stream is open. Each admitted foreground request advances a drain
generation; idle maintenance and the optional idle hook recheck that generation
and active requests before shutdown, so work admitted during an old drain
cancels that shutdown.

CLI discovery rules are deterministic:

1. Resolve userData exactly as the app does, honoring
   `ELECTRON_USER_DATA_DIR` for isolated development and tests.
2. Read and validate the descriptor, compare its exact contract digest, connect,
   authenticate, and compare the live status digest under a bounded attach probe.
3. If automatic start finds an older authenticated bundled Runtime, require its
   descriptor to match the private writer-lock owner, retire that exact instance,
   and wait for its descriptor release. Current Runtimes use a private lifecycle
   route; legacy Runtimes receive `SIGTERM` only after the same checks. An atomic
   private retirement claim selects one signaler and recovers if its owner dies.
4. If the descriptor is absent or the authenticated old instance retired, start
   the standalone Runtime unless `--no-start` is present. Concurrent starters
   converge through the writer lock.
5. Wait up to the global `--startup-timeout` value, 10 seconds by default, then
   return `runtime_unavailable` with no persistence fallback.

Every finite Runtime call has a separate `--timeout` deadline, 60 seconds by
default and at most 300 seconds. It covers request, response-body consumption,
uploads, asset transfers, and public CLI streams; startup probing remains
governed by the shorter startup deadline. `SIGINT` and `SIGTERM` flow through
both deadlines. Desktop Event subscriptions use the same deadline only through
the first validated `hello` record, then remain open until caller cancellation,
transport closure, or a Runtime `end` record.

`version`, `schema`, and the bundled portion of `capabilities` run locally and
never start Runtime. `status` reports absence without starting it. Document,
history, asset, and watch commands auto-start. `capabilities --runtime` compares
the bundled CLI registry with the connected Runtime and fails on incompatibility;
ordinary attach already enforces the same exact digest.

### CLI command grammar

Global form is:

```text
outline [--json|--human] [--protocol 1] [--no-start]
        [--startup-timeout MS] [--timeout MS] COMMAND [ARGS]
```

Every command accepts `--help` and `-h`. Porcelain structured input is one exact
command-specific JSON object through `--input FILE|-`; it never exposes the
generic Runtime MutationInput as its user schema and does not accept
`--input-format`. Direct `diff` accepts complete ChangeSet JSON or canonical
JSONL with `--input-format`. Stdin is used only when explicitly named as `-` or
when the command documents piped bytes. Output files use `--output`, never
shell-like positional guessing. Mutation commands accept `--idempotency-key`;
porcelain accepts `--preview` and `--expect-diff HASH`, with one key reused
across those invocations; only destructive forms accept `--yes` under the
binding rules above.

The stable command surface is:

| Command | Contract |
| --- | --- |
| `outline version` | CLI/app/protocol versions; no Runtime start |
| `outline status` | Runtime presence, instance/runtime/storage versions, revision, transaction-log and recovery health; no start |
| `outline capabilities [--runtime]` | Generated capability registry and optional live compatibility check |
| `outline schema` / `outline schema SCHEMA_NAME` | Exact JSON Schema for QueryExpression, Selector, placement, Projection, ChangeSet, Diff, Operation, Event, envelopes, errors, or a named command |
| `outline find [TEXT]` | Structured or live Saved Search with exact count, named batch counts, `--within`, Trash, ordering, cursor, limit, and Projection controls |
| `outline show SELECTOR...` | One target or an ordered exact ID list; Projection, depth, backlinks include, and pagination controls |
| `outline export SELECTOR` | Bounded/streaming JSON, JSONL, Markdown, or OPML to stdout or `--output` |
| `outline watch` | Ordered JSONL projection/Operation events from `--cursor`, with explicit resync |
| `outline diff --input FILE|-` | Normalize and preview one ChangeSet without mutation |
| `outline commit --input FILE|-` | Apply one non-destructive ChangeSet directly and return one Operation |
| `outline apply --input DIFF_FILE|-` | Apply one exact Diff and return one Operation |
| `outline log` | Paginated Operation history; filters for origin, causation, affected Node, or Operation ID |
| `outline revert OPERATION_ID` | Guarded exact revert; conflict is a non-writing Diff |
| `outline undo` / `outline redo` | Convenience over the latest applicable recoverable Operation/revert Operation |

Porcelain is grouped by document noun but remains thin. The exact version-1
verb names are:

| Family | Stable forms and subcommands |
| --- | --- |
| Structure/content | `add`, `set`, `move`, `duplicate`, `merge`, `indent`, `outdent` |
| Done and tags | `done set`, `done cycle`, `tag add`, `tag remove` |
| Fields | `field define`, `field set`, `field clear`, `field remove`, `field reuse`, `field select` |
| Definitions | `definition create`, `definition configure`, `definition merge` |
| References | `reference add`, `reference set`, `reference inline`, `reference restore` |
| View base | `view set`, `view group set` |
| View sort | `view sort add`, `view sort set`, `view sort remove`, `view sort clear` |
| View filter | `view filter add`, `view filter set`, `view filter remove`, `view filter clear` |
| View display fields | `view display add`, `view display set`, `view display remove` |
| Saved search | `search create`, `search ensure-tag`, `search set`, `search refresh` |
| Templates | `template apply`; `--preview` is the backfill preview |
| Semantic creation | `daily ensure`, `capture add` |
| Media | `asset ingest`, `asset show`, `asset export`, `media add`, `media set` |
| Lifecycle | `trash`, `restore`, `purge` |

The capability registry owns each command's exact input schema, syntax,
positionals, options, defaults, selectors, cardinality, input/output forms,
mutation semantics, destructive review text, examples, and completion metadata.
Root, family, and exact help plus `outline schema COMMAND`, parser option
admission, and shell completion data derive from that registry. A drift guard
compares the published values. `--json` does not alter help or start Runtime.
Unknown paths and options provide the nearest valid command or exact help step.

Command schema discovery returns the compact request schema by default and
exposes result or request/result pairs only through `--part`. Reusable cyclic
definitions are hoisted into one root `$defs`; each request schema is guarded
below 512 KiB. Schema failures follow the best matching discriminated branch
and return bounded JSON Pointer issues without reflecting rejected values.

### Complete-resource porcelain contract

One complete resource intent uses one porcelain invocation. Complex state for
that resource uses the same command's `--input FILE|-`; multiple resources,
dependencies, cross-date work, or bounded batch updates use one ChangeSet with
bindings. No common flow requires a shell mutation loop, an intermediate
created-ID read, or several mutation Operations.

`add` creates a complete typed tree, including rich content, descriptions, code,
checkbox/done state, tags, fields, references, media, and children. Authored IDs
use canonical `node:<uuid>` values, all definition paths share one closed field
type union, and capture metadata uses the complete public provenance schema.
`search
create` accepts title, STRING_MATCH `--match` shorthand or canonical `--query`,
and complete initial view state; its parent defaults to `@saved-searches`.
`search set` atomically patches query, title, and complete view state and refreshes
materialized results. `view set` is a declarative patch; omitted properties are
preserved and only its explicit `replace` object replaces sort, filter, or
display collections. Leaf view commands remain for small edits.

`definition create` accepts complete initial tag or field configuration,
templates or options, defaults, inheritance, and type-specific constraints.
`field define` creates or reuses a field on one target and may include its initial
value. `capture add` accepts one parent or local date, ensures the date when
needed, preserves provenance, and creates the typed child tree. `media add`
accepts a local path or stdin, stages its lease, and creates the media Node in
one invocation; `asset ingest` remains the explicit staging/review primitive.
Create and ensure results include created/bound IDs in the Operation's bounded
return Projection. `@library` and `@saved-searches` avoid internal system-ID
discovery.

Command ownership is object-specific: `definition create` creates reusable
definitions, `field define` attaches or creates a field on a target, and `tag
add` applies an existing tag. Root `set` patches generic Node properties;
`media set` patches media source/geometry; `search set` patches Search query/view
state and refreshes results. `create` and `add` are explicit creation. Omitted
patch properties preserve state, while `set`, `configure`, and `ensure` converge
or return semantic no-change after settlement.

`text replace` is the generic literal `TextTransform` porcelain, not a
scenario-specific Runtime API. It accepts one exact target or a canonical query /
STRING_MATCH selection with mandatory `many + max`, plus a separate total
replacement bound. It computes a text-patch ChangeSet from one bounded
Projection, binds the ChangeSet to that Projection revision, preserves marks and
inline references outside replacement ranges, and rejects a match that would
consume an inline reference. The generated text-patch instructions carry an
explicit reviewed-replace marker; Runtime does not infer destructive intent from
the `replace_all` patch shape because normal editor synchronization also uses
that shape. It is destructive porcelain: preview and exact Diff acknowledgement
are required for non-interactive apply. A repeated settled transform with no
remaining match is semantic no-change.

Common discovery does not require repeated reads. `show ID...` preserves ordered
exact IDs; direct and CLI reads infer bounded `many` cardinality for `ids`,
`query`, and `search`. A complete read Projection is standalone input; any
separately supplied Selector must match its target exactly, and ChangeSet bindings
remain unavailable outside ChangeSets. A Projection may return selected Nodes and
backlinks in one response, using one request-local reference summary for every
selected target rather than one whole-document scan per target.
`find --search` executes Saved Search query state live rather than trusting stale
materialized children. Exact count omits Node payloads, while named batch counts
combine one optional shared query with each named query through canonical `AND`
and reuse one request-local text selection index.

Create, move, and duplicate share the public placement union: first, last,
zero-based index, before, and after; move and duplicate add previous and next.
Relative move shifts a selected sibling block, while relative duplicate places a
copy next to each source. Structured ChangeSets and argv porcelain lower to the
same placement and one exact-revert Operation.

Reference actions remain semantic rather than overloaded. Set retargets an
existing tree reference, replace substitutes a tree reference for a content Node
and Trashes the original subtree, and inline owns inline-reference replacement or
conversion. Inline argv may omit its reference target only when converting an
existing tree reference; content replacement and structured input require an
explicit reference target. Query rules likewise use one executable registry with closed
operator-specific schemas; internal non-executable values such as `EDITED_BY`
are not public input.

Every exact command help names whether it is create, patch, replace, ensure,
destructive, and/or idempotent. Destructive help requires preview, review, and
the same command with the preview's `--idempotency-key`, `--expect-diff HASH`,
and `--yes`; it explicitly rejects the idea that `--yes` alone is sufficient.
The five golden help surfaces are root, `search`, `search create`, `view sort
add`, and `purge`.

### Complete-resource golden workflows

CLI-level golden tests cover all of these observable workflows:

1. create and revert a `module` table Saved Search with updated-desc sort;
2. create and revert a complete Projects table through one ChangeSet/Diff/apply;
3. create definitions and consume bindings on new and existing Nodes;
4. ensure a date and create a typed tree below its binding;
5. capture a provenanced typed tree to one date in one invocation;
6. stage and add local media in one invocation while retaining its asset;
7. apply done, tag, and field changes to a bounded `many + max` query;
8. create two Nodes and cross-reference their bindings;
9. preview and apply template backfill as one Operation;
10. preview, confirm, and revert Node/definition merge, purge, and Empty Trash;
11. prove repeated configure/set/ensure execution creates no duplicate semantic
   state or additional Operation; and
12. expose Operation ID, affected count, and recovery state for every flow; and
13. preview, apply, converge, and exactly revert one literal replacement over a
    bounded query while preserving unaffected rich-text marks and references.

Each test asserts final document state, mutation invocation count, Operation
count, and exact revert. Capability registry parity without these end-to-end
workflow assertions is insufficient evidence.

`purge @trash --contents` is Empty Trash. `purge` and `revert` are available to
all callers, including built-in Agents. Confirmation and recovery admission are
actor-neutral operation rules, not capability restrictions.

### Read and observe flows and event retention

`find`, `show`, and `export` resolve through Runtime's maintained Projection
index and structured query engine. The service handles selectors, visibility,
bounds, pagination, and export for desktop and CLI clients. Current read-model
code may be moved or replaced only after behavior fixtures pass; its present
shape is not part of the contract. Agent-specific Memory filtering is not part
of this path.

`Event` records are one of `projection.changed`, `operation.committed`,
`operation.reverted`, `operation.recovery-expired`, or `resync.required`. They
include Runtime instance, revision, event sequence, Operation summary when
applicable, and an optional bounded Projection requested by the watcher. Events
are emitted only after the corresponding public settlement point.

Runtime retains a bounded ring of 10,000 events for its current instance. A
cursor binds instance ID, sequence, revision, filter, and Projection hash.
Reconnect within the ring resumes exactly; an expired cursor, Runtime restart,
or filter mismatch emits one `resync.required` record and closes cleanly. The
client performs a bounded read and starts a new watch; Runtime never implies
that an incomplete stream is complete.

An attached Projection is valid only at its Event revision. When a projected
watch replays a historical Event that Runtime cannot reconstruct at that exact
revision, it emits one `resync.required` and closes rather than attaching the
current workspace Projection to the historical Event.

### Desktop client cutover

Electron main creates one shared `OutlineClient`, starts Runtime when needed,
and forwards versioned request/stream envelopes through preload. Preload exposes
only typed `request`, `subscribe`, and cancellation methods; it never exposes
socket paths, tokens, filesystem handles, or Node APIs. Renderer state consumes
Projection results and revision-ordered Events exactly as an external client
would. A desktop subscription is handshake-bounded rather than command-bounded:
failure before the first `hello` settles as unavailable, while an established
subscription remains a Runtime lease and resumes from its cursor after a clean
end or transport reconnect.

Every renderer action that changes persisted Outliner state constructs the same
public ChangeSet used by CLI. Shared intent builders may provide typed desktop
porcelain, but they return contract objects and contain no Core calls. Ordinary
non-destructive editing uses direct commit; destructive operations and commands
whose focus/result logic depends on Diff bindings or affected rows use the
reviewed Diff path. Existing renderer command names are a migration inventory,
not a preserved transport. Once parity passes, the old document-command IPC
dispatcher is deleted. Native file pickers, external URL opening, window
actions, and other OS/UI effects stay in Electron main because they are
explicitly outside the Outliner Runtime.

The editor remains perceptually local: keystrokes update an optimistic
renderer-owned draft, and a bounded debounce/blur/explicit-command boundary
submits a text ChangeSet with expected revision. The draft is not document
authority. Runtime acknowledgement returns its Operation/revision; a conflict
keeps the draft recoverable and presents the existing editing conflict/error
surface rather than silently replacing remote state. Chunking and debounce are
selected from the existing latency probe, not assumed.

Runtime Events reconcile optimistic local state by Operation ID and revision,
so self-originated acknowledgement and broadcast apply once. Desktop Undo/Redo
select recoverable Operations and use guarded revert. Window close and app quit
wait for submitted ChangeSets to settle but do not flush workspace files
themselves; Runtime owns durability.

Semantic no-change produces no Operation Event. Desktop mutation adapters branch
on `outline.no-change`, adopt its revision and current/full Projection directly,
and never enter Operation-ID settlement waiting.

Desktop parity is a hard gate before legacy deletion: every persisted command,
batch action, launcher capture, date ensure, view/definition mutation,
attachment/media path, Trash action, and history action must pass through
Runtime in renderer tests and packaged E2E. A static dependency guard rejects
Core, workspace persistence, Operation journal, recovery, or asset-store imports
from Electron main and renderer code.

### Full Agent authority and trusted causation

The built-in Agent invokes `outline` through its admitted shell/process tool.
The host places the packaged CLI on the ordinary Agent tool path and supplies a
short-lived attestation in a private environment variable for each shell Item.
The attestation is minted from host-known Thread ID, Turn ID, and Item/tool-call
ID, expires after 60 seconds, is bound to the Runtime instance and workspace,
and is never accepted from ChangeSet JSON or argv.

The CLI forwards the opaque attestation separately from its public request body.
Runtime verifies it and records immutable causation on successful Operations.
A request declaring built-in Agent origin without a valid attestation may read
but cannot mutate; it returns `agent_attestation_required` rather than silently
recording local-user origin. Ordinary terminal and external clients do not need
an attestation and receive the same mutation schema under user-level authority.

One shell Item should compose dependent work into one ChangeSet and therefore
one mutation. The attestation may authorize multiple read/diff calls but is
consumed by its successful mutation; a later mutation obtains a new Item and
attestation. This preserves exact Item causation without reducing available
Outliner operations.

Remove the current Outliner-specific action grants, Node-resource visibility,
and Memory projection filters from Agent tool execution. Preserve Memory's
mutation observation and causation-based indexing; only filtering that changes
what the Agent can read through Outliner is retired. Local-file/shell controls,
worktree isolation, explicit global capability blocks, and native OS failures
remain owned by their existing systems and are not recreated in Runtime.

CLI results flow through the normal shell Item artifact path. Concise output
always keeps Operation ID, status, affected count, and recovery state visible;
large Projection/export data is streamed or written to an explicit artifact so
tool-result trimming cannot hide mutation settlement.

An optional `agent.execution: "read-only"` policy remains outside the Outline
contract. The Host persists and inherits it across nested Agents and isolated
Skills, filters static mutation tools, and dynamically rejects non-read-only
Bash or extension action kinds before execution. It preserves Outline schema
discovery and reads while rejecting `outline.edit` and `outline.delete`.

Background notification, peer-message, and exhausted-settlement Turns carry no
synthetic user text. Host rules and metadata plus untrusted Agent output travel
through typed additional context with `systemContext` provenance; durable
settlement digest recovery validates that context payload rather than a
`userMessage` Item.

### `outline` Skill

Add one immutable built-in Skill named `outline`. Its frontmatter makes it
discoverable for requests to inspect, edit, organize, import into, or recover
the outline. Organize the Skill around the Agent's operating loop: discover,
inspect, choose one mutation shape, review, execute, verify, and recover. Keep
the entrypoint short enough to load for every Outline task while retaining the
non-obvious invariants around selectors, cardinality, atomic composition,
destructive review, Operation settlement, and guarded recovery.

Use inline execution. Outline work depends on the parent Turn's exact user request,
visible document context, research, and corrections; an isolated child would require a
lossy model-authored restatement of that state. Inline loading does not widen the
parent's effective tool catalog. Across the general Skill runtime, invocation arguments
remain task input: no-placeholder bodies never receive an implicit appended argument,
and isolated Skills receive authored instructions as child developer guidance plus the
invocation task as a separate user message. Isolated embedded-shell output is a distinct
untrusted child observation rather than developer guidance. Standard shell placeholders
bind invocation values through controlled environment variables instead of command-source
interpolation; retained resources cross into the child by stable references and resolve
fresh readable paths during projection.

Use progressive disclosure rather than many peer references:

- `SKILL.md` owns the common decision loop and routes conditional work;
- generated `references/commands.md` is the complete public command map;
- `references/changesets.md` is loaded only for dependent, cross-date, or
  bounded multi-resource work; and
- `references/import.md` is loaded only for external data workflows.

Generate `commands.md` from the same capability registry that owns parser,
help, schema, and completion metadata. A drift guard fails when the generated
reference is stale. The Skill uses root/family/exact help for discovery and
`outline schema COMMAND` for exact structured contracts; it does not copy JSON
Schemas or parser logic and does not invent a model-native wrapper tool. For
ordinary document work it does not create ad hoc Python, Node, or shell programs
to inspect schemas, transform CLI output, or assemble ChangeSets; it uses the
public command-specific schemas, supplied fixtures, and direct `--input`
artifacts. Bundled source adapters remain limited to the external import path.

`references/changesets.md` links one complete field-backed Daily Note table
fixture. The mandatory table golden executes that same artifact through Diff,
apply, independent view/field assertions, and exact revert, so Table View
topology is executable Skill guidance rather than a schema-discovery script.

### `outline` Skill import workflow and import convergence

Fold the retired `tenon-import` workflow into the immutable built-in `outline`
Skill. Import is a scenario proof of general composition, not a separate Skill
or Runtime namespace. Expose the general orchestration as public CLI commands:

1. `outline import inspect SOURCE` returns a bounded source profile without
   starting Runtime or writing document state;
2. a bundled or Agent-authored read-only adapter converts source-specific data
   into public `NormalizedImport` plus complete source-record coverage;
3. `outline import plan` validates the normalized source, builds one generic
   ChangeSet, creates the immutable Diff, and binds coverage and fingerprints as
   review evidence;
4. `outline apply --input DIFF` applies the exact reviewed artifact once; and
5. `outline import verify` binds the resulting Operation to the reviewed Diff
   and evidence, then performs bounded independent reads.

Cleaning is optional. Input that already matches `NormalizedImport` proceeds
directly to `import plan --format normalized`. Adapters may only read authorized
source files and emit normalized data and coverage; they cannot access Tenon,
invoke mutations, or own ChangeSet/Diff/Operation semantics. Runtime recognizes
only the generic ChangeSet, Diff, and Operation contracts.

Cross-date import emits one `ensure` per unique local date, binds each date Node,
and creates the corresponding trees below those bindings. One source containing
100 dates uses one `diff` and one `apply`, with no per-date ID discovery and no
shell mutation loop. Existing date scaffolding remains untouched; newly ensured
year/week/day Nodes are inside the same patch, Operation, and revert frontier.

Normalized hierarchy lowering preserves a separate create binding only when a
later operation consumes that Node ID, including the ancestor path required to
place a tagged descendant. Other descendants fold into the nearest bound
`NodeDraft.children` tree. This reduces operation count without changing source
coverage, final hierarchy, typed content, one-Operation settlement, or exact
revert semantics. It is generic ChangeSet composition, not an adapter-specific
Runtime fast path.

Keep optional source-specific read-only adapters and fixtures inside the Skill.
An Agent may instead write a task-local adapter against the public normalized
schema. Delete any Skill-local orchestration helper, Tana-to-ChangeSet writer,
coverage verifier, or Runtime client so the public CLI remains the sole import
workflow authority. Also delete the main-owned Import Pack parser/writer,
preview cache, commit service, `/preview` and `/commit` endpoints, causation
exception, `tenon-import` binary/wrapper, and import-specific packaging
resources. No old Import Pack reader or alias remains.

### Capability parity and old-surface retirement

The public capability registry is defined from the target Outliner domain, not
from `DOCUMENT_COMMANDS`. Migration completeness is artifact-driven: a parity
script reads the legacy renderer/Core commands, persisted asset capabilities,
desktop action fixtures, native Agent tools, and the target registry. Every
legacy item must be classified as:

- represented by a public read/Projection;
- represented by one public Change variant;
- represented by porcelain;
- internal initialization/recovery plumbing with a documented reason; or
- intentionally excluded non-document OS/UI effect.

The script fails on an unclassified item, duplicate ownership, accidental
public Core-command spelling, or a documented public operation without a
Runtime handler and test. It specifically proves coverage for rich content, fields, tags,
definitions, references, saved searches, views, done state, batch selectors,
templates, Daily Notes, capture provenance, Trash/purge, images, attachments,
icons, banners, export, operation history, observation, and exact revert.

Replay the fixture corpus for `node_search`, `node_read`, `node_create`,
`node_edit`, `node_delete`, and `outline_undo_stack` through the `outline` Skill
and CLI before removing them. Add fixtures for capabilities those tools lack:
purge/Empty Trash, media, capture, template backfill, canonical multi-date
writes, direct field values, reference/inline conversion, and bounded batch
operations.

After desktop and Agent parity pass on the feature branch, delete the old
renderer document dispatcher and all six native tools from the registry,
provider catalog, schemas, descriptions, handlers, result views,
visibility/action-set paths, and active tests/specs. Existing frozen Threads
must start a new Thread; no compatibility handler interprets old calls.

A retirement guard derives its queue from `rg` over `src`, `tests`, `scripts`,
`package.json`, active `docs/plans`, and `docs/spec`. It fails on live references
to the six tool names, `tenon-import`, `AgentImportService`,
`AgentImportApiServer`, Import Pack write types, import socket paths, import-only
causation environment variables, or deleted package resources. Historical
archive references are reported separately and allowed only as history. Ready
means the live queue is empty, not that a hand-maintained checklist is checked.

### Packaging and distribution

`package.json` replaces `import-cli:build` with one `outline:build` step that
produces two audited ESM bundles under `Resources/outline`: the thin
`outline.mjs` client and the standalone `outline-runtime.mjs` server. A single
`Resources/outline/bin/outline` launcher resolves development versus packaged
entries and is added once to the ordinary Agent executable path.

The CLI bundle includes only public contract, shared client, argv/parser,
discovery/start, formatters, and porcelain builders. It cannot import Core,
Loro, storage, Electron main, Agent runtime, or source adapters. The Runtime
bundle includes contract, Runtime domain, Core, query/projection engine,
transaction log, Outline AssetRecord storage, and the neutral `src/content/`
kernel;
it cannot import Electron, renderer, Agent provider/runtime, CLI argv, or Skill
code. Bundle dependency guards enforce both directions.

The built-in `outline` Skill invokes the one packaged launcher and contains no
private executable wrapper. Replace `tenonImportRuntime`,
`tenonImportShellEnvironment`, and `tenonImportResourceNames` with generic
Runtime discovery/path plus Agent-attestation configuration.

The packaged DMG smoke test verifies:

- the CLI and Runtime resources exist and run as separate Node entries;
- `outline version`, `schema`, and `capabilities` run without Runtime;
- a document command starts standalone Runtime with isolated userData and no
  Electron import;
- Runtime receives explicit Runtime and ContentStore roots derived from the same
  userData authority, never from `cwd` or `dirname(runtimeRoot)`;
- desktop and CLI concurrently attach to the same Runtime and observe one
  document/event sequence;
- quitting/reopening desktop does not move document authority or start a second
  writer; and
- the built-in Skill resolves the packaged CLI binary for every workflow.

No global `/usr/local/bin` or shell profile mutation occurs during installation.
The supported public entry is the bundled Skill/Agent path and the executable
under the app's Resources directory; documentation gives the exact packaged
path and an optional user-created symlink command without performing it.

### Expected file surface

New files are expected under:

- `src/content/` for the domain-neutral multi-process exact-revision store,
  private retention-anchor types, admission/integrity/GC state, and focused
  tests;
- `src/outline/contract/` for public contracts, schemas, canonical hashing,
  errors, and the target capability registry;
- `src/outline/runtime/` for Runtime domain, process/server, transaction log,
  snapshots, recovery, events, projection index, Outline AssetRecord storage,
  and exact-revision/retention-anchor integration;
- `src/outline/client/` for shared discovery, supervision, negotiation,
  requests, and streams;
- `src/outline/cli/` for the thin client entry, formatting, and porcelain;
- `src/main/outlineClient/` for Electron supervision, typed forwarding, and
  preload integration;
- `src/main/builtInSkills/outline/` for the Skill plus its import adapters,
  fixtures, references, and helper scripts;
- `scripts/` for capability-parity, retirement, packaging, and provider probes;
  and
- focused Core/main/CLI/Skill/process fixtures under `tests/`.

Coordinated modifications include `Core.transaction`, transaction patch types,
renderer document state/actions/events, preload/main protocol forwarding,
launcher capture, native file/asset handoff, Agent shell environment and tool
catalog, Memory's Outliner projection hooks, built-in Skill configuration,
`package.json`, and packaging resources.

Current main-owned `DocumentService` behavior is decomposed/re-homed behind
Runtime. `OperationJournal` becomes the transaction-log Operation index;
`WorkspaceSaver` is removed; `WorkspacePersistenceStore` is replaced by the
checksummed `WorkspaceTransactionLog` and snapshot compactor; `AssetService` is
replaced by logical Outline AssetRecords referencing neutral exact revisions.
Electron main retains no imports of Outline domain authorities after cutover;
its later Agent services may import only the neutral content kernel.

The feature deletes the live import-only files and `tenon-import` Skill/resource
tree after its reusable adapter fixtures move into `outline`. It deletes
`agentNodeTool*` and `agentOutlineParser` files only after shared selector/read
logic has moved and the retirement guard proves no remaining consumer.

The implementation updates current behavior in the same PR:

- `docs/spec/architecture.md` owns standalone Runtime lifecycle, desktop client
  boundary, socket security, transaction-log/recovery storage, and single-writer
  ownership;
- `docs/spec/commands.md` owns the unified desktop/CLI Outliner contract,
  operation/revert behavior, assets, and GC;
- `docs/spec/agent-tool-design.md` removes six native tools/import APIs and owns
  CLI-through-Skill execution and result audit;
- `docs/spec/agent-tool-permissions.md` records full Outliner authority with
  trusted causation and no Node/action/projection scope;
- `docs/spec/agent-skills.md` owns the built-in Skill and the boundary between
  ordinary outline work and its import workflow;
- `docs/spec/agent-integration.md` owns causation, shell environment, parity,
  and cross-layer verification; and
- `docs/spec/outliner-parity-matrix.md` records the final public capability
  mapping and evidence.

No new spec authority is needed, so `docs/spec/README.md` should not change
unless implementation proves an existing owner cannot carry one of these
contracts.

### Ownership and collision handling

This feature requires one dev owner because `package.json`, main startup,
`src/core/commands.ts`, and `src/core/types.ts` are infrastructure/protocol
surfaces and the old consumers must disappear in the same PR. The first commit
inside the Draft PR settles pure contracts and transaction hooks for review;
it is not merged as separately released groundwork. Later commits build only on
that settled shape.

The reference URI foundation shipped in #590. This PR rebases onto that complete
cutover and preserves canonical `[[node://...]]` and
`[[file:///...]]` references through Runtime, CLI, Agent, import, export, and
Skill paths. It must not restore the retired `kind:label^value` or `file:^path`
grammar while replacing those consumers.

The active `agent-result-and-file-lifecycle` plan is the governing physical
content model. This Runtime PR is the first consumer and therefore establishes
the neutral `src/content/` ContentStore and `{userData}/content/` root as part of
the complete Runtime feature. Outline AssetRecords reference exact revisions
through mechanical retention anchors; neither records nor anchors own physical
bytes. This PR must not land an Outline-specific physical blob root that a later
Agent PR replaces. Raw digests and anchor IDs are absent from public CLI,
renderer, ChangeSet, Operation, and model authority; every asset
read/export/preview path resolves through an Outline AssetRecord and explicit
use intent.

This PR does not add Agent resource-reference records or change current Agent
binary-resource handling. The later Agent lifecycle PR consumes the
already-neutral exact-revision kernel. #587 rebases after this PR and treats
its existing managed-resource handle opaquely until that cutover.

Before claiming the work, the dev reruns `gh pr list`, scans `docs/TASKS.md`, and
compares every intended file area with open Draft-PR scope lines. Any real
overlap on protocol, main lifecycle, persistence, assets, Agent tools, or built-in
Skills is escalated before editing. With no overlap, the Draft PR's first body
line claims those areas explicitly. The dev does not edit `docs/TASKS.md` or
`CHANGELOG.md`; main owns those changes at the integration gate.

### Requirements, acceptance, and verification matrix

| Contract | Required evidence |
| --- | --- |
| Selector/Projection and output (`FR-1`, `FR-2`) | Golden schemas and envelopes; test titles `resolves identical human and JSON target sets`, `rejects ambiguous mutation selectors`, `paginates at a bound revision`, and `emits resumable JSONL records` |
| ChangeSet normalization (`FR-3`, `FR-4`, `FR-12`) | Property/golden tests showing porcelain/direct equivalence, stable canonical hashes, fixed IDs/bindings, non-mutating Diff, 100-date one-diff/one-apply, and bounded returned Projection |
| Complete-resource porcelain (`FR-13`) | Thirteen CLI golden workflows (`AC-52` through `AC-65`) asserting final state, mutation invocations, Operation count, visible settlement/recovery fields, created IDs, and exact revert; no common resource flow requires an ID lookup or shell mutation loop |
| Help and discoverability (`FR-14`) | Root/family/exact help goldens for `outline`, `search`, `search create`, `view sort add`, and `purge`; registry drift tests compare exact command schema, help options, completion metadata, parser admission, semantics, defaults, and examples |
| Efficient general composition (`FR-15`) | CLI tests for ordered multi-ID, backlinks, live Saved Search, exact and named batch counts, every placement form, disjoint reference actions, exact query-operator registry parity, field-type validation, ancestor-folded Trash, origin-isolated undo/redo, expected-operation conflicts, one Operation, and exact revert |
| Atomicity and concurrency (`FR-5`, `FR-6`) | Tests `rolls back every chunk after a late Change failure`, `rejects a stale Diff without writes`, `does not retry a stale mutation`, and `requires Diff-bound destructive acknowledgement` |
| Durable recovery (`FR-5`, `FR-12`) | Restart tests for ordinary edits, create/delete, purge, Empty Trash, revert conflict, revert-of-revert, crash before log append, crash after log fsync/before acknowledgement, truncated tail, orphan blob, corrupt referenced blob, idempotency, retention, and capacity |
| Asset safety (`FR-5`, `FR-12`) | Fixtures proving Node-referenced, leased, and recovery-only AssetRecords retain exact revisions through opaque anchors; anchor-first crash points leak rather than lose; the Runtime barrier prevents reconciliation from releasing an in-flight anchor; successful reconciliation releases only orphan Outline anchors; central GC cannot race concurrent anchor creation; physical corruption differs from corrupt AssetRecord metadata; purge recovery restores media; `delete_asset`, public digests, and public anchor IDs are absent |
| Runtime lifecycle (`FR-10`) | Process tests for CLI start, desktop start, `--no-start`, stale descriptor/lock, simultaneous desktop/CLI startup, shared attachment, independent desktop restart, idle drain, unavailable timeout, private permissions, no client persistence import, one-time manual installed/dev reset, fresh physical layout, and no migration/automatic-deletion path |
| Desktop cutover (`FR-3`, `FR-5`, `FR-11`) | Renderer/preload/E2E proof that every persisted desktop action produces Runtime Operation/Event, optimistic drafts reconcile once, conflict keeps draft, Undo/Redo uses guarded revert, and dependency guard finds no document authority in Electron main |
| Agent authority (`FR-8`, `FR-9`) | Registry equality test for local-user and built-in-Agent schemas; valid/missing/expired attestation tests; immutable Thread/Turn/Item audit; full purge/revert coverage; no Memory projection filtering |
| Import composition (`FR-7`, `FR-12`) | No-clean and cleaned source fixtures, complete coverage gate, changed-input/Diff mismatch, 100+ Daily Notes, binding-required hierarchy folding, deterministic Tana weekday/supertag mapping, explicit unsupported accounting, mixed parents, failed verification with Operation ID, exact revert, and no scenario Runtime endpoint |
| Native tool cutover (`FR-9`) | Six-tool fixture replay, new capability fixtures, generated parity report with zero gaps, provider probe, and retirement guard with an empty live queue |
| Packaging/security (`NFR-1` through `NFR-6`) | Thin-bundle dependency assertion, packaged CLI/Skill smoke, socket/descriptor mode checks, credential-redaction checks, bounded JSONL/export probes, and recovery disk-budget tests |

Provider parity is measured on the old-tool baseline and the new Skill/CLI branch
with identical prompts, fixture workspaces, provider/model, and run count. At
least one Anthropic and one OpenAI-compatible production model are exercised
when credentials are available. The hard gate is identical correct final
document state, no partial writes, visible Operation ID/recovery state, and no
scenario requiring more than one mutation Operation. Record tool/schema tokens,
model-visible tokens, CLI invocation count, end-to-end latency, and failure
recovery; latency is evidence for optimization, not a reason to weaken
atomicity, attribution, or durability.

Performance probes cover cold Runtime start, warm reads, a single-intent porcelain
mutation, 10,000-result export, 100-date apply, and a large tree ChangeSet.
Capture event-loop stall distribution and memory high-water marks before tuning
chunk sizes. Cooperative chunking may improve responsiveness but may not create
multiple public transactions or expose intermediate persistence.

The final branch runs:

- `bun run typecheck`;
- `bun run test:core`;
- `bun run test:renderer` because renderer command/asset surfaces change;
- focused CLI/process/Skill tests and relevant E2E coverage;
- `bun run docs:check`;
- the generated capability-parity and retirement guards;
- `bun run app:build` plus packaged standalone-Runtime/desktop/CLI smoke; and
- `git diff --check`.

### Risks and mitigations

- **Preview/live divergence:** An ephemeral Core could produce a different
  patch from live execution. Fix all IDs during normalization, share one
  executor, and compare exact patch digests inside the live rollback frontier.
- **False recovery confidence:** History metadata alone does not restore state.
  Commit document update, Operation, recovery-patch reference, asset delta, and
  idempotency result in one fsynced log record; test replay at every crash edge.
- **Recovery storage growth:** Large purges and media can retain substantial
  state. Enforce the 30-day/1,000-operation floor, 2 GiB admission budget, and
  fail before mutation rather than evict protected recovery.
- **Asset loss or leaks:** Direct unlink can destroy revert data, while never
  deleting grows storage forever. Remove public delete, use logical AssetRecords
  over central exact revisions, bias cross-store crashes toward leaked
  anchors, reconcile
  only under the Runtime mutation barrier, and let ContentStore GC atomically
  select only unanchored/unleased revisions.
- **Runtime startup races:** Desktop and CLI can start the server concurrently.
  Use one Runtime-specific atomic lock/descriptor identity, make losers attach,
  and keep Electron's UI single-instance lock unrelated.
- **Desktop interaction latency:** Moving authority out of Electron main adds a
  process hop and durable commit boundary. Keep editor drafts optimistic, batch
  only at measured semantic boundaries, stream Events, and reject any design
  that restores in-process document authority as a latency shortcut.
- **Runtime crash visibility:** A separate process can exit while desktop is
  open. The client reports unavailable state, preserves local drafts, restarts
  through the common supervisor, and resumes from verified revision/cursor.
- **Transaction-log corruption:** One log removes split settlement but raises
  the importance of its codec. Use checksummed records, verified snapshots,
  incomplete-tail handling, verified app-level blobs, replay/property tests, and
  fail-closed mutation admission at decode boundaries.
- **CLI business-logic growth:** Porcelain and route handlers can duplicate
  Runtime semantics. Generate them from the registry and require every mutation
  to lower into ChangeSet before document access.
- **Oversized ChangeSets:** Import-sized input can block Runtime or exhaust memory.
  Use bounded JSONL parsing, private spool files, registry-schema compiled
  validators, binding-aware tree folding, incremental Core state views,
  cooperative Core chunks, and one rollback frontier; measure stalls before
  selecting thresholds.
- **Agent attribution loss:** A child process can drop or forge context. Keep
  causation outside public JSON, bind the host attestation to Runtime/workspace/
  Item, reject declared built-in mutation without it, and test expiry/consumption.
- **Skill reliability regression:** Shell use can save schema tokens but add
  model round trips or hide settlement. Give one concise Skill, batch dependent
  work, keep Operation summaries visible, and require deterministic plus
  production-provider parity before retirement.
- **Incomplete retirement:** A private import or native handler could survive as
  a second path. Generate parity and retirement queues from current files and
  make empty output a readiness gate.
- **Stale specs and plans:** Removing a subsystem invalidates current premises.
  Sweep active specs/plans in the retirement PR; main updates the board,
  changelog, lesson, plan archive, and any remaining retirement references at
  the merge gate.

## Open questions

None. Standalone Runtime authority, desktop-as-client architecture, one durable
transaction log, public binary name, authority model, lifecycle, one-PR delivery
shape, recovery policy, asset deletion boundary, import composition, Agent
capability equality, legacy retirement, and MCP exclusion are fixed for
implementation.

## Build checklist

- [x] **1. Claim one complete feature and freeze the public contract.** Re-run
  collision checks, open one Draft PR with the full file/area scope, add the
  pure `src/outline/contract/` schemas/registry/hash/error modules, and add golden
  tests for all versioned contracts, commands, JSON/JSONL envelopes, and exit
  mappings. Covers `FR-1`, `FR-2`, `FR-3`, `FR-6`, `FR-12`; acceptance
  `AC-1` through `AC-6`, `AC-12`, `AC-13`, `AC-24`, `AC-29`.
- [x] **2. Expose exact Core transaction patches.** Extend the transaction
  boundary to retain immutable complete before/after touched-Node patches until
  post-fsync finalization, capture deterministic document updates, add the
  trusted recovery-patch command, and prove create/update/move/heal/delete/chunk
  rollback coverage. Covers `FR-3`, `FR-5`; acceptance `AC-6`, `AC-9`,
  `AC-35`.
- [x] **3. Build the transactional storage authority.** Add checksummed
  `WorkspaceTransactionLog`, verified snapshots, content-addressed recovery
  blobs, atomic Operation/idempotency/Event records, guarded revert/revert-of-
  revert, crash replay, 30-day/1,000-operation retention, and 2 GiB admission
  budget. Delete split saver/journal settlement. Covers
  `FR-5`, `FR-6`, `FR-12`; acceptance `AC-8` through `AC-13`, `AC-32` through
  `AC-35`.
- [x] **4. Build the standalone Runtime process.** Add transport-independent
  handlers, Unix-socket adapters, descriptor/authentication, Runtime-specific
  single-writer lock, shared client/supervisor, event cursors, idle drain, and
  deterministic desktop/CLI discovery/start. Prove the server imports no
  Electron/renderer/Agent provider code and clients import no persistence. Covers
  `FR-2`, `FR-10`, `FR-11`; acceptance `AC-3` through
  `AC-5`, `AC-20` through `AC-22`, `AC-37`, `AC-38`.
- [x] **5. Implement the shared Selector/Projection/ChangeSet kernel.** Move
  reusable Outliner parser/read logic out of Agent capability modules; add
  deterministic selectors, cardinality, bindings, fixed IDs, preview Core,
  normalization, Diff/apply, large JSONL framing, bounded returned Projections,
  and watch. Covers `FR-1` through `FR-7`, `FR-10`, `FR-12`; acceptance
  `AC-1` through `AC-15`, `AC-20`, `AC-21`, `AC-24` through `AC-29`.
- [x] **6. Cut the desktop over as an equal client.** Route every persisted
  renderer/launcher action, read, event, asset handoff, and Undo/Redo through
  shared contracts; preserve optimistic editor drafts and conflict recovery;
  add client-dependency guards; and pass complete desktop parity before deleting
  the old dispatcher. Covers `FR-3`, `FR-5`, `FR-10`, `FR-11`; acceptance
  `AC-6`, `AC-9` through `AC-13`, `AC-20` through `AC-22`, `AC-32` through
  `AC-36`.
- [x] **7. Complete CLI and document parity.** Implement the thin client,
  lifecycle discovery, output formatting, direct ChangeSet commands, all
  complete-resource porcelain families, exact root/family/command help and
  schema/completion generation, history/recovery commands, and a registry
  mapping for every persisted Outliner capability. The generated
  unsupported-capability report must be empty. Covers `FR-1` through `FR-6`,
  `FR-10` through `FR-14`; acceptance `AC-1` through `AC-13`, `AC-20` through
  `AC-22`, `AC-24` through `AC-29`, and `AC-32` through `AC-64`.
- [ ] **8. Make assets transactional and recovery-aware.** Add the neutral
  multi-process ContentStore, opaque retention anchors, and logical AssetRecords;
  add staged leases and CLI ingest/show/export; include asset references and size
  reservations in recovery patches; implement anchor-first capture settlement,
  Runtime-barrier reconciliation, central anchor/lease GC, and distinct physical
  versus record corruption; remove public `delete_asset`, digest, and anchor
  authority; and prove purge/revert/expiry/concurrency/crash behavior. Covers
  `FR-5`, `FR-12`; acceptance `AC-11`, `AC-34` through `AC-36`.
- [x] **9. Add the Outline Skill and absorb import.** Add the operation-loop
  `outline` Skill, its registry-generated command map, and focused ChangeSet and
  import references; expose public import inspect/plan/verify; keep adapters
  read-only and normalized-output-only; prove no-clean and 100-date workflows;
  delete Skill-local orchestration, Import Pack writes, private API/service,
  binary, causation exception, and packaging. Covers
  `FR-7`, `FR-9`, `FR-12`; acceptance `AC-14`, `AC-15`, `AC-18`, `AC-19`,
  `AC-23` through `AC-29`.
- [x] **10. Cut the built-in Agent over with full authority.** Put `outline` on
  the ordinary Agent path, generalize host attestation for shell Items, record
  immutable causation, keep Operation settlement visible, remove Node/action/
  Memory projection scopes, and prove local-user/Agent registry equality plus
  missing/expired attestation behavior. Covers `FR-8`, `FR-9`; acceptance
  `AC-16` through `AC-19`, `AC-30`, `AC-31`.
- [x] **11. Retire every legacy document surface.** Replay desktop and six-tool
  deterministic corpora plus the production-provider probe, then remove the
  main-owned document dispatcher/store, catalog entries, schemas, handlers,
  views, permission paths, stale tests, import writer, and active specs. Run the
  generated retirement/dependency guards until both live queues are empty. Covers `FR-9`;
  acceptance `AC-18`, `AC-19`.
- [x] **12. Fold design into current specs.** Update architecture, commands,
  Agent tool design, Agent permissions, Agent Skills, Agent integration, and the
  parity matrix in the same PR; sweep active plan/spec premises invalidated by
  import/native-tool retirement. Covers architecture rule A6 and the complete
  product-definition acceptance set.
- [x] **13. Pass the complete release gate.** Run typecheck, Core/renderer/
  CLI/process/Skill/E2E tests, docs check, parity and retirement guards,
  performance probes, package build, packaged Runtime/desktop/CLI smoke, provider
  evidence, and diff check. Keep the PR Draft and do not report completion until
  every test passes, both generated queues are empty, and no legacy mutation
  surface remains.
- [x] **14. Harden CLI/Runtime failure semantics.** Enforce exact contract-digest
  attach, bounded startup and command deadlines, complete signal propagation,
  durable CLI recovery keys, unknown-settlement guidance, non-TTY machine output,
  private transport schemas, and minimal porcelain return Projections. Prove the
  behavior with unresponsive-socket, mismatched-contract, lost-acknowledgement,
  signal, recovery, and output-mode tests. Covers `FR-2`, `FR-5`, `FR-10`,
  `FR-13`; acceptance `AC-67` through `AC-73`.
