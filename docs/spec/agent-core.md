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

- `userMessage`, `agentMessage`, `plan`, and `reasoning`
- `commandExecution`, `fileChange`, `mcpToolCall`, and `dynamicToolCall`
- `collabAgentToolCall` and `subAgentActivity`
- `webSearch`, `imageView`, and `contextCompaction`

Items with execution status start as `inProgress` and complete with a terminal
status. Every started Item, including streamed messages and reasoning without an
execution-status field, receives exactly one `item/completed` fact before its
Turn becomes terminal. `item/completed` never accepts an `inProgress` executable
Item. Completed Items and terminal Turns are immutable.

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
4. Persist `turn/started` and the completed user Item.
5. Return acceptance before starting model side effects.
6. Execute the Turn and persist Item events as they occur.
7. Finish every remaining open Item, persist the terminal Turn, and set the
   Thread back to `idle` or `systemError`.

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
```

`state.sqlite` is the Thread catalog and configuration snapshot.
`thread_history.sqlite` is a rebuildable pagination projection. `goals.sqlite`
owns Goal state. Each persistent Thread owns one append-only rollout JSONL as
the history source of truth. Large binary tool outputs live in the Thread-owned
payload directory and canonical Items retain file references. Ephemeral Threads
remain memory-only except for temporary payload files, which follow the same
Thread deletion lifecycle and are removed when the service closes.

Startup reconciles catalog and history projections from rollouts. A Turn left
`inProgress` by host restart is completed as `interrupted`; every unfinished
streamed or executable Item first receives its terminal completion fact. Clean
replay then produces the same paginated Turns and Items as incremental
projection. There is one storage format and no alternate reader or dual-write
path.

## Transport

The renderer uses one request channel and one notification channel. Methods are
grouped by the concept they own:

- `thread/*`: list, read, start, resume, fork, rollback, name, archive, delete, and paged
  Turn or Item reads
- `turn/*`: start, steer, and interrupt
- `goal/*`: get, create, and update
- `userInput/respond`: resolve an active structured input request

All input and output crosses strict codecs. Unknown fields, invalid UUIDv7 IDs,
invalid state transitions, and impossible terminal facts fail closed. Thread
history mode is always paginated; renderer code does not negotiate another
shape.

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

## Renderer Diagnostics

The Thread Details dialog is the canonical diagnostic surface. It renders the
same Thread, Turn, and Item DTOs used by the transcript and shows their canonical
IDs, status, source, parent/fork lineage, Item types, and Turn status. It does not
create a debug projection, execution ledger, or alternative view model.

## Trusted Document Transactions

Projection-neutral system receipts and deterministic protected tag definitions
use `DocumentSystemHost`. One trusted transaction may atomically commit document
commands plus a receipt. System-only commits persist without emitting a Node
projection update and are excluded from user undo.

Protected tag definitions have host-owned identity and lifecycle. Public
commands may apply or remove a protected tag from content, but cannot mutate its
definition. The command classifier extracts every owner, parent, target, and
nested batch ID and fails closed for unknown commands.
