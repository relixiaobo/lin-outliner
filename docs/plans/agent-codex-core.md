# Codex Agent Core

## Goal

Replace Tenon's current agent architecture with one TypeScript implementation of
the Codex Thread / Turn / ThreadItem model. The same canonical objects must cross
persistence, main-process runtime, preload/IPC, renderer state, debug surfaces,
and user-visible terminology without compatibility DTOs or presentation aliases.
This is a clean replacement against empty agent data: old storage is deleted
outside the product, and the new runtime never detects, imports, migrates, or
adapts any former format.

This plan is a set of two ordered delivery units required by the repository's
shared-interface-first rule:

1. A human-led interface-only PR lands `src/core/agent/`, the coordinated shared
   exports, codecs, tool contracts, provenance contracts, the generic
   projection-neutral document system-receipt contract, the generic protected
   system-tag-definition contract, and protocol tests. It does not add a second
   agent runtime, adapter, data reader, or migration path. The old runtime
   remains the only executable agent consumer during this short interface
   window.
2. One complete replacement PR consumes that interface across persistence,
   runtime, transport, renderer, and deletion. It is complete only when the old
   Conversation / Channel / Run / Issue / AgentSession / Activity / Dream model
   has no runtime, storage, IPC, test, spec, or UI presence.

The interface PR is the repository-mandated infrastructure claim, not a partial
product rollout. The replacement PR follows immediately after it; temporary
source-level coexistence is never exposed as runtime compatibility, dual writes,
or old-data support.

This plan is the foundation for `agent-codex-memory` and
`agent-codex-automations`. Those plans may begin only after the replacement PR
lands; after that they are independent consumers of Core provenance.

The reference baseline is OpenAI Codex commit
`841e47b8fb113a201b68e0f1f5790ba22836a241`, especially:

- `codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/turn.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- `codex-rs/ext/extension-api/src/contributors/`
- `codex-rs/ext/goal/`
- `codex-rs/core/src/tools/spec_plan.rs`
- `codex-rs/core/src/tools/handlers/multi_agents_spec.rs`
- `codex-rs/core/src/tools/handlers/request_user_input_spec.rs`
- `codex-rs/core/src/tools/handlers/plan_spec.rs`
- `codex-rs/state/src/runtime.rs`
- `codex-rs/state/migrations/0001_threads.sql`
- `codex-rs/state/migrations/0013_threads_agent_nickname.sql`
- `codex-rs/state/migrations/0021_thread_spawn_edges.sql`
- `codex-rs/state/thread_history_migrations/0001_thread_history.sql`
- `codex-rs/state/thread_history_migrations/0002_thread_items_item_type.sql`
- `codex-rs/state/goals_migrations/0001_thread_goals.sql`
- `codex-rs/state/goals_migrations/0002_thread_goal_continuation_deferrals.sql`
- `codex-rs/rollout/src/recorder.rs`

`cc-2.1` was also inspected as a contrast. Its session JSONL, AutoDream,
team-memory, local cron, and remote-trigger paths are useful evidence of what not
to combine: they are separate feature spines rather than one shared execution
model. This plan deliberately follows Codex instead of importing those concepts.

## Non-goals

- Preserve or migrate any existing agent data. Development userData is wiped
  before validation; production compatibility code, old readers, aliases, and
  dual writes are forbidden.
- Implement Memory or Automations. The old Dream runtime and recurring-Issue
  paths are removed here; their Codex replacements arrive as complete later
  features. The Memory feature intentionally reuses Tenon's `#d-*` daily-timeline
  vocabulary through a new Codex pipeline, not through compatibility code.
- Copy Codex's Rust implementation or app-server wire format byte for byte.
  Tenon remains TypeScript/Electron and adopts the concepts and behavioral
  contracts that fit its host boundary.
- Rebuild provider adapters, node tools, skills, attachments, model selection, or
  the ratified Full Access audit/explicit-block boundary when they can be retained
  as capabilities behind the new Turn runtime. They must stop exposing old
  execution entities.
- Introduce a durable Agent membership/execution identity, Task, Session,
  Process, or Activity entity. A child Thread may carry Codex-style
  `agentRole`/`agentNickname`; role definitions and model/tool/skill choices are
  configuration, not another history graph. The assistant brand/avatar remains
  presentation only.

## Design

### 1. One canonical vocabulary

The following mapping is destructive and exhaustive:

| Removed Tenon concept | Canonical replacement |
|---|---|
| Conversation, Channel, DM | `Thread` |
| Run, conversational run, background run | `Turn` |
| Message, tool trace, process row, render event | `ThreadItem` variant |
| Issue | `ThreadGoal` attached one-to-one to a Thread |
| AgentSession | Child `Thread` plus its current `Turn` |
| Issue Activity | Derived chronology of `ThreadItem`s and goal updates |
| Delegated run or sub-run | Child `Thread` with `parentThreadId` |
| Message branch | Forked `Thread` with `forkedFromId` |
| Latest user-message edit | Same-Thread `thread/rollback` followed by a new `Turn` |
| RecurringIssue | Removed; a later `Automation` creates or resumes Threads |
| Dream runtime, schedule, and extraction path | Removed; a later Memory extension publishes Codex Memory as canonical `#d-*` Nodes on the daily timeline |

`sessionId` is only the grouping key shared by a root Thread and its descendant
Thread tree. It is not an AgentSession object. `parentThreadId` means subagent
lineage; `forkedFromId` means history fork lineage. They are not interchangeable.

The word "run" remains valid only in ordinary programming prose and, after the
Automation plan, in the scoped term `AutomationRun`. It is not an agent execution
entity or a transcript concept.

### 2. Source layout and ownership

Replace the flat, cross-coupled `agent*.ts` layout with explicit ownership:

```text
src/core/agent/
  protocol.ts          Thread, Turn, ThreadItem, request/response, notifications
  codec.ts             runtime validation and serialization for that protocol
  tools.ts             canonical tool identities, schemas, audit/block metadata
  goal.ts              ThreadGoal and its tool contracts
  extensions.ts        typed lifecycle and contribution interfaces
  configuration.ts     thread/turn execution configuration

src/main/agent/
  ThreadService.ts
  runtime/
    ThreadRuntime.ts
    TurnRuntime.ts
    ItemRecorder.ts
  persistence/
    RolloutStore.ts
    ThreadMetadataStore.ts
    ThreadHistoryProjectionStore.ts
  extensions/
    ExtensionRegistry.ts
    goal/
      GoalExtension.ts
      GoalStore.ts
  tools/               retained provider-neutral tools, reorganized by domain

src/renderer/agent/
  store/
    threadStore.ts
    threadSelectors.ts
  components/
    ThreadDock.tsx
    ThreadList.tsx
    ThreadView.tsx
    ThreadGoalView.tsx
    items/
```

The exact private helper split may change during implementation, but ownership
may not: core defines the contract, main owns execution and persistence, preload
only transports that contract, and renderer consumes it. Domain utilities such
as OAuth, file ingestion, and node tools move under `src/main/agent/tools/` or a
similarly explicit capability directory; they do not define history objects.

`src/core/types.ts` and `src/core/commands.ts` lose the existing agent domain
types and commands. They may reference the new protocol entry points, but may not
redeclare them. This is a coordinated protocol change and claims those shared
files for the duration of the PR.

`protocol.ts` plus `codec.ts` is the only DTO definition/validation source. Main,
preload, renderer, fixtures, and debug views import it; they may define local UI
state but may not redeclare `Thread`, `Turn`, `ThreadItem`, or `ThreadGoal`.
Protocol round-trip and exhaustive-variant tests fail on an unhandled item type.

#### Projection-neutral document system receipts

The interface-only PR also defines one generic document primitive needed by
crash-safe host features such as Memory. `DocumentSystemReceipt` is a small,
opaque commit marker:

```ts
type DocumentSystemReceipt = {
  namespace: string;
  scopeId: string;
  operationId: string;
  generation: number;
  digest: string; // lowercase SHA-256 of the canonical prepared record
};
```

Core persists the latest receipt per `(namespace, scopeId)` in a dedicated Loro
map outside the Node map. It is deliberately not a `Node` field and is excluded
from `NodeFieldKey`, `NodeProjection`, `DocumentProjection`, projection deltas,
renderer IPC, Node tools, search/backlinks, ordinary outline export, and model
context. Only trusted main-process services can read it.

The shared command contract includes a host-only
`put_document_system_receipt` mutation. It is not part of the renderer or model
tool catalogs and cannot be dispatched through public document-command IPC.
Inside one `DocumentService.transaction`, it commits in the same Loro change as
the accompanying Node commands; a transaction with Node changes emits only those
Node projection deltas, while a receipt-only transaction emits no renderer
projection update. System receipts and their host transactions are excluded from
user undo/redo. Canonical encoding, last-writer behavior, atomic Node-plus-receipt
commit, reload, receipt-only projection silence, and public-surface exclusion are
contract-tested before a consumer may depend on the primitive.

The receipt contains no feature payload. A consumer stores its full prepared
operation in its own control database and places only a digest over that record
in the document receipt. The Core replacement implements this already-settled
contract; Memory later consumes it without modifying `src/core/types.ts` or
`src/core/commands.ts` again.

#### Protected system tag definitions

The interface-only PR also defines the generic document primitive used when a
trusted host feature owns a stable, visible tag identity:

```ts
type DocumentSystemTagDefinition = {
  namespace: string;
  tagId: string;
  name: string;
};
```

The host-only `ensure_document_system_tag_definition` mutation atomically
registers the claim and ensures that exact `tagId` is an active `tagDef` under
`SCHEMA_ID` with its canonical name. A missing definition is created with the
caller-supplied ID; a definition moved to Trash is restored with the same ID,
never replaced by a random `create_tag` identity. A conflicting namespace,
name, type, or identity claim fails the whole transaction instead of merging or
silently adopting a user tag.

The ownership claim lives in a projection-neutral document system map, while
the ensured tag definition remains an ordinary visible tag definition. Public
renderer commands and model Node tools cannot rename, move, trash, delete,
merge, retype, unlock, or replace a registered definition. Users and ordinary
Node tools may still apply or remove the tag from content Nodes. There is no
public unregister command; a feature-specific reset cannot delete its reserved
definitions. The public mutation gate exhaustively classifies every
`DocumentCommand`, including owner, parent, target, and nested batch IDs; an
unknown command fails closed. The ensure mutation is absent from renderer IPC
and the model tool catalog, is excluded from user undo/redo, and can share one
`DocumentService.transaction` with Node commands and a system receipt.

Contract tests cover caller-supplied identity, idempotent ensure, same-ID restore
from Trash, conflict rejection, definition locking, ordinary tag application
and removal, reload, projection behavior, and public-surface exclusion. Memory
later declares its fixed tag IDs through this primitive and does not reopen the
shared document command contract.

### 3. Protocol model

`Thread` follows the Codex contract: stable UUIDv7 `id`, `sessionId`, optional
`parentThreadId` and `forkedFromId`, optional `agentNickname` and `agentRole`,
`name`, `preview`, `ephemeral`, `source`, `threadSource`, `modelProvider`, `cwd`,
timestamps, status, and optionally loaded Turns. Thread status is `notLoaded`,
`idle`, `active`, or `systemError`; the active flag `waitingOnUserInput` expresses
the only Tenon-owned waiting interaction rather than inventing a parallel status.
`source` records the host/session origin while `threadSource` classifies the
workload; neither is a UI-only tag.

`ThreadSource` has Codex's exact string representation: the reserved values are
`user`, `subagent`, and `memory_consolidation`; every other non-empty string is
an app-owned feature label. For example, the Automation feature persists
`automation`, not `feature:automation`. The runtime codec must preserve this
reserved-value-versus-feature-label distinction. The source drives eligibility
and filtering; it is not a UI-only tag.

Tenon implements only Codex's `paginated` Thread history mode. Every Thread DTO
reports `historyMode: paginated`; `thread/turns/list` and `thread/items/list`
with opaque cursors are the only history read contract. There is no `legacy`
mode, eager full-history fallback, old-history negotiation, or compatibility
reader in protocol, persistence, or renderer code.

`Turn` has a stable UUIDv7 `id`, ordered items, `itemsView`, immutable
`provenance`, status `inProgress | completed | interrupted | failed`, optional
error, and timing.
Only one Turn may be active in a Thread. Starting, steering, interrupting, and
resuming all require both the Thread identity and the relevant Turn precondition
where applicable. Steering can append input only to the active Turn. Completed
Turns and completed ThreadItems are immutable recorded facts: no operation
patches a completed record in place or reuses its identity. The append-only
rollout is the audit history. The current Thread history and model context are a
replay projection of that audit history after applying any later rollback
markers.

Tenon implements Codex's `thread/rollback { threadId, numTurns }` semantics for
persistent interactive root Threads. The operation runs under the per-Thread
admission barrier, requires the Thread to be idle, requires every targeted Turn
to be terminal, rejects zero or more Turns than currently exist, appends one
durable marker containing the exact omitted Turn IDs and rollout boundary, and
returns the updated Thread projection. A successful marker survives a crash
before any replacement Turn starts. Replay, pagination, model-history assembly,
and projection rebuild all omit those Turns while retaining their original
events for audit. The installed Codex desktop client uses `numTurns=1` to edit
the latest user Turn in the current projection; Tenon's renderer exposes only
that case and never offers Edit on an earlier Turn or while a Turn is active. Although upstream
app-server marks the operation deprecated because of its legacy-history
complexity, Tenon has one paginated history mode and adopts the current desktop
behavior without its compatibility paths.

After rollback, the replacement is an ordinary new user Turn on the same
`threadId`, with fresh Turn and Item identities. The removed identities remain
reserved and auditable. The user-facing response surface has no Retry or
Regenerate history action; a failed latest Turn can be revised through Edit.
`Continue in new chat` is the only transcript action that calls `thread/fork`,
creates a new top-level Thread, and records `forkedFromId`.

Rollback and fork change only agent history and model context. Neither reverts
document commands, Memory Node edits, file changes, shell effects, processes,
MCP calls, Goal state, or external actions performed by omitted Turns. Those
effects retain their original `threadId`/`turnId`/`itemId` causation and resolve
through the audit rollout even when their Turn is absent from the current
projection. Token usage, Goal accounting, and elapsed execution time remain
cumulative and are never refunded. Payload references remain retained under the
Thread's normal audit/GC lifetime. Any future world-state revert is a separate
explicit command with its own preview, conflict detection, and audit record; it
is not a Thread rollback and cannot promise to reverse unknown or external
effects.

`TurnProvenance` is written by `ThreadService` before the Turn starts and is
persisted in the rollout and history projection:

```ts
type TurnProvenance = {
  originThreadId: string;
  originTurnId: string;
  trigger:
    | { kind: 'user' }
    | { kind: 'subagent'; parentThreadId: string; parentItemId: string }
    | { kind: 'feature'; feature: string; ref?: string };
};
```

For a newly started Turn, the origin IDs equal its own IDs. The public renderer
entry may create only `trigger.kind=user`; child execution and installed host
features use privileged `ThreadService` entries. Automation uses
`{ kind: feature, feature: "automation", ref: AutomationRun.id }`. Goal
continuations and Memory consolidation use their own feature labels. Prompt
content, untrusted `additionalContext`, plugins, and model output cannot author or
rewrite this provenance.

Turn start and steer accept Codex's optional `clientUserMessageId`. Within a
Thread, repeating the same client ID returns the existing accepted Item/Turn
binding instead of appending duplicate input. Host dispatchers use this for
crash-safe retries; ordinary renderer submissions generate a fresh ID.

`ThreadItem` is one discriminated union used in storage, transport, and UI. It
includes the Codex item families needed by Tenon:

- `userMessage`, `agentMessage`, `plan`, and `reasoning`
- `commandExecution` and `fileChange`
- `mcpToolCall` and `dynamicToolCall`
- `collabAgentToolCall` and `subAgentActivity`
- `webSearch` and `imageView`
- `contextCompaction`

Tenon node tools use `dynamicToolCall`; they do not get a second event taxonomy.
Attachments are content inside `userMessage`. Provider streaming fragments are
transport deltas, not additional persisted entity types.

Every completed ThreadItem also has immutable `ItemProvenance` containing
`originThreadId`, `originTurnId`, and `originItemId`. A newly recorded Item points
to itself. When a fork materializes inherited history, it assigns local IDs for
the copied records but preserves their ultimate origin IDs and the original
Turn trigger; a fork of a fork does not create another origin. The first newly
submitted Item after the fork boundary is locally originated. Rollback copies or
rewrites no provenance: the omitted facts keep their IDs in the audit rollout,
and replacement facts receive new local origins in the same Thread. This gives
Memory and audit consumers one stable evidence identity without making recorded
history mutable or coupling transcript rollback to world-state rollback.

The core protocol defines Codex's optional `MemoryCitation` on `agentMessage`
even before the Memory extension is installed. Tenon's Node-backed citation
entry contains `nodeId` and `note`, plus the supporting `threadIds`; artifact
paths and line ranges are intentionally absent because the canonical Memory
surface is the Outliner. The Memory plan consumes this field without reopening
the shared ThreadItem union.

Turn start and steer requests support Codex `additionalContext` entries keyed by
source, with `{ value, kind: untrusted | application }`. Renderer-authored input
may create only `untrusted` entries; host services and installed extensions may
create `application` entries. The entries contribute model context through the
Turn runtime but do not become a renderer-defined message or a new history
entity.

`request_user_input` uses control-plane request/response messages associated with
the relevant dynamic-tool item. They are not new persisted ThreadItem variants.
Its waiting state is reflected by `waitingOnUserInput`, and the completed item
remains the transcript fact.

Every lifecycle notification carries `threadId`, `turnId`, and, for item events,
`itemId`. The renderer receives `thread/started`, `thread/status/changed`,
`turn/started`, `item/started`, typed item deltas, `item/completed`, and
`turn/completed`. A completed item is authoritative; delta concatenation is never
the final stored value and no later notification patches it. For executable
Items, `item/started` requires `inProgress`, `item/completed` requires a terminal
status, and a terminal Turn cannot contain an `inProgress` Item.

Every mutation dispatched by a Turn also carries the same
`threadId`/`turnId`/`itemId` causation into its owning subsystem. Document
commands record it in transaction metadata, file mutations remain represented
by `fileChange` Items, and command/MCP/dynamic-tool Items retain the audit edge
for effects that cannot be reversed. This provenance supports inspection and a
future explicit undo surface without coupling world-state rollback to history
forking or transcript rollback. Audit lookup reads the append-only rollout, not
only the current Thread projection, so a rolled-back source identity never
becomes dangling.

#### Full Access host boundary

Tenon adopts Codex's Thread/Turn/Item concepts but deliberately does not adopt
its approval policy, sandbox policy, permission profile, or access-acquisition
protocol. The ratified Full Access boundary remains authoritative: a user request
or saved Automation definition authorizes the requested work under the current OS
account, and Tenon adds no risk confirmation or pause/resume authorization flow.

Every model-tool call follows one pipeline: the effective tool catalog determines
whether the tool exists, action descriptors are derived for audit and exact block
matching, current explicit user blocks may make it unavailable, the tool
executes, and the result plus capability audit is recorded. A retained file or
process tool has host-account filesystem/process authority. Native TCC,
administrator prompts, Keychain, CLI login, provider authentication, and service
errors remain owned by their source and are returned normally.

There is no `waitingOnApproval`, approval callback, sandbox mode, filesystem root
grant, permission selector, permission profile, managed approval fallback, or
renderer authorization card in protocol, storage, runtime, settings, Automation,
or UI. `request_user_input` gathers missing product input only and can never be
used as authorization. Agent Roles and isolated skills may narrow whole tool
names before a Turn starts; a tool that remains has the same Full Access
authority. The current `agent-tool-permissions.md` behavior is carried forward
and rewritten only for Thread/Turn terminology.

#### Configuration profiles and agent roles

Codex configuration profiles and agent roles are separate configuration layers,
not persisted Agent identities. A named `ConfigurationProfile` supplies defaults
for a root Thread: instructions, model, reasoning effort, tools, skills, plugins,
and MCP servers. Selecting a profile resolves an effective
Thread configuration snapshot; changing the template later does not rewrite
completed Turns or create a different conversational participant.

An `AgentRole` is selected only when spawning child work. Tenon provides the
Codex roles `default`, `worker`, and `explorer` and loads user/project roles
through the same configuration machinery. A role has a stable name,
description, developer instructions, optional nickname candidates, and optional
execution overrides. Child configuration is resolved from the parent's current
effective configuration, explicit spawn-time model/effort choices, the selected
role layer, and the parent's effective capability ceiling. A role may narrow but
never add a tool, skill, plugin, or MCP server that the parent did not enable.
Current explicit user blocks are evaluated again at every child-tool dispatch
rather than copied into role configuration.

The former editable built-in Agent profile and `AgentRunProfileId` family are
deleted. Research and verification behavior become Agent Roles; browser, coding,
or writing specialization is expressed through roles and skills; Dream has no
role because Memory replaces it. Internally and in the UI, `Profile` always
means a root configuration profile, `Role` means child execution configuration,
and `Subagent` means the child Thread itself.

#### Canonical model-tool surface

Model-callable tools and host IPC methods are different protocol surfaces. A
canonical model-tool identity is an optional namespace plus a function name;
provider adapters may encode that identity for transports that require flat
function names, but source modules, audit/block rules, ThreadItems, debug views,
and tests use the canonical identity. Preload methods such as `threadStart` and
`turnInterrupt` are never registered as model tools. The flat provider encoding
uses `namespace__name`; `__` is therefore reserved and rejected inside either
identity component, and registry assembly verifies that canonical and encoded
names are unique before exposing tools to a provider.

Core reserves the fixed `collaboration` namespace and implements Codex's v2
subagent suite exactly:

| Canonical tool | Contract |
|---|---|
| `collaboration.spawn_agent` | Create one child Thread, resolve its Agent Role and effective configuration, and start its first Turn. Return the child task path, Thread identity, and nickname when present. |
| `collaboration.send_message` | Queue a message for an existing child without starting a new Turn. |
| `collaboration.followup_task` | Start a new Turn when the child is idle; while it is active, deliver the task at a safe message boundary. |
| `collaboration.wait_agent` | Wait for mailbox activity, child completion notifications, steered root input, or a bounded timeout; it does not return a second transcript copy. |
| `collaboration.list_agents` | Query the live child-Thread tree and its derived execution statuses, optionally below a task-path prefix. |
| `collaboration.interrupt_agent` | Interrupt the child's current Turn while retaining the child Thread for later messages or follow-up work. |

The word `agent` in this tool namespace denotes the operational Subagent role;
the returned and targeted durable object is still a child Thread. Task paths are
addressing keys inside one root Thread tree, not persisted Task entities.
`send_input`, `resume_agent`, `close_agent`, `assign_task`, and any unnamespaced
aliases are not implemented. The namespace is fixed rather than exposed as a
profile or provider preference, so audit/block rules and recorded
`collabAgentToolCall` items cannot drift by configuration.

Core also provides two plain control tools:

- `request_user_input` is root-Thread-only and accepts one to three short
  questions. Each question has a stable snake-case ID, a short header, one
  sentence of prompt text, and two or three mutually exclusive options with a
  label and trade-off description. The host always supplies an `Other` response.
  Optional `autoResolutionMs` is clamped to 60,000-240,000 ms and is present only
  when the request is non-blocking and the Turn may continue with host judgment
  after timeout. Without it, the Turn waits until answer or cancellation.
- `update_plan` updates a Turn-local checklist and records the resulting `plan`
  ThreadItem. A plan is execution presentation, not a durable Goal, Task, Issue,
  or second scheduler.

`request_user_input` has no multi-select questionnaire mode, standalone free-text
mode, required/optional flags, custom submit label, Node/file references,
attachments, or `discussed` outcome. A detailed response, attachment, or Outliner
reference arrives through the normal composer as the next `userMessage`.
Subagents cannot call this tool; they use `collaboration.send_message` to surface
a decision to the root. Requests and answers are control-plane messages tied to
the tool call and Turn, set `waitingOnUserInput`, and do not create a parallel
`user_question.*` event store or ThreadItem family.

The Goal extension contributes the plain `get_goal`, `create_goal`, and
`update_goal` tools. The later Automation extension contributes
`codex_app.automation_update`; the Memory extension contributes no model tools
or parallel content backend. Foreground Threads use the existing Node tools,
while Memory consolidation scopes those tools to the selected canonical tagged
Memory graph inside Daily Notes rather than to a nonexistent Memory root.

Provider-neutral capability tools survive with their names and behavior moved
behind the new Turn runtime:

- Outliner: `node_search`, `node_read`, `node_create`, `node_edit`,
  `node_delete`, and `outline_undo_stack`
- workspace: `file_read`, `file_glob`, `file_grep`, `file_edit`, `file_write`,
  `file_delete`, `bash`, and `bash_stop`
- retrieval and artifacts: `web_search`, `web_fetch`, `generate_image`, and
  `data_import`
- configuration-provided `skill`, MCP, plugin, and dynamic tools

The destructive tool migration is exhaustive:

| Removed tool or internal entry | Canonical disposition |
|---|---|
| `issue_search` | No model-tool replacement; cross-Thread Goal lists are host queries and renderer views. |
| `issue_read` | `get_goal` for the current Thread; Thread history remains paginated host data. |
| `issue_create` | `create_goal`. |
| `issue_update` | `update_goal` for Goal state and, after the Automation feature lands, `codex_app.automation_update` for schedules. |
| `agent_session_start` | `collaboration.spawn_agent` for child work or canonical Thread/Turn host operations for foreground execution. |
| `agent_session_read` | `collaboration.list_agents` / `collaboration.wait_agent` for live child work and paginated Thread host reads for history. |
| `agent_session_send_message` | `collaboration.send_message` or `collaboration.followup_task`. |
| `agent_session_stop` | `collaboration.interrupt_agent`. |
| `past_chats` | No transcript-search model tool; the Memory extension publishes recall into Nodes, while explicit history inspection is a host/UI operation. |
| `ask_user_question` | `request_user_input`; all old questionnaire DTOs, events, projections, renderer adapters, and aliases are deleted. |
| `internal_delegation` and the fork pseudo-agent | The `collaboration` suite over child Threads. |

Action-kind audit descriptors, explicit block matching, and profile allow/deny
lists are rebuilt against this catalog. They control availability and audit, not
filesystem/process authority. No old tool name is accepted as an alias, persisted
as current audit data, or shown in current UI/specs after the replacement.

### 4. Rollout source of truth and rebuildable projections

Each persistent Thread owns an append-only rollout JSONL under the new agent data
root. The rollout is the canonical audit history. It records lifecycle events,
completed item values, and rollback markers in replay order; writes use one
sequenced recorder and flush before terminal notifications or rollback responses
are published. The canonical current Thread history is the deterministic replay
projection after rollback markers are applied, not a rewritten rollout prefix.
Every committed change to that projection advances a non-negative, monotonic
projection version. Core exposes an immutable history snapshot paired with that
version to internal consumers; reading it does not acquire the admission
coordinator.

Match Codex's current ownership split instead of creating one universal
database:

| Store | Owner | Contents | Recovery contract |
|---|---|---|---|
| Thread rollout JSONL | Core | canonical Turn/Item audit history and rollback markers | append-only source |
| `state.sqlite` | Core | Thread catalog, mutable metadata, spawn edges | authoritative catalog state |
| `thread_history.sqlite` | Core | `thread_turns`, `thread_items`, projection offsets | disposable and rebuilt from rollouts |
| `goals.sqlite` | Goal extension | current ThreadGoal, accounting, continuation deferrals | private extension state |

This follows Codex's current separate `state_5.sqlite`,
`thread_history_1.sqlite`, and `goals_1.sqlite` direction. The core state schema
does not contain Goal or future Memory/Automation tables.

Each store initializes only its current schema against empty agent userData.
There is no schema upgrade path, imported old data, compatibility table, or
dual-read period in this pre-release replacement.

The history projection stores rollout ordinals, Turn status/timing/errors,
completed item JSON/type, rollback visibility, and byte-offset/ordinal
watermarks. Deleting `thread_history.sqlite` and replaying rollouts must
reproduce identical current Thread/Turn/Item pages while audit lookup still
resolves omitted identities from the rollout. Tests compare normal incremental
projection with a from-zero rebuild, including multiple rollback markers and a
crash after rollback but before replacement Turn admission.

`goals.sqlite` is authoritative for current Goal state. Goal updates also emit
typed `thread/goal/updated` or `thread/goal/cleared` notifications and rollout
receipts so history explains what happened, but those receipts are not a second
mutable Goal store.

Ephemeral Threads never materialize a rollout or query rows. Payload files may
remain content-addressed implementation details, but references to them live in
ThreadItems and cannot become a fourth history ledger.

There is no old-format detection or reader in product code. Validation begins
with empty clone-specific userData, and old development agent directories are
deleted outside the runtime before launch.

### 5. Runtime and extension lifecycle

`ThreadService` is the host facade over Thread runtimes. A Thread runtime owns its
sticky configuration and at most one active Turn; a Turn runtime owns model
streaming, tool execution, user-input waits, cancellation, and ordered item
recording. `tryStartTurnIfIdle` is the only internal entry that lets extensions
continue work without racing user input.

A typed `ExtensionRegistry` provides only real lifecycle seams:

- Thread start, resume, idle, and stop
- prepared, aborted, and committed Thread-history rollback with the exact
  omitted Turn IDs and source-projection versions
- Turn admission, start, stop, abort, and error
- Thread context contribution
- tool contribution and tool lifecycle
- ordered Turn-item contribution

Turn admission is a synchronous host-only seam under ThreadService's admission
coordinator. Its per-Thread barrier serializes one Thread's configuration and
Turn acceptance; its host-wide root-Turn barrier blocks every new root Thread
and Turn acceptance while a global extension setting or Reset linearizes. The
host-wide barrier does not interrupt already active Turns, so its consumer must
persist any feature-specific active-Turn exclusions it needs.

After ThreadService allocates the Turn identity but before it persists the first
Item, returns acceptance, or starts any side effect, each registered admission
contributor may durably snapshot private extension state keyed by that `turnId`.
A failed contribution rejects the Turn before it exists; startup reconciliation
removes orphan snapshots whose Turns never became durable. Thread or global
configuration changes that affect admission use the matching barrier, so an
extension can bind a Turn to the exact configuration state at acceptance without
adding an extension-specific field to `Turn`, `TurnProvenance`, or `ThreadItem`.

Host-session-, Thread-, and Turn-scoped typed stores hold ephemeral extension
state. "Host session" here means the lifetime of the in-memory extension host,
not a persisted agent entity or a user-visible Session. Extensions do not mutate
renderer projections or write rollout JSON directly; they call the host API,
which records canonical protocol events.

Rollback acquires the same per-Thread coordinator as Turn admission and assigns
a unique `rollbackId`, the exact omitted Turn IDs, and the before/after source-
projection versions. Before appending the marker, the host calls each registered
`prepareHistoryRollback` hook in deterministic order. A derived-state extension
uses that hook to durably invalidate publications based on the before-version;
it does not mutate public product state. If any prepare fails before the marker
is durable, Core appends no marker, invokes `abortHistoryRollback` for prepared
participants in reverse prepare order, and leaves the current projection
unchanged.

After every prepare succeeds, Core durably appends the rollback marker and
updates the current projection. The audit fact is then committed and no
extension can veto or rewrite it. Core calls `commitHistoryRollback`; failures
there do not turn the successful rollback into an error, because prepared state
and the rollout marker provide the recovery record. Before publishing the
response, Core attempts every commit hook and enqueues each failure in one host-
scoped terminal-hook recovery loop keyed by `extensionId + rollbackId`; failed
abort hooks use the same loop with an abort target. Duplicate failures coalesce
and only one call per key may run at once. The loop retries immediately, then
uses jittered `250 ms`, `1 s`, `5 s`, and capped `30 s` delays until the hook
succeeds or orderly host shutdown begins. It uses one scheduler rather than a
timer per rollback and records bounded diagnostics without changing the
successful rollback response.

A prepare hook that governs derived context must make its invalidation visible
to later Turn admission before returning; that prepared invalidation remains
authoritative while commit retries. The replacement Turn can therefore start
immediately after the rollback response without waiting for asynchronous
derived-state cleanup, but it cannot receive context invalidated by the
rollback. Startup reconciles a prepared rollback against the append-only rollout
before accepting a Turn or starting extension workers: a matching marker commits
the invalidation and wakes reconciliation, while no marker aborts it. The queue
itself is ephemeral because the rollout marker and prepared extension state are
the durable recovery record. Repeating prepare, abort, or commit for one
`rollbackId` is idempotent.

An extension publication prepared from Thread evidence must reject a source
with a pending or committed invalidation and compare its source-projection
version immediately before commit. Publication and rollback therefore have one
order: a publication already holding its extension write gate commits before
rollback prepares, or rollback prepares first and the stale publication aborts.
There is no interval in which a publication based on the before-version can
commit after the rollback marker. The current source-projection version is an
atomically published read snapshot; extension code never acquires the per-Thread
coordinator while holding an extension write gate. The fixed lock order is
per-Thread coordinator before extension gate.

The `ThreadGoal` extension is the first required consumer and proves the seam is
real. `ThreadGoal` is keyed one-to-one by `threadId` and contains objective,
status, optional token budget, tokens used, time used, and timestamps. Its
statuses are exactly `active`, `paused`, `blocked`, `usageLimited`,
`budgetLimited`, and `complete`. It has no Issue criteria, scope, relation,
assignee, due-date, verification, or Activity fields; richer intent belongs in
the objective and Thread Items.

Its `get_goal`, `create_goal`, and `update_goal` tools follow the catalog above.
Agent updates may mark an existing goal only `complete` or `blocked`; pause,
resume, usage-limit, and budget-limit transitions stay host/user controlled. On
Thread idle, an active goal may enqueue a continuation through
`tryStartTurnIfIdle`. Token/time accounting and stop conditions are extension
state backed by `goals.sqlite`, not Turn subtypes. A private goal generation ID
prevents stale continuations after replacement, and a private deferral row
prevents repeated idle callbacks from spinning while continuation is temporarily
inadmissible. Transcript rollback never decrements token/time usage, rewinds Goal
status, or reopens a completed Goal; those are durable execution and extension
facts with their own explicit mutation surfaces.

Child work always starts a child Thread. It shares the root `sessionId`, stores
`parentThreadId`, may store `agentRole`/`agentNickname`, receives a deliberately
constructed context, and records its own Turns and Items. The core catalog also
stores the spawn edge for direct-child/descendant queries. Parent/child
coordination is represented through
`collabAgentToolCall` and `subAgentActivity` items. Forking instead copies the
selected history boundary into a new Thread and records `forkedFromId`.
Resuming a child resolves its stored role through the same role loader and
reapplies the current parent tool-catalog ceiling plus current explicit blocks;
it does not revive an AgentSession or look up a durable Agent object.

### 6. IPC and renderer

Preload exposes request/response methods named for the canonical operations, for
example `threadList`, `threadRead`, `threadStart`, `threadResume`, `threadFork`,
`threadRollback`, `threadNameSet`, `threadArchive`, `threadUnarchive`,
`threadDelete`, `turnStart`, `turnSteer`, `turnInterrupt`, and goal operations.
One typed event subscription carries canonical notifications. Old `agent_*conversation*`,
`agent_*run*`, `agent_*issue*`, and Channel-config IPC is deleted, not wrapped.

Thread/Turn/Goal operations use this dedicated protocol. Agent node tools still
mutate the document only through `src/core/commands.ts`; the refactor does not
create a second document-mutation path across IPC.

The renderer's `threadStore` indexes the protocol DTOs directly and applies the
same notification types. Selectors may group or summarize items for rendering,
but may not emit alternative Message/Run/Activity records. In particular,
`agentRunTranscriptAdapter`, `agentRenderProjection`, separate process timelines,
and Issue view models are removed.

The product surface becomes:

- a Thread list, including user Threads and clearly nested child Threads
- a Thread transcript rendered from ordered Turns and ThreadItems
- a Goal surface attached to its Thread; any cross-Thread Goal list is a query
  view over Threads and their Goals, not an Issue store
- item-specific presentation for messages, reasoning, commands, file changes,
  tool calls, subagent activity, searches, images, and compaction
- debug/detail views that show the same Thread, Turn, and Item identifiers

A terminal response preserves the established message action geometry but
exposes one understandable history command: `Continue in new chat`. It forks at
the inclusive `afterTurn` boundary. `beforeTurn` remains a host protocol
boundary and is not exposed as a second user-facing fork action.
Copy serializes the complete assistant side of the Turn, including full
content-addressed tool output. Hover/focus on Details shows usage; click and the
native response context menu open the same canonical execution details.

The renderer retains the proven transcript mechanics over canonical DTOs:
per-Thread scroll snapshots, measured virtualization above forty Turns,
disclosure scroll anchoring, transient provider-retry status, tool-type success
icons, local-file result affordances, and the existing composer/edit keyboard
contracts. These are presentation behaviors, not compatibility projections or
alternative execution entities.

Normal transcript UI need not print a heading for every Turn, but any exposed
label or detail uses "Thread", "Turn", "Item", and "Goal". Notifications navigate
by `threadId`. There are no user-visible Channels, Issues, Agent Runs, Sessions,
Activities, or Dreams.

Only the user message belonging to the Thread's final Turn exposes Edit, and
only while that Turn is terminal. The editor keeps the original structured
`ThreadUserContent[]`, replaces only the submitted text, then calls
`thread/rollback` with `numTurns=1` and starts the replacement Turn on the same
Thread. Earlier user messages and active Turns are not editable.
Assistant responses expose Copy, Continue in new chat, and Details as applicable;
they do not expose Retry or Regenerate. Continue in new chat alone forks, and the
fork remains a top-level user Thread rather than a nested child. The shared
context-menu protocol is exhaustive: actions are `copy`, `continueInNewChat`,
and `details`, and its capability request contains only `canCopy`,
`canContinueInNewChat`, and `canShowDetails`.

### 7. Destructive removal and documentation authority

Delete or fully replace the old model roots:

| Area | Required removal |
|---|---|
| Core | `agentEventLog`, `agentIssue`, `agentChannel`, `agentRenderProjection`, `agentRunStateMachine`, old agent types/commands in shared protocol files |
| Main | conversation event store, run ledger/profiles, Issue operation/store/runtime/schedule/session modules, Dream extraction/backoff/skill, old notification routing |
| Transport | old command names, `conversationId`/`runId`/`issueId` DTOs, Channel-config window bridge, renderer API wrappers |
| Renderer | `AgentChatPanel`, `AgentRunsPanel`, `AgentIssuesPanel`, Run detail/adapter, Channel config, Dream UI, parallel process/activity projections, legacy workspace panel IDs |
| Presentation | old i18n keys/copy, CSS selectors, settings controls, OS notification payloads, debug labels |
| Verification | old behavior tests/fixtures replaced by Thread/Turn/Item/Goal contract, replay, renderer, and E2E tests |
| Storage | `conversations/`, `runs/`, `agents/`, `principals/`, `issue-operations.jsonl`, old indexes/checkpoints/Dream artifacts and every reader/writer for them |

Capability implementations survive only after being moved behind the new
runtime and rewritten to accept Thread/Turn/Item context. A file is not retained
merely because deleting it is inconvenient.

Replace the current agent spec map with present-tense Codex authority:

| Final spec | Owns |
|---|---|
| `agent-core.md` | Thread/Turn/Item/Goal model, lifecycle, storage ownership, transport |
| `agent-thread-rendering.md` | direct canonical DTO rendering and interaction states |
| `agent-subagent-threads.md` | child Thread lineage, roles, coordination, fork distinction |
| `agent-model-runtime.md` | provider/model stream normalization into Turns and Items |
| `agent-tool-design.md` | current tool contracts only |
| `agent-tool-permissions.md` | Full Access, tool-catalog, explicit-block, native-failure, and capability-audit contracts |
| `agent-skills.md` | current skill configuration/invocation only |
| `agent-integration.md` | remaining integration checklist, no project status |

Rename or fold the existing `agent-architecture`, `agent-event-log-rendering`,
`agent-delegation-runtime`, `agent-pi-mono-implementation`, and `agent-progress`
documents into this map, and update `docs/spec/README.md` in the same change.
No redirect stub or duplicate old/new spec is retained. The current `agent-program`,
`agent-conversation-model`, `agent-data-model`, and `agent-memory-foundations`
authorities are superseded; other active agent capability plans must either be
rewritten against Thread/Turn/Item or archived. The main integration gate updates
`docs/TASKS.md`, archives superseded plans, and records the change in
`CHANGELOG.md`.

Legacy terms are permitted only in immutable historical records:
`docs/plans/archive/`, shipped `CHANGELOG.md` entries, and git history. While a
destructive plan is being executed, its Non-goals/removal/guard assertions may
name what they delete; the main gate archives that plan when it ships. Those
references are never imported or linked as current behavior. Active code,
storage, tests, specs, i18n, UI, and all design sections outside that narrow plan
allowlist must pass the legacy-residue guard.
An empty-userData integration test also asserts the allowed new agent storage
tree and fails if any old directory/file name is created. Completion requires
both a zero-result active-repository scan and a zero-result fresh-storage scan;
"unused but still present" does not count as removal.

### 8. Risks and mitigations

- **Interface/runtime drift:** the human-led interface PR lands first with codecs,
  provenance invariants, the projection-neutral system-receipt contract, the
  protected system-tag-definition contract, and contract tests; the replacement
  branch rebases on that exact commit and may not redeclare or locally widen the
  shared contract. The interface window contains no adapter, dual write, or
  second executable agent runtime and is closed by the immediately following
  replacement PR.
- **Capability loss hidden by old adapters:** inventory every provider/tool,
  Full Access audit/block, attachment, compaction, retry, and notification path
  and prove each through the canonical protocol before deleting its old consumer.
- **Projection drift:** compare incremental pages against a clean rollout replay,
  including interrupted Turns, partially streamed Items, repeated rollback,
  audit lookup of omitted IDs, and rollback committed without a replacement
  Turn.
- **Rollback is mistaken for world-state undo:** UI copy calls it history edit,
  not undo; causation, payloads, cumulative usage, Goal state, and every external
  effect remain authoritative and auditable.
- **Terminology residue:** run an allowlist-based repository guard over current
  source/docs/i18n/storage keys, not a hand-reviewed rename list.

### 9. Collision result

At drafting time, open PR #422 claims renderer date-count indexing files only. It
has no direct overlap with this plan. The first delivery unit claims
`src/core/types.ts`, `src/core/commands.ts`, and `src/core/agent/` through its
human-led interface-only PR. After that merges, the replacement PR rebases and
claims the full agent runtime and UI area without reopening the shared contract.
No sibling plan may modify the currently claimed unit until its PR lands or is
abandoned.

## Open questions

None. Ratifying this plan ratifies the destructive vocabulary mapping, one
ThreadGoal per Thread, no durable Agent membership/execution entity, the
Profile/Role/child-Thread split, append-only audit plus same-Thread rollback for
the latest-message Edit, explicit-fork-only branching, separate core/history/Goal
stores, rollout-as-audit-source, the exhaustive Copy/Continue in new chat/Details
response menu, the fixed
`collaboration.*` v2 tool namespace, the exact `request_user_input` replacement,
the exhaustive tool migration, immutable Turn/Item provenance, the retained Full
Access boundary, the projection-neutral document system-receipt primitive, the
protected system-tag-definition primitive, the synchronous extension admission
barriers at per-Thread and host-wide scope, the host-scoped rollback terminal-
hook recovery loop, and the interface-first two-PR delivery order.

## Implementation checklist

- [ ] Have the main agent add the three-plan dependency and this active plan
  to `docs/TASKS.md`; open the Draft PR claim before implementation.
- [ ] In the human-led interface-only PR, define and contract-test the canonical
  protocol and extension interfaces, including ThreadSource strings, immutable
  Turn/Item provenance, paginated-only current history over append-only audit,
  immutable completed records, `thread/rollback` and its prepared/aborted/
  committed extension lifecycle, client input idempotency, Node-backed
  MemoryCitation, configuration profiles, agent roles, per-Thread and host-wide
  admission-barrier snapshots, and the exhaustive response-menu actions and
  capability request, additional-context trust, Full Access exclusions, and the
  generic
  projection-neutral `DocumentSystemReceipt` plus host-only atomic mutation.
- [ ] In that interface PR, define and contract-test
  `DocumentSystemTagDefinition` and host-only
  `ensure_document_system_tag_definition`, including fixed caller identity,
  same-ID restore, ownership conflicts, definition locking, ordinary tag
  application/removal, reload, and public-surface exclusion.
- [ ] In that interface PR, define and contract-test the canonical model-tool
  registry, fixed `collaboration` namespace, v2 Subagent suite, root-only
  `request_user_input`, `update_plan`, Goal tools, retained capability tools,
  action-kind audit/block mappings, and provider transport encodings with no
  legacy aliases.
- [ ] After the interface PR merges, rebase and open the complete replacement PR;
  do not redeclare, adapt, or widen the shared protocol locally.
- [ ] Implement the settled system-receipt Loro map and host-only
  `put_document_system_receipt` path, including atomic Node-plus-receipt commits,
  reload, projection/search/model exclusion, and no user undo entry.
- [ ] Implement the protected system-tag ownership map and host-only ensure path,
  including fixed-ID creation/restore and public definition-mutation rejection.
- [ ] Implement rollout recording, rollback markers, Thread metadata/spawn
  edges, the separate current-history projection, pagination, audit lookup, and
  replay equivalence.
- [ ] Implement Thread/Turn runtimes and make GoalExtension exercise the real
  lifecycle, private Goal store, deferral, accounting, and tool paths; implement
  the coalesced rollback terminal-hook recovery loop with bounded backoff and
  orderly-shutdown cancellation.
- [ ] Prove terminal-hook recovery with a hook that fails once then settles
  without restart, duplicate-failure coalescing, capped-backoff persistent
  failure without a tight loop, abort-hook symmetry, and shutdown/startup
  handoff to durable marker reconciliation.
- [ ] Replace preload/IPC with canonical operations and notifications.
- [ ] Replace renderer state and every agent surface with direct protocol
  consumption.
- [ ] Move retained capabilities behind the new runtime and delete every old
  model, reader, tool/questionnaire DTO, event, adapter, test, i18n key, and CSS
  selector.
- [ ] Thread causation metadata through document commands and prove that Edit
  rolls back only current transcript/model history, Continue in new chat forks,
  neither operation reverts Node, Memory, file, shell, MCP, process, Goal, usage,
  or external effects, and no Retry/Regenerate history action remains.
- [ ] Rewrite the current agent specs and prepare old active plans for main-gate
  archival.
- [ ] Add a legacy-residue guard covering active source, tests, specs/plans, IPC,
  persisted keys, i18n, CSS, and user-visible copy, allowing archived plans,
  historical changelog entries, scoped destructive-plan assertions, and the
  future `AutomationRun` only.
- [ ] Validate from empty userData with `bun run typecheck`, `bun run test:core`,
  `bun run test:renderer`, focused E2E coverage, `bun run docs:check`, and
  `git diff --check`.
