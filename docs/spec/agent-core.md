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
status. `item/completed` never accepts an `inProgress` Item, and a terminal Turn
cannot contain one. Completed Items are immutable.

A `ThreadGoal` is attached one-to-one to a Thread and stored separately from
history. It carries objective, lifecycle status, optional token budget, token
usage, continuation deferrals, and timestamps. Goal updates emit canonical Goal
notifications but do not create another execution entity.

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
2. Allocate the Turn and initial user Item identities.
3. Commit extension admission snapshots under the relevant barriers.
4. Persist `turn/started` and the completed user Item.
5. Return acceptance before starting model side effects.
6. Execute the Turn and persist Item events as they occur.
7. Finish any remaining execution Items, persist the terminal Turn, and set the
   Thread back to `idle` or `systemError`.

Steering appends input only to the active Turn. Interrupt requires the exact
active Turn ID. Resume reopens a stored Thread and lets extensions reconcile
their own state; it does not create a Turn.

## Fork Semantics

Editing earlier input, retrying, and regenerating are history operations. They
fork at a selected Turn boundary and start new work in the fork.

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
```

`state.sqlite` is the Thread catalog and configuration snapshot.
`thread_history.sqlite` is a rebuildable pagination projection. `goals.sqlite`
owns Goal state. Each persistent Thread owns one append-only rollout JSONL as
the history source of truth. Ephemeral Threads remain memory-only and never
enter these stores.

Startup reconciles catalog and history projections from rollouts. There is one
storage format and no alternate reader or dual-write path.

## Transport

The renderer uses one request channel and one notification channel. Methods are
grouped by the concept they own:

- `thread/*`: list, read, start, resume, fork, name, archive, delete, and paged
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

Host-wide and per-Thread admission barriers linearize configuration changes with
new root Turns. They do not interrupt an already active Turn; an extension that
needs exclusion must persist it explicitly.

Extensions do not add fields to Core entities or write Core stores directly.
They own their private state and communicate through typed extension contracts.

## Trusted Document Transactions

Projection-neutral system receipts and deterministic protected tag definitions
use `DocumentSystemHost`. One trusted transaction may atomically commit document
commands plus a receipt. System-only commits persist without emitting a Node
projection update and are excluded from user undo.

Protected tag definitions have host-owned identity and lifecycle. Public
commands may apply or remove a protected tag from content, but cannot mutate its
definition. The command classifier extracts every owner, parent, target, and
nested batch ID and fails closed for unknown commands.
