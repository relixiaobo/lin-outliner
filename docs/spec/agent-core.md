# Agent Core

Agent Core is Tenon's single execution model. Product code, IPC, persistence,
renderer state, and user-visible language use the same four concepts:
`Thread`, `Turn`, `ThreadItem`, and `ThreadGoal`.

## Domain Model

A `Thread` is the durable container for ordered work history and configuration.
It owns stable UUIDv7 identity, lineage, source, model provider, working
directory, timestamps, status, and optional loaded Turns. `sessionId` groups a
root Thread with its descendants; it is only a grouping key.

A `Turn` is one accepted input and its resulting ordered Items. At most one Turn
is active per Thread. A Turn is either `inProgress`, `completed`, `failed`, or
`interrupted`. Terminal Turns are immutable.

A `ThreadItem` is the smallest persisted history fact. Canonical Item kinds are:

- `userMessage`, `agentMessage`, and `reasoning`
- `commandExecution`, `fileChange`, `mcpToolCall`, and `dynamicToolCall`
- `collabAgentToolCall` and `subAgentActivity`
- `webSearch` and `imageView`
- `contextEvidence`, `contextReset`, and `contextCompaction`

Items with execution status start as `inProgress` and complete with a terminal
status. A new `turn/started` event atomically carries its already-complete initial
evidence and user Items. Later streamed and executable Items use `item/started`,
optional `item/delta`, and exactly one `item/completed`; later already-complete facts
use one `items/completed` event, which may publish one or more Items in canonical
order. No initial or completion event accepts an `inProgress` executable Item.
Completed Items and terminal Turns are immutable.

Every `userMessage` stores its admission-time `acceptedAt`. The initial Item uses
the Turn start instant; steering records one instant for both Item persistence and
recorder completion. Replay and forks preserve that timestamp instead of substituting
the current clock.

Context Items are the canonical protocol for hidden model input. `contextEvidence`
names one semantic kind and a content-addressed payload; `contextReset` names an exact
cleared-through cursor; and `contextCompaction` names its trigger, covered range,
preserved tail, summary, reducer checkpoint, and optional active instructions.
Context cursors are exact Turn/Item pairs. Full Thread decoding rejects unreachable or
reversed ranges.

Context payload schema version 1 is an exact-key discriminated union, not arbitrary
JSON. It covers environment, user view, additional context, referenced resources,
Skill/Role catalog journals, Skill invocation, tool-output projection, inherited
context, and the three compaction payloads. Unknown kinds, versions, and fields fail
closed. Each content reference carries its payload kind, and the owning evidence or
compaction Item validates the exact expected kind. Individual context payloads are
limited to 16 MiB. Text entries carry source, authority, and purpose; untrusted text cannot claim
instruction authority, and an inline Skill cannot carry model, effort, or tool
overrides. A compaction reducer checkpoint includes catalog state, active Skill payloads,
the user-view baseline, and active file/Node observations. Each observation retains a
stable key, tool identity, untrusted subject, complete output reference, and frozen
projection reference; it stores neither scratch paths nor another copy of observed
text. Inherited context accepts only complete terminal Turns and requires its
covered-through cursor to resolve inside that snapshot. The canonical projector
consumes admitted environment, user-view, additional-context, referenced-resource,
Skill/Role, inherited-context, tool-output, and compaction evidence at every provider
boundary. Skill and Role reducers record one catalog baseline per context epoch, append
only changed entries, restore validated compaction checkpoints, and start a new baseline
after `contextReset`. A newly discovered Skill or Role can therefore join an existing
Thread without rebuilding or rewriting its earlier provider prefix.

The effective context begins after the latest `contextReset`. Within that epoch, the
latest valid `contextCompaction` replaces only its exact covered range with the recorded
summary and reducer checkpoint, then preserves the declared tail. Automatic preflight
aligns that tail to a canonical complete-Turn boundary; provider-overflow recovery may
preserve only the active Turn. Successful document mutations and undo/redo invalidate
Node observation checkpoints conservatively because a read may contain dependent
descendant or reference projections. Tool output receives
one durable full-or-inline projection before the first provider request that can observe
it; later budget pressure, restart, rollback, fork, and replay reuse that decision.
Provider planning consumes only this reduced canonical Item sequence. There is no
runtime-only context state, reminder parser, or alternate message store.

Every nested context payload, managed resource, or complete tool output named by a
context payload is also an explicit dependency on its owning context Item through
`contextRefs`, `resourceRefs`, or `outputRefs`. Lifecycle operations use that canonical
dependency graph instead of parsing payload-private JSON.
Dynamic tool images carry a typed `localFile` or `threadPayload` source. A managed image
uses that Thread-owned reference as its provider snapshot. A local image retains its
live path for user actions and also carries a mandatory Thread-owned `promptImage`
snapshot for exact provider replay. The owning Item lists every managed source or
prompt snapshot in `resourceRefs`, including images nested inside inherited context.
Fork and child ownership copy those content-addressed resources without rewriting the
private payload, so provider-visible bytes and digests remain cache-stable after source
Thread deletion.

A `ThreadGoal` is attached one-to-one to a Thread and stored separately from
history. It carries objective, lifecycle status, optional token budget, token
usage, continuation deferrals, and timestamps. Goal updates emit canonical Goal
notifications but do not create another execution entity.

## Runtime Ownership

Canonical execution and persistence live under `src/main/agent/`. Retained
provider, filesystem, Node, Skill, import, and web capabilities live under
`src/main/agent/capabilities/`; they may contribute tools and configuration but
may not own Thread history or lifecycle state. There are no flat
`src/main/agent*.ts` implementations, forwarding wrappers, alternate runtimes,
or compatibility readers.

## Configuration Profiles And Roles

A named `ConfigurationProfile` supplies root Thread defaults. User definitions
load from `<userData>/agent/config.json`; project definitions load from
`<cwd>/.tenon/agent.json` and replace same-name user definitions. Both exact-key
JSON files may define `defaultProfile`, `profiles`, and `roles`. Invalid JSON,
unknown fields, invalid names, duplicate capability identities, and unsupported
reasoning effort values fail closed.

Root Thread creation resolves its selected Profile into one persisted
`EffectiveThreadConfiguration` snapshot. Later file edits do not rewrite that
root snapshot or completed Turns.

The built-in default Profile uses the `*` Skill ceiling so existing discovered
Skills remain available. A configured Skill list is an allow-list, while an
explicit empty list disables Skills for that Thread. A child Role may retain or
narrow the parent list but cannot widen an explicit parent ceiling.

The renderer may read or atomically replace only the execution selection of a
root user Thread: `modelProvider`, provider-qualified `model`, and
`reasoningEffort`. The host validates the provider/model pair and supported
effort before one SQLite update changes the configuration snapshot and Thread
catalog metadata. A root Thread with an active Turn rejects the change, so one
Turn cannot observe two configurations. Tools, Skills, Plugins, MCP servers,
developer instructions, and capability ceilings remain host-private. Feature
and child Threads have no renderer-editable configuration. A fork inherits the
source Thread's effective execution selection.

An `AgentRole` configures a child Thread. Built-in Roles are `default`, `worker`,
and `explorer`; user and project files may add or deliberately replace Roles.
Child spawn applies the current parent configuration, the selected Role,
explicit model/effort choices, and an optional tool ceiling. Tools, skills,
plugins, and MCP servers are each intersected with the parent capability
ceiling. Child resume reloads its stored Role and the parent's current snapshot,
while private metadata preserves only actual spawn-time model/effort overrides
and the explicit tool ceiling.

## Identity And Provenance

Every completed Turn carries immutable `TurnProvenance`; every completed Item
carries immutable `ItemProvenance`. Newly recorded facts point to their local
Thread, Turn, and Item identities.

Forking materializes inherited Turns and Items with new local IDs while
preserving their ultimate provenance. A fork of a fork does not create a new
evidence origin. This permits Memory and audit consumers to deduplicate evidence
without sharing mutable history objects.

Every document mutation dispatched by a model tool records
`AgentMutationCausation { threadId, turnId, itemId }` in Core transaction metadata
and the operation journal. File, command, MCP, and dynamic-tool Items retain the
equivalent audit edge in Thread history.

## Lifecycle

`ThreadService` is the only lifecycle coordinator. It serializes acceptance per
Thread, enforces one active Turn, and deduplicates renderer submissions by stable
client message ID.

Starting a Turn follows this order:

1. Resolve the Thread and reject an incompatible active state.
2. Resolve structured user content, derive the Thread's bounded initial preview
   when it is still empty, and allocate the Turn and initial user Item identities.
3. Commit extension admission snapshots under the relevant barriers.
4. Resolve main-owned environment, user view, Skill discovery, additional context,
   and explicitly referenced Node resources into Thread-owned payloads.
5. Persist one `turn/started` event containing every already-complete evidence Item
   followed by the user Item in canonical order.
6. Return acceptance before starting model side effects.
7. Execute the Turn and persist Item events as they occur.
8. Finish every remaining open Item, persist the terminal Turn, and set the
   Thread back to `idle` or `systemError`.

`/compact [instructions]` and `/clear` are reserved renderer commands handled before
Skill routing. They require an idle Thread and create completed feature-triggered Turns
containing only a canonical `contextCompaction` or `contextReset`; they do not launch a
model Turn. A command with no new eligible boundary returns the existing boundary as an
idempotent no-op. Both commands retain the visible and auditable history they stop
projecting implicitly.

Steering uses the same evidence admission path. Its evidence and user Item become
durable before the live executor is notified, so queued and immediate steering have
the same canonical history and provider projection.

`clientUserMessageId` is a Thread-scoped idempotency key for both initial and
steering admission. A retry that resolves to an existing canonical `userMessage`
returns the original Turn and Item acceptance before checking active-Turn state,
including after terminalization or process restart. A sidecar binding that no longer
resolves to that exact canonical Item is stale, is removed, and grants no acceptance.
The sidecar is a rebuildable index rather than authority: a missing or stale entry
causes a scan of reachable canonical Turns, and an exact matching user Item is
re-indexed before its original acceptance is returned.

`turn/started` is the atomic publication boundary for initial evidence plus user input;
`items/completed` provides the same boundary for later immediate Item groups such as
steering. One rollout event carries each complete ordered group; the persistent
projection applies the group in one SQLite transaction, ephemeral history applies it in
one state replacement, and the renderer merges it in one snapshot. A failed append
leaves the recorder uncommitted and admission cleanup reclaims newly published payloads. Renderer
listeners and extension notification observers run only after canonical persistence;
their failures are logged and cannot turn a committed admission into a reported failure.
`item/started` and `item/completed` remain the sole lifecycle for real streaming or
execution Items and are not a legacy compatibility path.

Once either admission event is durable, later status bookkeeping or live steering
delivery cannot reject that input. Such a failure aborts and fails the already-accepted
Turn. One serialized steering-delivery chain preserves admission order, and
terminalization closes steering under the Thread mutex before freezing the final Item
list.

`update_plan` is a Turn-local control tool, not a history fact. Its normalized
checklist is published as a transient `turn/plan/updated` notification for the
active Turn. It creates neither a `ThreadItem` nor model-history text, and a
terminal Turn never retains it. Recorded and transient notification types are
separate protocol subsets; rollout decoding rejects transient notification
types even if malformed storage contains one.

Initial preview selection is deterministic: first non-empty text, then an
attachment name, then a Node-reference note. Whitespace is normalized and the
result is bounded before it is stored. The write happens once for persistent and
ephemeral Threads; later Turns never rewrite an existing preview.

For an unnamed persistent root user Thread, the first terminal user Turn starts
one non-blocking automatic-name request through the current Thread model. The
request uses the lowest supported reasoning level, bounded input, at most 64
output tokens, and normalizes one plain-text name to at most 80 characters. It
does not delay `turn/completed`, enter rollout history, or count toward Goal
usage. Failure or cancellation leaves the deterministic preview in place.
Persistent internal name origin makes manual rename or clear authoritative over
an in-flight request and across restart. Rolling back the complete history
clears only an automatic name so the replacement first Turn can be named again.

Extension `turnStarted` hooks are part of the same launch boundary as executor
startup. A hook exception terminalizes the accepted Turn as failed, releases
the active-Turn lock, and cannot strand a Thread in `inProgress`.

Steering appends input only to the active Turn. Interrupt requires the exact
active Turn ID. Resume reopens a stored Thread, refreshes child Role
configuration, and lets extensions reconcile their own state; it does not create
a Turn.

When a Turn becomes idle, an active Goal may admit a continuation through the
same single-Turn coordinator. Usage is committed before continuation admission,
so reaching a token budget changes the Goal to `budgetLimited` and stops the
chain. A deferral records a lost admission race for one idle boundary; the next
real idle boundary clears it and retries the same Goal generation. Startup
resumes active Goals on non-archived idle Threads. `waitForIdle` follows the
whole continuation chain rather than returning after only its first Turn.

Archiving or deleting a Thread is a subtree operation over `parentThreadId`
lineage. `ThreadService` first fences the complete subtree against new Turn and
child admission, interrupts every active Turn and pending structured-input
request, and waits for every descendant to become idle. Archive then marks the
root and every descendant archived; unarchive restores only the explicitly
selected Thread and never revives descendants implicitly. Delete removes every
descendant Goal, history projection, rollout, catalog row, spawn edge, mailbox,
pending activity, and barrier state. Concurrent overlapping teardown requests
fail closed. Archived or stopping Threads cannot admit a Turn.

## History Replacement And Fork Semantics

Only the latest terminal user Turn can be edited. Edit calls
`thread/rollback { threadId, numTurns: 1 }`, then starts a replacement Turn with
fresh Turn and Item identities in the same Thread. Earlier and active Turns are
not editable. Assistant responses do not expose Retry or Regenerate.

Rollback appends a durable marker to the immutable rollout. The current history
projection, pagination, and model context omit the marker's exact terminal Turn
suffix, while audit reads retain every original Turn and Item fact. Extension
prepare hooks run before the marker; a prepare failure aborts already prepared
extensions in reverse order and leaves history unchanged. Once the marker is
durable it cannot be vetoed. Failed commit or abort hooks enter one host-scoped,
coalescing recovery queue and retry in the current process with bounded backoff;
startup replays committed markers before admitting new work.

`Continue in new chat` is the only visible fork operation. It copies terminal
history through the selected Turn into a new top-level root Thread.
Its default name uses the source name or preview plus the next numeric suffix
across the complete `forkedFromId` family. One trailing suffix is removed from a
fork-derived name before allocation, so `Title`, `Title (1)`, and `Title (2)`
remain siblings rather than forming nested suffix text. A root title such as
`Annual plan (2024)` remains intact. Explicit fork names remain authoritative.

A fork copies only terminal history within the boundary. It never calls document
undo, changes files, stops processes, reverses commands, compensates MCP calls,
or attempts to undo external effects. Any future world-state revert is a
separate explicit capability with preview, conflict detection, and its own audit
record.

Forked user Items retain `acceptedAt`. Context cursors are rewritten to the copied
Turn/Item identities. Every context payload and every dependency listed by the owning
Item's `contextRefs`, `resourceRefs`, and `outputRefs` is copied into the fork before
publication; failure deletes the staged fork. The copied Thread therefore remains
readable after its source is deleted. Content-addressed resource references do not
contain a Thread path and remain unchanged in the copied Items and payloads.

## Persistence

Persistent Agent Core data lives under `<userData>/agent/`:

```text
agent/
  state.sqlite
  thread_history.sqlite
  goals.sqlite
  rollouts/
    <thread-id>.jsonl
  payloads/
    <thread-id>/
      <content-hash>.<ext>
      context/
        <content-hash>.json
      resources/
        <content-hash>/
          <safe-display-name>
```

`state.sqlite` is the Thread catalog and configuration snapshot.
`thread_history.sqlite` is a rebuildable pagination projection. `goals.sqlite`
owns Goal state. Each persistent Thread owns one append-only rollout JSONL as
the history source of truth. Complete textual tool outputs, managed attachment
inputs, managed tool images, and semantic context payloads live in the Thread-owned
payload directory; canonical Items retain typed content-addressed references.
Context writes
canonicalize through the Core codec before hashing. Context and text reads/copies
verify digest and byte length, while text also selects storage by the referenced
MIME type. Managed input admission reserves quota before
writing, stages chunks under a non-canonical `.staging` directory, and publishes
only a complete digest-verified resource. Failed content admission immediately
removes prompt snapshots created by that attempt unless canonical history already
references them. Execution-time context publication writes the payload and its Item
under the Thread mutex; failed publication and Turn terminalization prune any context
payload not reachable from the canonical Item graph. A newly written tool image that
no terminal Item references is reclaimed at Turn finalization; startup reconciliation
handles crash leftovers. Every
resource operation requires each managed path component to be a physical directory;
symbolic-link substitution
fails closed, including during quota scans, startup cleanup, and garbage
collection. Successful writes cache file identity and digest in memory. A cold
read or any inode, size, ctime, or mtime change streams SHA-256 again before the
resource is returned, so same-length replacement cannot bypass integrity checks.
Canonical managed-resource paths stay private to the payload store. Consumers
that need a filesystem path receive an independent scratch observation: model
execution owns a Turn-scoped copy, while Preview/Open/Reveal share a stable
detached copy per attachment or resource identity, reclaimed by scratch TTL. Resource garbage
collection uses the physical key (content hash plus safe filename), independently
of logical MIME metadata.
Ephemeral Threads remain memory-only except for temporary payload files, which
follow the same Thread deletion lifecycle and are removed when the service
closes. Startup and rollback remove stale staging data plus managed resources,
context payloads, and complete text outputs absent from reconciled canonical
history. Forks copy only payloads referenced by inherited
Items into their own directory with a distinct inode, so provenance remains
shared while mutation and deletion remain Thread-local.
If fork preparation fails after a transient `thread/started` notification, the
renderer reloads the authoritative Thread catalog before surfacing the error, so
the rolled-back fork does not remain visible.

Startup reconciles catalog and history projections from rollouts. A Turn left
`inProgress` by host restart is completed as `interrupted`; every unfinished
streamed or executable Item first receives its terminal completion fact. Clean
replay then produces the same paginated Turns and Items as incremental
projection. There is one storage format and no alternate reader or dual-write
path.

## Transport

The renderer uses one request channel and one notification channel. Methods are
grouped by the concept they own:

- `thread/*`: list, read, start, resume, fork, rollback, name, archive, delete, paged
  Turn/Item reads, exact full-output reads, and exact context-evidence reads
- `turn/*`: start, steer, and interrupt
- `goal/*`: get, create, and update
- `userInput/respond`: resolve an active structured input request

All input and output crosses strict codecs. Unknown fields, invalid UUIDv7 IDs,
invalid state transitions, and impossible terminal facts fail closed. Thread
history mode is always paginated; renderer code does not negotiate another
shape.

`thread/context/read` authorizes the exact `(threadId, turnId, itemId, contextId)`
tuple and only returns the primary payload of that `contextEvidence` Item. A digest
alone cannot probe another Item or Thread, and nested dependencies are not exposed by
this audit method.

Recorded lifecycle notifications are the only notifications accepted by
rollout and history projection stores. `thread/name/updated`, provider-retry
state, and `turn/plan/updated` are transient renderer synchronization events;
they are never replayed from rollout history.

## Extension Boundary

`ExtensionRegistry` is the only Core extension boundary. Extensions may
contribute:

- durable admission snapshots before a Turn exists
- additional model context for a Thread
- terminal Items after execution
- lifecycle reconciliation hooks
- canonical tool contracts owned by the contributing extension

Host-wide and per-Thread admission barriers linearize configuration changes with
new root Turns. They do not interrupt an already active Turn; an extension that
needs exclusion must persist it explicitly.

Extensions do not add fields to Core entities or write Core stores directly.
They own their private state and communicate through typed extension contracts.
The host assembles extension and capability contracts into one executable
registry, validates provider-name uniqueness and runtime schemas, and fails
closed if an enabled extension contract has no runtime implementation.

Memory is the first durable extension using this boundary. Its immutable Turn
admission, terminal citation Items, history-rollback invalidation, and private
pipeline state are specified in [`agent-memory.md`](agent-memory.md); published
Memory remains ordinary document Nodes rather than a Core entity.

Automation is a feature consumer rather than a Core extension. It uses
host-only root-Thread and idle-Turn admission, then records ordinary canonical
Turns with immutable feature provenance. Schedule definitions and claims never
enter Core stores. See [`agent-automations.md`](agent-automations.md).

## Renderer Diagnostics

The Thread Details dialog is the canonical diagnostic surface. It renders the
same Thread, Turn, and Item DTOs used by the transcript and shows their canonical
IDs, status, source, parent/fork lineage, Item types, and Turn status. It does not
create a debug projection, execution ledger, or alternative view model.

## Trusted Document Transactions

Projection-neutral system receipts and deterministic protected tag definitions
use `DocumentSystemHost`. One trusted transaction may atomically commit document
commands plus a receipt. It resolves only after the workspace bytes containing
that commit are durably flushed, so a sidecar journal cannot finalize ahead of
the receipt. System-only commits persist without emitting a Node projection
update and are excluded from user undo.

Internal projection-change delivery retains the originating operation ID, while
the public renderer event remains the canonical projection event. This lets a
cross-store extension distinguish its own committed Node transaction from a
later user edit before its private journal finalizes.

Protected tag definitions have host-owned identity and lifecycle. Public
commands may apply or remove a protected tag from content, but cannot mutate its
definition. The command classifier extracts every owner, parent, target, and
nested batch ID and fails closed for unknown commands.
