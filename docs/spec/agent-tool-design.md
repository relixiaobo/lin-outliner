# Agent Tool Design

This document defines the tool protocol exposed to the Lin agent runtime.

The design follows the nodex tool model: keep the public tool set small, make
each tool domain-aware, and let tool parameters express outliner semantics such
as tags, fields, references, movement, and undoable operations. Lin should not
expose one tool per UI command unless the operation has a clearly separate agent
role.

## Goals

- Let the agent perform the same document operations a user can perform.
- Keep the outliner tool set compact and predictable.
- Put outliner semantics in TypeScript-backed tools, not in the model prompt.
- Make every mutation previewable, auditable, and undoable.
- Return structured results that tell the agent what happened and how to
  recover from partial success.
- Avoid a generic `node_batch` or `outliner_write` meta-tool.

## Non-Goals

- Do not expose a separate tool for reading active UI context. Active workspace,
  panel, selected nodes, visible nodes, and recent user edits are injected into
  each user turn as a system reminder.
- Do not simulate UI gestures such as clicking buttons or pressing Tab. Tools
  expose the document operation behind the gesture.
- Do not expose internal Electron IPC command names as the public agent API.
- Do not make file, bash, or web tools responsible for outliner mutations.

## Tool Registry

### P0 Tools

These tools are required for the first useful local agent.

| Tool | Kind | Mutates | Approval | Purpose |
|---|---|---:|---|---|
| `node_search` | outliner | No | No | Execute temporary search outlines or saved search node queries. |
| `node_read` | outliner | No | No | Read node raw type/data, fields, and bounded children. |
| `node_create` | outliner | Yes | Usually yes | Create outline trees, references, search/view nodes, schema nodes, or duplicates. |
| `node_edit` | outliner | Yes | Usually yes | Edit one known node's own content, fields, field values, or saved-search config using exact string replacement, or perform explicit by-id operations such as move and merge. |
| `node_delete` | outliner | Yes | Usually yes | Trash or restore one or more nodes. |
| `outline_undo_stack` | outliner | Yes for undo/redo | Usually yes | Inspect, undo, or redo user and agent outline operations. |
| `file_read` | local | No | Usually no | Read local files with bounded output. |
| `file_glob` | local | No | No | Find files by glob or path pattern. |
| `file_grep` | local | No | No | Search file contents under allowed roots. |
| `file_edit` | local | Yes | Yes | Apply exact string replacements to files. |
| `file_write` | local | Yes | Yes | Create files or rewrite whole files. |
| `file_delete` | local | Yes | Yes | Move local files or directories to agent trash. |
| `bash` | local | Depends | Usually yes | Run local commands with timeout and output limits. |
| `bash_stop` | local | Yes | Usually yes | Stop background commands created by `bash`. |
| `web_search` | web | No | Depends | Search the web for current external information, or for images with `kind: "image"`. |
| `web_fetch` | web | No | Depends | Fetch and read a specific URL with pagination or snippet search. |

### P1 Agent Tools

These agent-level tools are active on top of the core local/document tool
surface.

| Tool | Kind | Mutates | Approval | Purpose |
|---|---|---:|---|---|
| `past_chats` | agent | No | No | Read/search visible prior conversation history and raw cited spans. |
| `ask_user_question` | agent | No | No | Pause the active run for structured user input, including refs/attachments or an explicit discuss outcome. |
| `generate_image` | agent | Creates image files | Usually yes | Generate or edit raster images through enabled image-capable providers. |
| `issue_search` | agent | No | No | Search concrete Issues and Recurring Issues by canonical work fields, execution state, node/tag scope, Activity state, and ordering fields. |
| `issue_read` | agent | No | No | Read one Issue or Recurring Issue with requested detail slices for sessions, Activity, generated Issues, or verification evidence. |
| `issue_create` | agent | Yes | No | Create an Issue or Recurring Issue with objective, criteria, trigger, input scope, delegate profile, and verification policy. |
| `issue_update` | agent | Yes | Destructive changes only | Update field, status, trigger, recurrence, relations, or lifecycle changes on existing Issues and Recurring Issues. |
| `agent_session_start` | agent | Runtime execution | No | Start one Agent Session for an Issue from the Issue input snapshot. |
| `agent_session_read` | agent | No | No | Read an Agent Session's status, latest output, Activity, and executor-facing state without exposing a Run id. |
| `agent_session_send_message` | agent | Runtime execution | No | Send soft guidance or requested input to a live Agent Session. |
| `agent_session_stop` | agent | Runtime execution | Destructive cancellation only | Request cancellation of a live Agent Session. |

There is one agent (Neva). Conversations ("channels") are not organized by an
agent tool, so there are no channel-management tools on the surface.
The internal delegation executor is not a tool family. It backs Agent Sessions,
and isolated skills, but agents control work through Issue / Agent Session tools
only.

### Agent Issue Manager Contract Checkpoint

The Issue Manager implementation has a canonical protocol/store checkpoint in
code, and the Issue/Agent Session tools are wired into ordinary and child-agent
tool pools through `AgentIssueToolRuntime`. The product/tool surface uses
Issue, Recurring Issue, Agent Session, and Activity; V1 reuses the existing
delegation engine as an internal Agent Session executor.

The checkpoint defines the concepts, schemas, and Issue-first Work surface:

- canonical types live in `src/core/agentIssue.ts`: Issue, Recurring Issue,
  Agent Session, Activity, and the eight Issue/Agent Session tool input/result
  contracts;
- JSON Schema parameter contracts live in
  `src/main/agentIssueToolSchemas.ts`, with descriptions on every visible
  field and no model-facing `userActionId`, authorization token, or capability
  id;
- tool definitions live in `src/main/agentIssueToolDefinitions.ts`, keeping
  name, kind, search hint, schema, and read/destructive classifiers in one
  place;
- `src/main/agentIssueTools.ts` adapts those definitions to the existing
  `ToolEnvelope` result format behind an explicit `AgentIssueToolRuntime`;
- `src/main/agentIssueRuntime.ts` wraps the store as an
  `AgentIssueToolRuntime` and applies Issue state, revision, blocker, scope, and
  executor checks before Agent Session starts, messages, or stops. A
  request-mode `agent_session_start` creates the Agent Session first, then
  immediately hands it to the configured executor. If no executor is available,
  the Session is marked `error` instead of remaining indefinitely `pending`;
- preview and request modes share the same state-level Store apply/preflight
  functions. Update preview runs mutation semantics against an isolated state
  clone; creation and Session controls reuse their request preflight. Object
  existence, revision, relation, lifecycle, child-scope, and Session-state
  failures therefore match the real request without persisting Activity or state. A
  continuation is structurally complete only with both
  `previousAgentSessionId` and `intent`; the Store repeats that validation at its
  trust boundary before building a Session objective;
- Local Issue lifecycle and Agent Session control tools do not have a separate
  Issue-specific authorization classifier in V1; the ordinary tool permission
  layer still blocks destructive or platform-risky downstream tools. The
  model-facing schema carries no authorization token, capability id, or
  `userActionId`;
- `src/main/agentIssueInputResolver.ts` resolves an Issue's input
  scope against the current outliner projection when an Agent Session starts.
  `selected-nodes`, `node-children`, and `tag-query` scopes become a bounded
  `inputSnapshot` with concrete node ids and a preview on the Agent Session;
  the Issue remains the durable work object, and nodes do not store work state.
- `src/main/agentIssueSessionScope.ts` maps an Agent Session's
  `inputSnapshot` and `outputSnapshot` into delegated Run
  `scope.resources.nodes` and `scope.resources.writableNodes` roots. Resolved
  input nodes, attached `noteNodeIds`, and output anchors are readable; only
  output-policy targets are writable. Explicit empty arrays mean deny all,
  while an omitted dimension is unrestricted. The node tools enforce that resource scope at
  runtime: `node_search` filters results to scoped node roots and their
  descendants, `node_read` rejects scoped reads that would expose unscoped nodes
  or backlinks, and
  `node_create`/`node_edit`/`node_delete` reject requested targets,
  destinations, references, duplicate sources, or affected subtrees outside the
  scoped node set. Definition mutations preserve the read/write split:
  definition creation requires writable access to `SCHEMA_ID`; configuration
  targets and their implicit affected nodes are writable while config references
  are only readable; definition reuse writes the field entry and its old
  definition while only reading the target definition; definition merge requires
  every target, source, and affected node to be writable. This makes unattended
  Issue Sessions fail closed in code instead of relying on prompt instructions.
  `outline_undo_stack` is omitted
  entirely from every scoped Run because its global journal and undo/redo cursor
  cannot be narrowed to one node-resource set safely.
- `src/main/agentIssueStore.ts` persists Issues, Recurring Issues, Agent
  Sessions, and Activity in `issue-manager.json`, including request-mode
  creation, origin-derived parent/child Issue relationships, Issue relations,
  revision conflicts, session message/stop Activity,
  due-time Recurring Issue materialization, internal Session-to-executor
  bindings, durable terminal-delivery outbox entries, and execution status sync
  into `active`, `complete`, `error`, or `canceled`;
- `src/main/agentRuntime.ts` owns the Issue store lifecycle and runs a
  lightweight Issue scheduler tick. The tick materializes due active Recurring
  Issues into concrete Issues, then starts one Agent Session for each unattended
  ready Issue that has not already had a Session. Ordinary
  and child-agent tool pools receive `issueRuntime`; Dream does not, so
  model-facing Issue tools cannot create, mutate, or start Dream work.
  Creating a `when-ready` unattended Issue is enough to hand work to runtime:
  the `issue_create` result reminds the model not to call `agent_session_start`
  for the same newly created Issue unless it is retrying or continuing it later.
  The design keeps the same clean split as a background-agent system: the durable
  work object is not the worker transcript, the Agent Session is the execution
  attempt, and terminal output is delivered back to the caller without exposing
  an ordinary nested conversation.
  Product-runtime request creation requires a routing origin. A root Issue
  created from a visible conversation records that conversation. An Issue created
  inside an Agent Session records the Session and derives `parentIssueId` from it;
  the model cannot supply or rewrite either value. The creating Session must be
  active, execution-bound, and not reserved for stop. Hidden execution
  conversations are containers, never routing origins or user channels. A
  Recurring Issue resolves its caller chain to one visible-conversation origin;
  its origin type cannot point to an Agent Session. Each materialized concrete
  Issue inherits that visible conversation origin and remains a root Issue.
  The internal Run bound to an execution Session is durably classified as a
  controller even when the visible starting turn is its Run parent. A verifier
  rejection re-plans that same binding in place instead of starting an unbound
  sibling replacement. Runtime allocates the Run in memory, then the acceptance
  hook durably binds the Agent Session before the first `run.started` event is
  appended. Binding failure aborts and unregisters the unannounced Run, so no
  durable Run ledger can exist without its owning Session binding.

  Routing is one hop per durable edge:

  | Terminal event | Immediate destination | Durable effect |
  |---|---|---|
  | Issue completes | Child -> direct parent Agent Session; root -> visible origin conversation | Issue becomes completed and one terminal delivery is enqueued. |
  | Child Issue is canceled | Direct parent Agent Session | Child becomes canceled and one cancellation delivery is enqueued. |
  | Agent Session errors, including failed start or interrupted-startup recovery | Owning Issue's immediate origin | Session becomes error or stale; Issue remains open for retry, revision, or cancellation. |
  | Agent Session is explicitly stopped | None | Session becomes canceled; Issue remains open. |
  | Root Issue is canceled | None | Root becomes canceled without a synthetic result. |

  A routable transition writes its terminal-delivery outbox entry in the same
  Store transaction as the terminal state change. Entries move through
  `pending`, leased `dispatching`, and `delivered`; concurrent drain owners cannot
  claim one live lease, and an abandoned claim becomes eligible again after the
  lease expires. Startup, scheduler sweeps, immediate terminal callbacks, and
  terminal execution-frame settlement drain eligible entries. A deferred or
  failed attempt returns to `pending`; runtime records its retry deadline and a
  single earliest-deadline timer actively queues the next drain. Retries therefore
  do not wait for the minute scheduler tick. A restarted process arms the same
  timer for the exact expiry of a persisted live `dispatching` lease, while a process crash or transient
  executor/conversation failure still cannot lose the wake-up. Enqueue deduplication
  keys one terminal generation by Issue, Agent Session, terminal state, and
  terminal timestamp. Root delivery uses deterministic per-attempt hidden-user
  message and Run ids. The hidden message links the durable Issue notification
  into the conversation projection. A successfully processed notification Run
  acknowledges the outbox whether its final assistant `stop` contains visible
  text or is deliberately empty; replay recognizes an already completed Run and
  can seal a final `stop` that survived without its terminal Run event, without
  asking the Agent twice.
  Session-owned execution Runs and all of their verifier or
  delegated descendants are excluded from generic Run notifications, OS
  banners, and notification turns; the terminal-delivery outbox is their only
  routing path, including after restart. A detached child Run whose objective
  role is `controller` is likewise excluded from generic detached-child
  aggregation and `<detached-sub-run-results>`. Its parent waits for the Issue
  outbox marker instead, so an explicitly started child Session is integrated
  exactly once. The marker carries the child execution id; the parent waiter
  matches newly started controller identities rather than comparing against all
  historical controller Runs, so sequential children remain routable after
  earlier deliveries are acknowledged or after restart.

  Child delivery persists an exact hidden payload plus a marker in the direct
  parent Run ledger. A queued marker is resumed from its existing ledger tail
  after restart instead of being appended twice. Compaction carries every pending
  payload into the post-compaction root; marker recognition follows that logical
  carrier through repeated compactions, including multiple simultaneous pending
  markers. The outbox entry is acknowledged only after a continuation descending
  from the marker ends with a normal final assistant `stop` and reaches a
  successful `run.completed`. An agent-review parent must additionally reach
  objective state `verified`; its verification requirement, replacement attempt
  base, and ordered gap signatures persist across restart, while verifier Run ids
  are derived from parent links. Resuming a Run clears the previous execution
  span's submission pointer; reconciliation uses only the current span's final
  tool-free assistant response or later result submission, never an older
  "waiting" result. That acknowledgement and the parent Session
  completion / Issue finalization happen in one Store transaction. A `verifying`,
  rejected, blocked, budget-exhausted, stale, restore-interrupted,
  provider-failed, canceled, or incomplete tool-turn state does not acknowledge
  delivery.
  These receiver-side markers make repeated dispatch idempotent before the
  outbox entry becomes `delivered`.

  Parent lifecycle gates preserve every child edge. An Issue cannot complete,
  cancel, or start a replacement Session while a direct child is unfinished or a
  child terminal delivery is unacknowledged. Completion and Session start also
  reject unresolved outgoing `blocked-by` relations and incoming `blocks`
  relations; completion and cancellation reject an active Session. Completed and
  canceled Issues cannot transition back to an active state. Deletion rejects
  direct children, active Sessions, incoming relation references, unfinished
  child routing, and undelivered terminal output.

  Session stop uses a persisted reservation before calling the executor. The
  reservation blocks concurrent child creation, binding, guidance, and duplicate
  stop. If executor stop reports an error, runtime re-reads execution state: a
  confirmed cancellation commits; a confirmed live execution or a concurrently
  observed non-canceled terminal state releases the reservation; only an
  unconfirmed state that remains live retains it until recovery. Cold-start
  recovery runs once per AgentRuntime process instance over the Session-id set
  captured when the runtime is constructed. Sessions created after renderer
  readiness are outside that startup set, and their stop reservations are never
  cleared by recovery. Recovery first reconciles each captured active bound
  Session from ledger-repaired Run metadata. A terminal Run is
  synchronized through the normal execution-state path, using the current span's
  latest submission or final assistant fallback; it is not converted into an
  interrupted-startup error. Only a still-running, missing, or otherwise
  non-terminal binding remains for the stale pass, which clears abandoned
  reservations and marks residual `pending` or `active`
  Sessions `stale`. An unexpected executor cancellation also maps to `stale`, not
  `canceled`, while that Session still owns unresolved child work or an
  unacknowledged child delivery.

  Run execution status and objective status are separate inputs to Session state.
  `completed + verifying` remains active, as does `completed + active` for a Run
  that still requires verification. A verification-disabled completion or
  `completed + verified` maps to `complete`; `blocked` and `budget_exhausted` map
  to error/attention, and `stopped` maps to canceled. Stopping a live verification
  state first cancels its verifier and records objective state `stopped`; Session
  cancellation is never committed from an unconfirmed no-op stop.

  Objective or criteria amendments invalidate the current verifier/re-plan frame,
  stop live verifier children, clear previous verdict/gap state, and return the
  objective to `active`. Budget-only amendments preserve the current verdict,
  objective status, blocked reason, latest gap, and gap signatures. The amendment
  is rejected without side effects when its budget exceeds the direct parent's
  remaining token reservation or wall-clock deadline. Budget validation happens
  before any verifier or contract mutation. The amendment
  reminder and lifecycle update are appended together, while resumed and terminal
  lifecycle events repeat the current objective, criteria, and objective role.
  Run metadata reads repair a projection from those latest ledger facts when a
  crash interrupts the metadata write. Restore durably blocks any orphan
  `completed + verifying` parent that has no live verification frame, so a later
  Session read cannot reopen it as active.

  Conversation deletion preserves routing integrity. A visible conversation
  cannot be deleted while it is the origin of a non-terminal root Issue, an
  unarchived Recurring Issue, or an undelivered terminal result. An execution
  conversation cannot be deleted while it carries an active or stopping Session,
  an unfinished child edge, or an unacknowledged child delivery. Runtime blocks
  deletion rather than silently orphaning or cascading durable work. Conversation
  reset is also blocked while it would delete an active Agent Session carrier's
  Run ledger. Closing the visible conversation is a separate renderer lifecycle operation: while a
  delegated execution frame remains live, runtime retains the conversation
  headlessly and a same-process reopen returns that existing runtime instead of
  rebuilding it or running interruption recovery. A deferred close destroys the
  runtime only after the final delegated frame settles.
- Agent work has three interaction modes, none of which are stored as Issue
  categories. **Direct answer** means no Issue is created because the assistant can
  finish in the current turn. **Background handoff** is the default durable-work
  mode: `issue_create` writes a when-ready, scheduled, or recurring contract;
  runtime starts eligible work; and routable terminal state returns to the
  Issue's immediate origin target. **Explicit wait** is a Session-level
  control path for an existing Agent Session: the caller uses
  `agent_session_read(wait: true)` or a non-detached explicit start only when the
  user wants the current conversation to block for that result. There is no
  `manual` Issue trigger and no "waiting" Issue status.
- The renderer-facing Work panel is Issue-first: it reads Work rows with
  `agent_issue_search` and opens Issue details with `agent_issue_read`. The
  detail payload includes Agent Sessions, but the renderer treats them as
  execution entries inside the Issue Activity timeline instead of a separate
  product section. All Activity items use the same row interaction: semantic
  icon, title, relative-time meta line, disclosure chevron, and an expanded
  detail body. Ordinary Issue lifecycle rows expand to audit metadata; execution
  rows expand to a `Process` disclosure for transcript-backed tool/thinking
  details plus the latest output or error. Completed executions are collapsed by
  default. `agent_session_read` remains a bounded
  tool/control surface for explicit Session inspection, but it is not the Work
  UI's default nested navigation path. The panel's Inbox, Today, Upcoming,
  and Logbook navigation items are renderer smart filters over canonical row
  facts, not model-facing view enums or stored categories. Every first-level
  preset excludes child Issues. Inbox contains roots carrying an error/stale
  Session, blocked by another Issue, past their execution deadline, awaiting
  human review, or holding a rejected or evidence-incomplete verifier result. Today
  contains non-terminal when-ready roots, active roots, overdue or today-scheduled
  / due roots, recurring rules firing today, and roots finished today. Upcoming
  contains every non-archived recurring rule plus non-terminal future scheduled
  or due roots, so recurring rows may overlap Today. Logbook contains completed,
  canceled, or archived root concrete Issues. Activity feeds row summaries,
  Issue details, and inline Agent Session process details; it is not a primary
  navigation tab, and Logbook is a view name rather than a separate object.
  Work refreshes time-derived buckets once per minute, and separately re-arms at
  each local midnight for DST-safe day grouping, so a newly expired deadline or
  changed Today boundary does not require another agent event.
  Each smart-view query follows `nextCursor` until exhaustion, and the active
  Session badge uses a separate fully paginated query that loads and subscribes
  even while Work is closed. Badge refresh and Work-index refresh use independent
  debounce timers, so changing a preset can invalidate the old index request
  without canceling a pending Session-count update. Preset changes invalidate
  in-flight and delayed refreshes from the previous preset. Nested Issue navigation
  stays in the same detail dialog and re-establishes focus inside the dialog after
  content swaps.
  Human-review acceptance is offered only when a completed execution exists and
  no Session is currently pending or active. Work dates use the application
  locale, not the OS locale.
  Issues are durable work contracts for independently user-visible outcomes:
  each row represents an outcome with its own definition, status, criteria,
  evidence, and Activity. When work needs per-item coverage or internal
  breakdown, the responsible Agent Session records execution details in its Run
  transcript plus criteria progress, evidence, Activity, and final output on that
  Issue. It creates a child Issue only when a
  sub-outcome needs its own durable lifecycle or independent Agent Session;
  runtime derives the parent from the creating Session. Generated Issues from
  Recurring Issues remain roots and can be opened through the same Issue detail
  reader.
- `issue_search` returns lightweight rows. Its only includes are
  `activity-summary` (latest user-visible Activity plus count) and
  `session-summary` (active/attention facts plus latest Session state/time).
  Full text covers Issue title/description, Issue and linked Session Activity,
  latest Session output and error; Recurring Issue text covers its
  title/description template and Activity. Family-specific filters are strict:
  applying `issueIds`, parent, due, relation, or Session filters excludes
  Recurring Issues, while `recurringIssueIds`, cadence, or next-materialization
  filters exclude concrete Issues. `parentIssueIds` matches direct children and
  `relation` preserves relation direction. Explicit ordering supports created,
  updated, due, next materialization, and status; missing values stay last in
  both directions.
- `issue_read` supports exactly `activity`, `sessions`, `child-issues`, and
  `generated-issues`. Issue Activity includes the Issue's own entries and linked
  Agent Session entries; `sessions` and `child-issues` apply to concrete Issues,
  while `generated-issues` applies to Recurring Issues. `agent_session_read`
  supports exactly `activity-summary` and `latest-output`; Activity is bounded to
  the newest 20 entries. Transcripts remain
  renderer-only.
- Model-visible `issue_read` strips `origin` from concrete, child, generated, and
  Recurring Issues. Session projections omit `source`, `issueSnapshot`, input /
  output snapshots, execution policy, and unrequested output;
  `latest-output` is opt-in on `agent_session_read`. These internal values remain
  available to runtime/store code, not to model routing decisions.
- `relations` link independently user-visible Issues whose lifecycle is managed
  separately, such as true external blockers, duplicates, or related outcomes.
  Progress for a complex Issue comes from Agent Sessions, criteria, evidence,
  and Activity on that Issue.

The internal executor binding is intentionally not part of the model-facing
schema. `agent_session_read` returns a bounded Agent Session projection, not a
Run id. `agent_session_read`, `agent_session_send_message`, and
`agent_session_stop` route through the binding's owning conversation when a live
executor is available and otherwise report a warning or blocked state through the
normal tool result. The Issue detail UI has a separate renderer-only transcript
reader for the bound execution conversation so it can reuse the conversation
assistant-turn renderer; that command is not an agent tool and is not part of the
model-facing schema. Preview and blocked stop requests never touch the executor.
A parent Session cannot be stopped while its child Issues remain unresolved or
a child terminal result is still waiting for delivery; this keeps the immediate
routing origin available until the child edge has settled.
An Agent Session caller is scoped to its owning Issue and direct child branch:
search/read/update cannot escape that set, direct completion is denied, Session
relation targets cannot escape that set or indirectly block another branch,
and pre-existing relations to outside that set must be preserved unchanged.
Session control reaches only itself or a direct child Session, and execution start
reaches only a direct child Issue. Search applies this ownership scope before
ordering and pagination, so unrelated global rows cannot consume or expose a
scoped page. Runtime fails closed when an internal execution conversation has no
Session binding or a nested Run's ownership chain cannot be read; it never falls
back to visible-conversation/global Issue authority. Missing or cyclic Run
ownership metadata is treated as unresolved ownership, not as a root Run.
Recurring Issue
creation/update from an Agent Session is denied. A child Issue must be created
while its parent Session is active, but an already persisted child may still start
after that parent becomes complete, stale, or error as long as the parent is
execution-bound, non-canceled, and not reserved for stop; this preserves its
one-hop routing and scope ceiling.

`agent_session_start.continuation` supports `summary`, `transcript`, and `none`.
Summary injects only prior latest output/error; transcript uses a bounded prior
active-path Run transcript and explicitly falls back to summary when the binding
or ledger is unavailable; none injects no prior Session content. The new Session
persists only `continuationOfAgentSessionId`; intent, guidance, and context mode
are consumed when runtime builds the execution objective.
Activity is a high-signal user-visible Issue lifecycle layer, not the Agent
Session transcript. It records Issue behavior such as creation, edits,
archival/deletion, status changes, high-level Agent Session start/stop events,
verification results, questions, errors, output links, and user comments.
Runtime keeps the full terminal output on
`AgentSession.latestOutput`; the Issue detail transcript renders the bound Run
ledger directly, so Activity does not copy raw model reasoning, tool calls, or
large final answers.
Issue `delete` is blocked by the lifecycle and reference gates above. Once
eligible, Issue and Recurring Issue `delete` operations return
`applied` without an object revision because the target no longer exists; the
deletion remains auditable via Activity on the deleted target id.

The target model-facing tool names are exactly:

```text
issue_search
issue_read
issue_create
issue_update
agent_session_start
agent_session_read
agent_session_send_message
agent_session_stop
```

Recurring Issue belongs to the Issue family, so there is no
`recurring_issue_*` tool family. Agent Session tools are runtime-control/read
tools for one execution record; Activity is emitted by runtime/store code and
is not exposed through an `activity_record` tool. The checkpoint deliberately
does not add `task_*`, `run_*`, `project_*`, `cron_*`, or `logbook_*` tools.

Recurring Issue materialization is store-owned and due-time only. Active
Recurring Issues can create concrete Issues when a cadence is due; paused or
archived Recurring Issues do not. Daily, weekly, and monthly cadence times are
interpreted as wall-clock values in the persisted IANA `timeZone`, including
daylight-saving transitions; a missing spring-forward time shifts forward and a
repeated fall-back time fires once at the earlier occurrence. The same time zone
determines the generated Issue title's covered local date. Repeated sweeps do not
create duplicate Issues for the same recurrence window. When multiple due
windows were missed, the default `coalesce-latest` policy creates only the latest
concrete Issue, stores the number of earlier ungenerated and non-skipped windows
as `skippedWindowCount`, and records `coalesced:<count>` in Recurring Issue
Activity. `skip-missed` still materializes the latest due window but drops older
missed windows without `skippedWindowCount` or coalesced Activity metadata.
`skip-next` records the next due window in
`skippedMaterializationAts`, advances `nextMaterializationAt`, and the
materializer treats that window as intentionally handled rather than missed, so
it does not create a concrete Issue or inflate a later coalesced count. `Local`
is accepted only as an input compatibility alias and is canonicalized to the
current IANA zone before persistence. A cadence/time-zone patch and a resume both
reset the first-eligible cursor to the first window strictly after the change;
paused windows and windows from an earlier cadence are not backfilled or counted
as coalesced misses. Only paused definitions can resume. Archived definitions
have no next-materialization cursor, cannot resume, and never materialize.

Automatic trigger execution is one-shot per concrete Issue in V1: an unattended
`when-ready` Issue or due `scheduled` Issue without any prior Agent Session can
start one Agent Session from the scheduler. A completed Session finalizes the
Issue only when the blocker, child/delivery, active-Session, and verification
gates allow it; human-review Issues require an explicit lifecycle transition.
Expired `deadlineAt` values exclude open Issues from automatic execution and add
them to the attention set. Completion/cancellation writes immutable `terminalAt`
for Today/Logbook projections instead of treating later `updatedAt` changes as the
terminal time. `saved-query` input and unresolved `daily-note` output block both
explicit start and ready-sweep execution in the current runtime. Recurring Issue
templates intentionally carry no absolute execution policy.
Failure does not cause the scheduler to loop on the same Issue. Retrying or
continuing terminal work creates a new Agent Session through an explicit
`agent_session_start` request after the same gates pass.

Issue verification uses the same Agent Session mechanism. `agent_session_start`
accepts `purpose: "verify"` only when the Issue has
`verificationPolicy.mode === "agent-review"`. The Session uses the configured
verifier AgentRef, defaulting to Neva's `verifier` run profile. An explicit
verifier starts with `context: "none"` and the runtime's read-only tool allow-list.
Its scope is derived from the concrete work Run: `docs`, `paths`, and readable
`nodes` are preserved, while `writableNodes` is removed (or used only as the
readable node ceiling when no readable-node list exists). It therefore receives
the Issue verification directive rather than inherited worker conversation
context. Its concrete tool allow-list is also intersected with the work Run's
effective tool allow-list and read capabilities; a work Run with no read
capability gives its verifier no tools.
The verifier cannot read beyond the work Run or mutate work while reviewing it.
Its response
must begin with `Verdict: pass`, `Verdict: partial`, or `Verdict: fail`; runtime
records the parsed result as `verification-result` Activity and links the
verifier Agent Session as Issue evidence. `requiredVerdict` defaults to `pass`,
while `pass-or-partial` accepts either of those explicit verdicts. Missing or
malformed verdict lines are recorded as `fail`; they never inherit the permissive
`partial` meaning. Every configured
`requiredEvidence` string must also be explicitly present in the verifier output
before completion is allowed. Policy checks use the verifier Session's complete
latest output even though Activity stores only a bounded display summary. There
is no `verification_*` model-facing tool.
Human-review Issues remain open after execution and appear in Inbox. Work detail
then exposes a renderer-only `Accept and complete` command that records the local
user actor. Model-facing Issue tools cannot self-approve, and non-user actors
cannot lower or clear an existing human/agent review requirement or remove/waive
an existing completion criterion. Completion remains bound to the Session's
criterion ids and text: adding, deleting, or rewriting active criteria after the
Session starts requires a new execution Session, while an explicit trusted-user
waiver may satisfy the removed requirement. Human review also requires a
completed execution Session.

## Internal Delegation Executor

The delegation executor remains in the runtime for isolated skill execution and
as the implementation substrate for Agent Session starts. It is not the product
work-management API and has no model-facing compatibility tools. Runtime maps
an Agent Session snapshot into an internal delegation input:

```ts
interface DelegationInput {
  objective: string;
  criteria?: string[]; // required unless verify === false
  verify?: boolean; // default true
  scope?: {
    capabilities?: string[]; // action kinds
    resources?: {
      docs?: string[];
      paths?: string[];
      nodes?: string[];
      writableNodes?: string[];
    };
  };
  budget?: { tokens?: number; wallClockMinutes?: number };
  context?: "full" | "brief" | "none"; // verifier Runs are runtime-pinned to "none"
  model?: string; // optional override
  name?: string;
}
```

The runtime validates that verified runs have explicit criteria. The returned
executor result is synchronized back to the owning Agent Session and Issue
Activity. Scope narrows downward by action kind; resource paths/docs cannot widen
past the parent Session scope. Budget is admitted locally at each edge, reserves
token headroom before sibling work, and settles on termination.

Agents inspect or control execution through `agent_session_read`,
`agent_session_send_message`, and `agent_session_stop`; those tools do not expose
internal executor ids as the product contract.

### Deferred Tools

Browser automation, MCP tools, skills, and sub-agents should wait until Lin has a
specific workflow for them. A larger registry increases prompt cost and makes
permission behavior harder to reason about.

## Naming Rules

- Use lower snake case.
- Use `node_*` for outliner graph operations, following nodex.
- Use `file_*` for local filesystem operations.
- Use `bash` for shell execution.
- Use `bash_stop` for stopping background commands created by `bash`.
- Use `web_*` for network read tools.
- Use `node_search` / `node_read` for durable memory nodes on the timeline.
- Use `past_chats` for visible prior conversation history and raw stream spans.
  Search/recent results are navigation; the model must read by `message_id` or
  `source` before relying on details.
- Use `ask_user_question` for decisions or missing context, not permission
  approval. Permission approval answers "may the agent do this"; this tool
  answers "what information or direction should the agent use next".
- Use `generate_image` for raster image generation/editing only; normal
  multimodal chat and `file_read` remain the way to inspect existing images.
- Local file tools should mirror proven read, edit, write, glob, and grep roles,
  while keeping Lin's lower snake case names.
- The local tool list is intentionally smaller than broader terminal-first tool registries.
  Compatibility aliases and history-shaped tools such as `KillShell`,
  `TaskOutput`, and old agent-output readers are not exposed; background output
  should be surfaced through runtime events or persisted paths that can be read
  with `file_read`.
- Do not use a generic `node_batch`; batch capability belongs inside the
  relevant tool parameters.

## `ask_user_question`

`ask_user_question` is a run-scoped, blocking user-interaction tool. It is not a
permission request and does not reuse approval cards or approval events.

Input:

```ts
interface AskUserQuestionInput {
  questions: Array<{
    id: string;
    type: "single_choice" | "multi_choice" | "free_text";
    header?: string;
    question: string;
    required?: boolean;
    allow_other?: boolean;
    allow_references?: boolean;
    allow_attachments?: boolean;
    options?: Array<{
      id: string;
      label: string;
      description?: string;
      recommended?: boolean;
    }>;
  }>;
  submit_label?: string;
}
```

Runtime validation enforces 1-4 questions, stable unique question ids, unique
option ids/labels per question, 2-6 options for choice questions, no options for
free-text questions, and no preview field. OpenAI function schemas stay permissive
at the top level; conditional rules are enforced in TypeScript normalizers.

The renderer presents a request with more than one question as a one-question-at-a-time
stepper inside the composer surface. The user can move forward and back through
the local draft, but only the active question's prompt/options/editor are visible
at any time. The stepper keeps the progress compact in the title row, shows Back
as an icon-only control from the second step onward, and keeps `Discuss first` as
a lower-emphasis whole-request escape hatch from every step. The backend event
model stays one pending request and one final resolution.

Result:

```ts
interface AskUserQuestionResult {
  requestId: string;
  outcome?: "answered" | "discussed";
  answers: Array<{
    questionId: string;
    selectedOptionIds?: string[];
    text?: string;
    notes?: string;
    nodeRefs?: Array<{ nodeId: string; label?: string }>;
    fileRefs?: Array<{
      attachmentId?: string;
      entryKind?: "file" | "directory";
      name?: string;
      path?: string;
      ref?: string;
      mimeType?: string;
      sizeBytes?: number;
      payload?: AgentPayloadRef;
    }>;
    attachments?: Array<{
      id?: string;
      kind: "image" | "text" | "file";
      ref?: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      path?: string;
      payload?: AgentPayloadRef;
      truncated?: boolean;
    }>;
  }>;
  discuss?: { message: string };
}
```

`outcome: "answered"` is the normal path. Required validation accepts selected
options, free text, structured refs, or attachments for questions that allow
them. Node refs and local-file refs are preserved as structured fields instead of
being flattened into answer text only. Path-backed answer attachments use the
same realpath-based local-root jail and materialization path as the main agent
composer; `ask_user_question` must not become a file-read bypass. Text/image
answer attachments are persisted as payload refs before the `user_question`
resolution event is appended.

`outcome: "discussed"` is a dedicated close-the-card path. It skips required
answer validation, resolves the tool call with `answers: []` plus
`discuss.message`, and returns model-visible instructions to ask a short
clarifying question in the normal conversation. If structured input is still
needed after discussion, the agent must call `ask_user_question` again with a
fresh request.

## `generate_image`

`generate_image` is a run-scoped image generation and image-editing tool. It is
the product surface for generated raster images; Tenon may use pi-ai
`ImagesModels` internally, but the agent sees a Tenon-owned tool with Tenon-owned
permissions and local-file persistence.

The tool is available only when the runtime has at least one enabled,
credentialed image-capable provider. Provider records do not store a default
image model; the optional default lives in `imageGeneration.defaultModel`, a
tool preference stored separately from provider connection rows. If the `model`
parameter is omitted or `auto`, runtime first tries that saved default. If the
saved default is unavailable, runtime falls back to deterministic provider
priority: the active provider when it has image models, then first-party OpenAI,
first-party Google Gemini, then OpenRouter.

Input:

```ts
interface GenerateImageInput {
  prompt: string; // required visual generation/edit instruction
  model?: string; // model id, provider:model, provider/model, or auto; omitted = auto
  image_paths?: string[]; // local image paths or [[file:...]] refs for edits/references; omitted = text-to-image
  count?: number; // default 1, capped at 4
  size?: string; // provider-specific; omitted = provider default
  aspect_ratio?: string; // provider-specific; omitted = provider default
  quality?: "auto" | "low" | "medium" | "high"; // omitted = provider default
  background?: "auto" | "opaque" | "transparent"; // provider-specific
  output_format?: "png" | "jpeg" | "webp"; // provider-specific; omitted = provider default
}
```

Validation is TypeScript-owned:

- `prompt` is required, non-empty, and capped.
- `image_paths` are capped and may be absolute paths, workspace-relative paths,
  generated-image scratch-relative paths, `file:^...` local-file targets,
  generated `markdownImage` values, or normal `[[file:...]]` markers. They
  resolve through the same local file boundary used by file tools and previewable
  agent scratch files. The selected model must advertise image input before
  references are sent.
- Missing, cleared, inaccessible, or non-image input paths return
  `input_image_unavailable` before any provider call, with instructions to use an
  existing path, regenerate the image, or remove `image_paths`.
- A provider-qualified model selects that exact provider/model pair. An
  unqualified model id may be used only when the enabled image model catalog can
  resolve it deterministically.
- Disabled or uncredentialed providers are never candidates.
- Provider-specific options are validated before the provider call when Tenon can
  know that the option cannot be sent. Unsupported options return
  `unsupported_option` with recovery instructions. OpenAI GPT image models do not
  use the legacy `response_format` option. GPT Image 2 accepts `auto` or
  constrained `WIDTHxHEIGHT` sizes: both edges at most 3840px, both edges
  multiples of 16px, long-edge/short-edge ratio at most 3:1, and total pixels
  from 655,360 through 8,294,400. GPT Image 2 rejects
  `background: "transparent"`; use `auto`/`opaque` or select a model that
  supports transparent backgrounds. Older Tenon-owned OpenAI GPT image entries
  accept only `auto`, `1024x1024`, `1024x1536`, and `1536x1024` sizes.
- Provider quota and rate-limit failures return `rate_limited` with instructions
  not to retry immediately. OpenAI image calls disable the SDK's default automatic
  retries so one tool call maps to one provider request unless the user or agent
  explicitly tries again.

Generated images are written to an app-owned local generated-image directory
under the agent scratch root, with short scratch-relative paths such as
`generated-images/<run>/<image>.png` returned to the model. The model-visible JSON
includes only local paths, embeddable Markdown image strings (`markdownImage`),
mime types, byte lengths, and dimensions when known; it does not include
provider/model execution metadata or base64 image bytes. The complete runtime
details retain provider/model metadata and the generated image path list while
the tool call is live. The persisted `tool_result.created.details` field is a
slim render projection for `generate_image` only: provider id, model id/name, and
per-image path/Markdown/mime/byte/dimension metadata. Generic tool runtime
envelopes, raw provider payloads, prompt text, file contents, original file
contents, and base64 image bytes are not persisted in event details. The tool
result does not embed raw image bytes or image content blocks; follow-up edits
pass the returned `path` or `markdownImage` back through `image_paths`, and
explicit inspection can use the normal local file tools. Generated-image input
paths resolve through realpath containment under the scratch
`generated-images/` directory, so a symlink inside scratch cannot make the tool
read outside that directory. The renderer reads generated image paths from the
persisted details and displays them inline as lazy-loaded previews through the
local preview byte reader; opening the preview targets the returned local-file
path. If the file has been cleared or manually removed, the preview remains in
place and shows an unavailable-image placeholder.

When the user should see generated images in the final response, the assistant
places each returned `markdownImage` exactly where that image belongs:

```md
![short description](file:^generated-images%2Frun%2Fimage.png)
```

This keeps the display syntax as ordinary Markdown image syntax while reusing the
same `file:` local-file target vocabulary and percent-escaping as file reference
markers. The `path` field remains the unencoded short path for follow-up
`image_paths`; the returned `markdownImage` uses the encoded `file:^...` target.
The Markdown image position is authoritative for mixed text/image answers. The
image renderer still loads bytes through the trusted local preview bridge rather
than directly loading `file:` URLs.

Runtime details:

```ts
interface GenerateImageData {
  providerId: string;
  modelId: string;
  modelName: string;
  images: Array<{
    path: string;
    markdownImage: string;
    mimeType: string;
    byteLength: number;
    width?: number;
    height?: number;
  }>;
  text: string[];
  promptPreview: string;
}
```

Model-visible `data`:

```ts
interface GenerateImageVisibleData {
  images: Array<{
    path: string;
    markdownImage: string;
    mimeType: string;
    byteLength: number;
    width?: number;
    height?: number;
  }>;
  text?: string[];
}
```

`generate_image` does not automatically insert the image into the outline. If
the user asks for a file or document insertion, the agent must use the normal
file or node tools after the image result exists.

## Import Pack CLI/API

Bulk cleaned-data import is a Tenon-owned CLI/API workflow, not a default
model-visible tool. `/data-cleanup` and future local clients produce an Import
Pack v1 JSON file, validate it, generate a preview report, run
`tenon-import preview`, show the returned stats/warnings/preview id to the user,
and only then run `tenon-import commit --preview-id <preview:id>` after user
approval.

Canonical CLI surface:

```bash
tenon-import inspect <source> --out <profile.json>
tenon-import tana <tana-export.json> --out <pack.json> --coverage-out <coverage.json> [--fidelity content|clean|full]
tenon-import validate <pack.json> [--out <report.json>]
tenon-import preview <pack.json> --out <preview.md> [--parent-id <node-id>] [--json]
tenon-import commit <pack.json> --preview-id <preview:id> [--parent-id <node-id>] [--json]
```

`preview` and `commit` call a local app-owned import API exposed by the running
main process. The CLI sends bounded Import Pack JSON content to the API; the API
does not accept arbitrary filesystem paths. If the app API is unavailable,
`preview` and `commit` fail with structured `app_unavailable` output unless
`preview` is explicitly run with the offline preview flag. `commit` is API-backed
only and never writes Tenon storage directly.

The import service revalidates the pack at preview and commit time. Preview ids
bind to pack hash, destination, and mode; they expire after a short window and
are single-use. `tenon-import commit` is audited as an `outline.edit`
consequence and records operation history with `tool: "tenon-import"`.

Import Pack v1 is import-service data, not core document state:

```ts
interface ImportPack {
  version: 1;
  source: { kind: string; path: string; sourceId?: string };
  options: {
    fidelity: "content" | "clean" | "full";
    dateGrouping: "stage_headings" | "none";
    tags: boolean;
    fields: "omit" | "text_children" | "field_rows";
    doneState: boolean;
  };
  stats: ImportStats;
  coverage: ImportCoverage;
  warnings: ImportWarning[];
  sections: ImportSection[];
}
```

`coverage.imported + coverage.merged + coverage.dropped +
coverage.unsupported + coverage.empty` must equal `stats.sourceRecords`, and
`coverage.unaccounted` must be `0`. Known adapters should also write a coverage
sidecar with one source id per source record so no source item is silently
omitted or duplicated. The import service rejects malformed stats, invalid
coverage, oversized packs, and invalid destinations before mutation.

Successful non-dry-run imports create one explicit staging root
(`Import: <source-name>`) under the destination and then materialize section
headings and imported nodes below it. Hosts that support the internal
yield-aware tree materializer use it instead of routing import through a long
series of normal document commands: node creation, Loro commits, and search-index
refresh are chunked with event-loop breaks while remaining one logical import
operation. The import is still grouped as a single agent undo step and a single
operation-history entry. Fallback hosts may use `create_nodes_from_tree`, which
has the same document shape but not the cooperative scheduling guarantees.

The bulk materializer includes imported descriptions directly on created nodes,
so the import is not followed by a long series of per-node description edits.
Post-import verification reads the created staging subtree and compares section,
node, description, tag, field, and checked counts against the pack. A mismatch
returns `verification_failed` with the created ids and recovery instructions
rather than reporting success.

## Tool Description Style

Tool descriptions and parameter descriptions are part of the agent prompt. They
should be written as operational guidance, not as implementation notes:

- Say when to use the tool and when to use a neighboring tool instead.
- Describe the exact model-facing input contract, including defaults and
  pagination/preview behavior.
- Keep wording close to proven references: nodex for `node_*`, dedicated local
  file/bash tools, and a search/fetch split for `web_*`.
- Avoid exposing internal implementation details unless the model must act on
  them, such as `%%node:id%%` markers, `operation_id` guards, or `nextOffset`.
- State each grammar rule once across a tool description and its parameter
  descriptions. Do not embed the same operator guide or outline manual in both.
- Keep each tool's required output-handle and final-answer guidance self-contained;
  strict `allowedTools` can expose one tool without neighboring tool descriptions.
- Do not promise capabilities that are not implemented.

## Tool Result Layers

Tool results have three separate audiences:

- pi-agent-core result: every tool `execute` returns native
  `AgentToolResult<T>` with `content`, `details`, and optional `terminate`.
- Runtime envelope: Lin stores the common envelope in `details` for status,
  metrics, debugging, permissions, UI rendering, export, and tests.
- Model-visible result: the smallest stable protocol the agent needs for the
  next action.
- UI detail view: optional rich rendering derived from `details`, not from the
  model-visible text.

Lin error envelopes (`ok: false`) are converted in the shared `afterToolCall`
adapter to pi-agent-core's native `ToolResultMessage.isError = true`. Tools
should not invent a separate `isError` field inside `AgentToolResult`.

Do not expose the runtime envelope as the node tools' model-facing contract.
The agent should see an action protocol, not a trimmed copy of implementation
state.

```ts
interface ToolResult<TData = unknown> {
  ok: boolean;
  tool: string;
  version: 1;
  status: "success" | "partial" | "unchanged" | "denied" | "error";
  data?: TData;
  error?: ToolError;
  operation?: OperationResult;
  preview?: ToolPreview;
  validation?: ValidationReport;
  boundary?: string;
  instructions?: string;
  warnings?: string[];
  pagination?: Pagination;
  metrics?: ToolMetrics;
}

interface ToolError {
  code: string;
  message: string;
  recoverable: boolean;
  details?: unknown;
}

interface OperationResult {
  operationId: string;
  undoGroupId?: string;
  origin: "agent" | "user" | "system";
  action: string;
  affectedNodeIds?: string[];
  affectedPaths?: string[];
  affectedRevisions?: Record<string, string>;
  summary: string;
}

interface Pagination {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

interface ToolMetrics {
  durationMs?: number;
  truncated?: boolean;
  outputBytes?: number;
}
```

### Model-visible redundancy rule

The model-visible projection carries **only what the model cannot cheaply derive**
from its own call plus the rest of the payload. The full runtime envelope stays in
`details`. Across **every** tool, the shared `modelVisibleEnvelope` / node
visible-result builders apply these cuts:

- **No `tool`.** The model already knows which tool it called (tool-call
  correlation).
- **`status` only when informative.** `success` merely restates `ok: true` and
  `error` merely restates `ok: false` + the `error` object, so both are omitted;
  only `unchanged` / `partial` / `denied` are shown.
- **`error` is `{ code, message }`.** `recoverable` is a constant `true` and is
  dropped from the visible projection (kept on `details`).

A field is otherwise redundant — and cut — when it is a discriminant derivable
from the tool + args (`kind`, `action`, `mode`, file-read `type`), a count equal
to a sibling array's length (`returned_items`, `numLines`, `message_count`), an
echo of an input arg (`task_id`, `anchor_message_id`, `replaceAll`), a constant
(`userModified`), an internal path (pdf `outputDir`), or a cross-field duplicate
  (tool-envelope error `code`/`message` already in `error`; notebook `cells` vs the
rendered `content`). `data` is omitted from the visible envelope whenever
`modelData` is `undefined` (the default) — the safe path is the natural one, so
there is no sentinel and no accidental fallback to the full runtime payload. To
show the model a slim projection, pass it; to echo `envelope.data` in full, pass
it explicitly.

All tools — `node_*` included — project through one shared
`modelVisibleEnvelope`, keeping `details` untouched. A tool-specific projection
may omit a runtime instruction that is already represented structurally in the
visible data; the original instruction remains in `details`. The model-visible
shape is:

```ts
interface ModelVisibleToolEnvelope {
  ok: boolean;
  status?: "partial" | "unchanged" | "denied"; // omitted for success/error
  instructions?: string;
  data?: NodeVisibleResult; // any tool's slim projection
  error?: { code: string; message: string };
  warnings?: string[];
}

type NodeVisibleResult =
  | NodeVisibleReadResult
  | NodeVisibleSearchResult
  | NodeVisibleCountResult
  | NodeVisibleBatchCountResult
  | NodeVisibleMutationResult;

// The result kind is no longer carried in the payload — it is implied by
// `envelope.tool` plus the caller's arguments. Static tool-use rules live in the
// always-present tool schema rather than being repeated in every success result.
interface NodeVisibleReadResult {
  outline?: string;
  definitions?: NodeDefinitionRead[];
  page?: NodeVisiblePage;
}

interface NodeVisibleSearchResult {
  outline?: string;
  total: number;
  next_offset?: number;
}

// `kind`/`action`/`status` dropped: the tool name implies the operation, and the
// model derives preview from its own `preview_only` arg.
interface NodeVisibleMutationResult {
  changes?: NodeVisibleChanges;
  outline?: string;
  revisions?: Record<string, string>;
}

interface NodeVisibleCountResult {
  total: number;
}

interface NodeVisibleBatchCountResult {
  counts: Record<string, number>;
}

interface NodeVisibleChanges {
  created?: string[];
  updated?: string[];
  moved?: string[];
  trashed?: string[];
  restored?: string[];
}

interface NodeVisiblePage {
  total: number;
  offset: number;
  limit: number;
  next_offset?: number;
}
```

Rules:

- `outline` is the single model-visible representation for read/search results.
  It is an annotated outline: `%%node:id%%` is protocol metadata, not node text.
- Read/search results do not return a parallel `references[]` array. The outline
  already carries each current title and exact id. Final answers use
  `[[node:^exact-id]]`; the renderer resolves the current title.
- Single search results carry `total` once and `next_offset` only when another
  page exists. Count-only results carry only `total`; they do not echo offset,
  limit, or a nested page object. Runtime `details.instructions` retains the
  existing continuation message for compatibility and debugging; the visible
  result omits that prose because `next_offset` carries the same action.
- Mutating tools return a fresh annotated `outline` when that is useful for
  follow-up edits. When a fresh outline is present, model-visible `changes` may
  be omitted because the ids are already visible in the outline; the full
  mutation lists remain in `details`.
- Mutating tools return `changes` when there is no useful outline projection.
- Full structured payloads such as `NodeReadItem`, `NodeSearchItem`,
  `beforeOutline`, `afterOutline`, and raw preview details remain available in
  `details`.
- `summary` is not part of the model-visible node protocol. Human-facing summary
  text belongs in UI rendering or `details`.

Dynamic guidance is first-class:

- `instructions`: the current state, recommended next action, boundary, and
  recovery guidance in one field.

Use `instructions` for unknown tags, unresolved fields, permission denials,
dynamic recovery, and ambiguous targets. Successful node results do not repeat
static rules about edit markers, final-answer references, previews, count mode,
pagination parameters, or Trash semantics; those rules live in the tool schema.
Runtime-only compatibility guidance may remain in `details` when the visible
projection already expresses the action structurally. No-op mutations use the
informative visible `status: "unchanged"` instead of a prose restatement.

`ToolPreview` and `ValidationReport` are defined in the TypeScript parser section
because they are produced by the mutation planner, but they belong in the common
envelope for every previewable mutating tool.

## Error Handling

Tools should return a normal `ToolResult` with `status: "error"` rather than
throwing through the agent loop, except for adapter bugs or runtime crashes.

Example:

```json
{
  "ok": false,
  "tool": "node_edit",
  "version": 1,
  "status": "error",
  "error": {
    "code": "node_not_found",
    "message": "Node not found: node_123",
    "recoverable": true
  },
  "instructions": "Use node_search or node_read on the parent context to find the correct node id. The node id may be stale after a delete, restore, or undo."
}
```

This is the runtime `ToolResult` (kept in `details`). Its model-visible
projection is slimmer per the redundancy rule above — no `tool`, no
`version`, no `status` (`error` is implied by `ok: false`), and `error` is
`{ code, message }`:

```json
{
  "ok": false,
  "error": { "code": "node_not_found", "message": "Node not found: node_123" },
  "instructions": "Use node_search or node_read on the parent context to find the correct node id. The node id may be stale after a delete, restore, or undo."
}
```

## Node Tool Contract

Node tools use the compact nodex-style surface, but Lin does not expose nodex's
incremental `text` edit contract. Lin uses one outline grammar for creation,
reading, and text replacement edits. Read/search results are annotated with
`%%node:id%%` markers so ids and content are not returned in two parallel
structures:

- `node_create.outline` inserts new structure.
- `node_read(...)` serializes existing structure as annotated outline.
- `node_edit.old_string/new_string` edits the target node's single-node editable
  outline by exact string replacement, then TypeScript parses and applies the
  result without treating omitted children, fields, or values as delete intent.
  For the target root line only, the leading `%%node:id%%` marker may be omitted
  because the `node_id` parameter already names that node.

`%%node:id%%` is the only agent-visible identity marker. It is protocol metadata,
not node text, and the parser strips it before applying content changes. Do not
embed internal CRDT metadata, timestamps, or other implementation markers in
outline text.

`outline_undo_stack` is a Lin extension over nodex's AI-only `undo` tool. Keep it
separate from the `node_*` tools.

Read/create/edit symmetry:

- `node_read` returns one annotated `outline` for the requested node subtree.
- `node_create` accepts the same content grammar without `%%node:id%%` markers. The
  insertion point is controlled by `parent_id` and `after_id`; omitted `parent_id`
  means today's journal node, not the currently focused UI node.
- `node_edit` targets one existing node by `node_id`, applies exact
  `old_string/new_string` replacement to that node's editable outline (the root
  line, field/value lines, or saved-search config), and then lets TypeScript parse
  the resulting single-node outline. The root line marker is optional in
  `old_string/new_string`; field/value markers remain meaningful and should be
  preserved when editing existing field/value lines.
- Child creation, movement, and deletion are explicit: use `node_create`,
  `node_edit` move, or `node_delete`. Precise child text edits target that child's
  node id directly.

## Lin Outline Format

The Lin Outline Format is a parser-backed text representation for outliner
content. It is used by `node_create`, `node_read`, and `node_edit`. TypeScript
may do fast schema checks, but TypeScript owns parsing, resolution, preview,
validation, and application.

Agent-facing syntax:

```text
- Project Alpha - Q2 customer rollout #project
  - Status:: Active
  - Owner:: [[node:Alice^node_alice]]
  - [ ] Follow up
  - Notes
    - Prepare agenda
  - %%search%% Open tasks %%view:table%%
    - AND
      - HAS_TAG
        - tag:: [[node:#task^node_task_tag]]
      - FIELD_IS
        - field:: [[node:Status^node_status_field]]
        - value:: Open
```

Rules:

- Every non-empty line starts with `- ` after indentation.
- Indentation is exactly 2 spaces per level. Tabs and uneven indentation are an
  error in model-facing output.
- `- title` creates or serializes a node title.
- Markdown inline delimiters in ordinary node text create rich-text marks:
  `**bold**`, `*italic*`, `~~strike~~`, `==highlight==`, inline `` `code` ``,
  and `[label](https://example.com)`.
- Bare `http://`, `https://`, and `www.` URLs in ordinary node text become link
  marks. `www.` hrefs normalize to `https://`; trailing sentence punctuation and
  unmatched closing delimiters remain outside the link. Link clicks still use the
  existing safe external-navigation path and do not expand its scheme allowlist.
- Explicit Markdown link destinations accept balanced or backslash-escaped
  parentheses. Canonical serialization escapes destination backslashes and
  parentheses, so `node_read` output reused by `node_create`, `node_edit`, or
  `duplicate_id` preserves the complete href.
- Complete Markdown links, inline code, reference markers, bare URLs, and
  backslash-escaped tokens are protected from tag and field harvesting. A
  grammar-shaped token in one of those ranges remains literal.
- `- title - description` sets a node description. The first ` - ` separates
  title from description; later ` - ` text stays in the description.
- Ordinary notes, task details, meeting notes, and explanatory body text should
  be written as child nodes. Use descriptions only when the user explicitly asks
  for a node description/caption, when preserving an existing description, or
  when importing external metadata that belongs in the node description.
- `#tag`, `#中文`, `[[#tag]]`, and `#[[multi word tag]]` apply tags. Bracket
  tag names accept raw backslashes; serializers escape `]`, backslash, and
  newline-style characters as `\]`, `\\`, `\n`, `\r`, and `\t` for names that
  cannot be written bare.
- Tags are durable categorization, not decoration. Use them when the user asks
  for a tag, when preserving existing tags, or when a stable category is needed
  for filtering/search; ordinary grouping belongs in child structure.
- Bare CSS hex colors such as `#fff`, `#ffff`, `#112233`, and `#112233ff`
  are color text, not tags. Use explicit bracket syntax such as `#[[fff]]` if a
  tag name intentionally looks like a hex color.
- `[ ]`, `[x]`, and `[X]` at the start of a node set checkbox state when the
  marker is alone or followed by whitespace; `[x]title` stays literal text.
- Checkbox markers are task state. Use them for actionable todos/checklists, not
  for ordinary bullets.
- `Field:: value` sets a single field value.
- `Field::` followed by indented value lines sets a multi-value field.
- `Field::` without values is a clear request; `node_edit` preserves existing
  values and returns a warning. Delete field entries or value nodes explicitly
  with `node_delete`.
- Field syntax creates or updates structured data. Use fields when the user asks
  for structured properties, when preserving existing fields, or when the data
  must be filterable/sortable; ordinary notes belong in child nodes.
- Semantic field writes resolve before creating anything. Resolution order is:
  the target owner has exactly one active field entry with that normalized display
  name; a writable system field such as `Done` / `sys:done`; exactly one active
  user field definition with that normalized display name; otherwise a new user
  field definition. Matching trims outer whitespace, collapses internal
  whitespace, case-folds, and ignores trashed entries/definitions.
- Existing field types win. Reused `plain`, `url`, `date`, `number`, `email`,
  `checkbox`, `options`, and `options_from_supertag` definitions keep their
  stored type/config, and values are validated against that type before
  mutation. Plain fields accept text, inline references, whole-row reference
  values, or a mixture.
- Reused `options` fields use option semantics: text values select an existing
  option by name when present and otherwise collect a local option value; node
  reference values select that exact option node. Reused `options_from_supertag`
  fields require node reference values and core validates that the target node
  belongs to the configured source supertag.
- New field definitions use conservative inference only: node-reference values
  remain values under `plain`; canonical date values become `date`; finite numbers become
  `number`; URL-shaped text becomes `url`; email-shaped text becomes `email`;
  `true` / `false` become `checkbox`; everything else becomes `plain`. Outline
  parsing never infers `options` or `options_from_supertag`.
- Ambiguous field writes fail closed. Multiple active owner entries with the same
  normalized display name, or multiple active global field definitions with that
  name and no owner entry to disambiguate, return an error with the relevant ids
  instead of creating another field.
- `Done:: true` and `Done:: false` write the node's completion state through the
  `sys:done` system field. Other system fields such as `Created`, `Last edited`,
  `Tags`, `References`, `Owner`, and `Day` are read-only through field syntax;
  use the normal outline syntax for tags, references, and date placement.
- Date field values use the canonical date field language from
  `docs/spec/date-field-values.md`: `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`, or
  `start/end` with `/`, for example `2026-05-20/2026-05-24`. Tool prompts and
  search query operands must not teach `..` or other date range syntax.
- Whole-line `[[node:Display^...]]` creates a reference node, including a
  reference-valued child when the line is under a plain field.
- Inline `[[node:Display^...]]` creates an inline reference inside node text or a
  field value.
- A line whose title is a Markdown code fence, for example `- \`\`\`ts`,
  followed by raw code lines and a closing fence line creates or serializes a
  `codeBlock` node. Backtick and tilde fences may use three or more repeated
  characters, so serialized code blocks can choose a fence longer than any fence
  run in the body. The language token is normalized through the same alias table
  used by user paste (`ts` → `typescript`, `py` → `python`, etc.). Code body
  lines are raw text and do not need `- ` prefixes. Agent outline code fences are
  strict: an opening fence without a closing fence is a parse error, not a
  partial code block.
- Date nodes are referenced by id with `[[node:Display^...]]`; date shortcut
  syntax is not part of the model-facing outline contract yet.
- `%%search%%` turns the node into a search node. In `node_create` this creates a
  saved search node; in `node_search` it is a temporary search node that is only
  executed and rendered.
- Saved search nodes are user-visible views. Prefer `node_search` for temporary
  lookup; create `%%search%%` nodes only when the user asks to keep a search/view.
- A search node must contain exactly one query root child. `AND`, `OR`, and
  `NOT` are query group nodes and may be nested. QueryOp names such as
  `STRING_MATCH`, `HAS_TAG`, `LINKS_TO`, `FIELD_IS`, `LT`, and `DATE_OVERLAPS`
  are rule nodes. Rule operands are represented with `field::`, `tag::`,
  `target::`, `value::`, or `operand::` lines under the rule. `field`, `tag`,
  and `target` operands must be exact node references or ids.
- `%%view:table%%`, `%%view:list%%`, `%%view:cards%%`, and similar directives set
  view presentation for nodes that support views.
- `node_create` materializes supported inline Markdown marks and code fences.
  `node_read` serializes those marks and code blocks back to the same outline
  form so later agent turns can preserve them.
- `node_read` backslash-escapes grammar-significant literal text, including tag,
  field, checkbox, search/view, annotation, reference, Markdown-mark, and
  description-separator shapes. `node_create` and `node_edit` decode those
  escapes, so read-then-write does not accidentally create semantics.

Runtime compatibility:

- Tool descriptions should teach only the canonical format above.
- TypeScript may accept copied list text, missing bullets, tabs, or other paste
  variants through a compatibility normalizer.
- Compatibility normalization is not a prompt contract. If normalization changes
  meaning or cannot be made deterministic, return a parse error with line and
  column guidance.

Parser AST:

```ts
interface OutlineDocument {
  roots: OutlineNode[];
}

interface OutlineNode {
  title: string;
  description?: string | null;
  tags: TagRef[];
  checked?: boolean | null;
  fields: OutlineField[];
  children: OutlineNode[];
  refs: InlineRef[];
  directives: OutlineDirective[];
  sourceSpan: SourceSpan;
}

interface OutlineField {
  name: string;
  values: OutlineValue[];
  clear: boolean;
  sourceSpan: SourceSpan;
}

interface OutlineValue {
  text: string;
  refs: InlineRef[];
  targetId?: string;
  date?: string;
  sourceSpan: SourceSpan;
}

interface TagRef {
  name: string;
  targetId?: string;
}

type ReferenceTarget =
  | { kind: "node"; nodeId: string }
  | { kind: "local-file"; path: string; entryKind: "file" | "directory" };

interface InlineRef {
  display: string;
  target: ReferenceTarget;
  offset?: number;
  mimeType?: string;
  sizeBytes?: number;
}

interface OutlineDirective {
  kind: "search" | "view" | "code" | "image";
  value?: string;
  args?: Record<string, string>;
}

interface SourceSpan {
  line: number;
  column: number;
  length: number;
}
```

Shared outliner type names used below:

```ts
type NodeKind =
  | "node"
  | "fieldEntry"
  | "reference"
  | "codeBlock"
  | "image"
  | "embed"
  | "tagDef"
  | "fieldDef"
  | "viewDef"
  | "sortRule"
  | "search"
  | "queryCondition"
  | "date";

type FieldType =
  | "plain"
  | "options"
  | "options_from_supertag"
  | "date"
  | "number"
  | "url"
  | "email"
  | "checkbox";
```

### Resolution

Resolution happens after parsing and before preview.

Tags:

1. Trim, remove a leading `#`, and case-fold.
2. Match exact display name.
3. Optionally fuzzy match above a conservative threshold.
4. If policy allows, auto-create the tag definition.
5. Otherwise report `unresolvedTags`.

Fields:

1. Resolve fields available from the node's applied tags.
2. Match exact display name.
3. Optionally fuzzy match above a conservative threshold.
4. If the node has at least one tag and policy allows, create the field
   definition under the first tag.
5. Otherwise report `unresolvedFields`.

Field type inference:

- `date`, `deadline`, `due`, `start`, `end`, etc. -> `date`
- `url`, `link`, `website`, or `http(s)://` values -> `url`
- `email` or email-shaped values -> `email`
- `count`, `number`, `amount`, `price`, `qty`, etc. -> `number`
- otherwise -> `options`

References:

- `[[node:Display^...]]` requires the target id to exist and the target must not be in
  Trash.
- Date references use normal node references to existing date node ids.
- Search query operands use explicit node references or exact ids for `field::`,
  `tag::`, and `target::`.

## Outliner Tools

### `node_search`

Execute a temporary or saved search node. Use this to locate nodes before
editing and to render temporary search results without creating a real node.
`node_search.outline` uses the same search-node outline shape that
`node_create.outline` would use to create a saved search node.
Date query operands use the same canonical date field value language as
stored date fields.
The canonical query grammar is specified in `docs/spec/search-query-grammar.md`.

Parameters:

```ts
interface NodeSearchParams {
  outline?: string;
  search_node_id?: string;
  limit?: number; // default 20, max 50
  offset?: number;
  count?: boolean;
  common_query?: string;
  queries?: Array<{
    name: string;
    query: string;
  }>;
}
```

Single mode requires exactly one of `outline` and `search_node_id`. Batch count
mode requires `count: true` plus `queries`, may include `common_query`, and cannot
include `outline`, `search_node_id`, `limit`, or `offset`.

Return data:

```ts
interface NodeSearchData {
  source: "temporary" | "saved";
  title?: string;
  view?: string;
  searchNodeId?: string;
  outline?: string;
  total: number;
  offset: number;
  limit: number;
  items?: NodeSearchItem[];
}

interface NodeSearchItem {
  nodeId: string;
  title: string;
  description?: string | null;
  type: NodeKind;
  tags: string[];
  snippet: string;
  parent?: { nodeId: string; title: string } | null;
  fields: Record<string, string | string[]>;
  checked?: boolean | null;
  hasChildren: boolean;
  childCount: number;
  updatedAt: string;
}

interface NodeSearchBatchCountData {
  commonQuery?: SearchQueryExpr;
  results: Array<{
    name: string;
    query: SearchQueryExpr;
    total: number;
    durationMs: number;
  }>;
}
```

Result behavior:

- `outline` is a temporary search node and does not mutate document state.
- Use this temporary path for lookup by default. Do not create a saved search node
  unless the user explicitly asks to save the query/view.
- The outline must parse as one `%%search%%` root with exactly one query root
  child.
- Keyword search is represented as a `STRING_MATCH` rule, for example
  `- %%search%% 成都天气\n  - STRING_MATCH\n    - value:: 成都天气`. There is no
  separate single-search `query` parameter.
- Batch count mode accepts 1-20 uniquely named `queries`. `common_query` and
  every `queries[].query` contain exactly one canonical query rule/group root
  without a `%%search%%` or `%%view:*%%` wrapper. The runtime parses them through
  the same query-expression resolver used by full search outlines and combines
  each item as `AND(common_query, item.query)` when a common query exists.
- The complete batch is parsed, resolved, and semantically validated before the
  runtime reads the host text index, obtains personal-access ranking options, or
  executes any query. The shared core validator applies the same regular
  expression, date, scalar, and context-dependent operand rules as execution. An
  invalid common fragment, item fragment, operand reference, semantic operand,
  duplicate name, or mixed single/batch parameter set fails the whole call;
  batch results are never partial. Each query's matches pass through the same
  run-scope result filter as single searches before its total is counted.
- The root title is returned as `title` and may be used for temporary UI display.
- `%%view:table%%`, `%%view:list%%`, `%%view:cards%%`, and similar directives are
  returned as `view` and drive temporary result presentation.
- Child lines are the canonical query tree used by saved search nodes. Group
  nodes are `AND`, `OR`, and `NOT`; rule nodes are QueryOp names. Rule operands
  use `field::`, `tag::`, `target::`, `value::`, or `operand::`.
- Invalid, missing, trashed, or wrong-type operand references are errors. The
  tool does not silently drop unresolved structured conditions.
- `search_node_id` executes an existing saved search node.
- Positive `STRING_MATCH` searches use the shared derived text index when the
  host exposes it. The index improves candidate generation and relevance order;
  the structured search evaluator remains the final correctness check.
- Text relevance ranks exact title matches, title prefixes, phrases, all-term
  matches, tag labels, field names, and field values through the same core
  relevance kernel used by saved search refresh.
- Default relevance includes a capped document-derived reference-authority boost
  from distinct linked inbound source nodes. A search node can also explicitly
  sort by the References system field (`sys:refCount`), where the displayed
  reference count is primary and relevance is the tie-breaker.
- `node_search` is a transient lookup surface and may apply per-user personal
  access ranking after text relevance when no explicit sort rule is present. This
  ranking is off-document state; it is not a search-node rule and does not change
  saved search materialization.
- When `count` is false, only the returned page of `items` records weak
  `agentRecall` access for those node ids. `count: true` records nothing, and
  candidates beyond the returned page are never recorded. Batch count mode also
  records no access signal.
- Subtree restriction, parent restriction, backlink search, and relationship
  filters should be represented as search conditions in the outline, not as
  separate tool parameters.
- Model-visible search results return one annotated outline of matches, not
  separate `matches`, `refs`, or `references` arrays. They carry `total` and an
  optional `next_offset` directly.
- Single `count: true` returns only `data.total`. Batch count mode returns only
  `data.counts`, keyed by the caller's unique query names.

Examples:

```json
{
  "outline": "- %%search%% 成都天气 %%view:list%%\n  - STRING_MATCH\n    - value:: 成都天气"
}
```

```json
{
  "outline": "- %%search%% 今日开放任务 %%view:table%%\n  - AND\n    - HAS_TAG\n      - tag:: [[node:#task^node_task_tag]]\n    - FIELD_IS\n      - field:: [[node:Status^node_status_field]]\n      - value:: Open",
  "limit": 20
}
```

```json
{
  "search_node_id": "node_saved_search"
}
```

```json
{
  "count": true,
  "common_query": "- DESCENDANT_OF\n  - target:: node:feed-root",
  "queries": [
    {
      "name": "author_text",
      "query": "- STRING_MATCH\n  - value:: Author::"
    },
    {
      "name": "author_field",
      "query": "- FIELD_IS_SET\n  - field:: field:author"
    }
  ]
}
```

### `node_read`

Read nodes as structured data in `details` and as annotated Lin Outline Format
for the model-visible result. The outline carries `%%node:id%%` markers so the
agent has one source of truth for both content and ids.

Parameters:

```ts
interface NodeReadParams {
  node_id?: string; // default: today's journal node
  node_ids?: string[];
  depth?: number; // 0 = node only, default 1, max 3
  child_offset?: number;
  child_limit?: number; // default 20, max 50
  include_deleted?: boolean;
  include_backlinks?: boolean;
}
```

Return data:

```ts
interface NodeReadData {
  items: NodeReadItem[];
}

interface NodeReadItem {
  nodeId: string;
  type: NodeKind;
  title: string;
  description?: string | null;
  tags: string[];
  fields: NodeFieldRead[];
  checked?: boolean | null;
  parent?: { nodeId: string; title: string } | null;
  breadcrumb: Array<{ nodeId: string; title: string }>;
  children: ChildrenPage;
  backlinks?: NodeBacklink[];
  revision: string;
  outline?: string;
}

interface NodeFieldRead {
  name: string;
  type: FieldType | string;
  values: Array<{
    text: string;
    valueNodeId?: string;
    targetId?: string;
  }>;
  fieldEntryId: string;
  options?: string[];
}

interface ChildrenPage {
  total: number;
  offset: number;
  limit: number;
  items: NodeChildSummary[];
}

interface NodeChildSummary {
  nodeId: string;
  title: string;
  type: NodeKind;
  tags: string[];
  checked?: boolean | null;
  hasChildren: boolean;
  childCount: number;
  isReference?: boolean;
  targetId?: string;
  children?: ChildrenPage;
}

interface NodeBacklink {
  sourceNodeId: string;
  sourceTitle: string;
  kind: "tree" | "inline" | "field";
  snippet?: string;
}
```

`revision` is the editable-outline revision for this root, not just the root
node's scalar timestamp. It changes when the root line, field entry/value lines,
or saved-search config that `node_edit` can rewrite changes. `expected_revision`
therefore protects whole editable-outline replacement from overwriting newer
field/value edits.

Result behavior:

- Omitted `node_id` reads today's journal node.
- Use either `node_id` or `node_ids`, not both. If both are omitted, read today's
  journal node.
- `node_ids` returns multiple independent `items`.
- Model-visible output contains one annotated outline. Full structured
  `NodeReadItem` data remains available in `details`.
- `outline` serializes the requested node and bounded descendants using the same
  content grammar accepted by `node_create` and `node_edit`, plus agent-only
  `%%node:id%%` markers.
- `%%node:id%%` markers are not node text. Preserve markers for existing nodes
  when editing; omit markers for newly created lines.
- Field entries and field values are serialized on separate lines in annotated
  output so both the field entry id and value node ids can be represented.
- Tag and field definition nodes include structured `definition.config` data in
  `node_read` details and model-visible `definitions`. Config rows are internal
  `defConfig` children; agents change them through `node_edit` operation
  `configure_definition`, not by editing those locked child rows directly.
- If children are truncated, return pagination and do not serialize hidden
  children into `outline`.
- To edit a child precisely, copy the child line with its `%%node:id%%` marker or
  call `node_edit` directly on that child id.

### `node_create`

Create new outliner content under a parent. The normal path is `outline`, which
may create one node, many sibling nodes, or a full subtree. Reference creation
and subtree duplication are explicit shortcuts because they depend on exact ids.

Parameters:

```ts
interface NodeCreateParams {
  parent_id?: string; // default: today's journal node
  after_id?: string | null; // null = first child; omitted = last child
  outline?: string;
  target_id?: string; // create one reference node to this target
  duplicate_id?: string; // deep-copy this subtree
  definition?: {
    kind: "field" | "tag";
    name: string;
    config?: FieldConfigPatch | TagConfigPatch;
  };
  preview_only?: boolean;
}
```

Exactly one of `outline`, `target_id`, `duplicate_id`, and `definition` is
required.

Return data:

```ts
interface NodeCreateData {
  parentId: string;
  afterId?: string | null;
  createdRootIds: string[];
  createdNodeIds: string[];
  createdFieldEntryIds?: string[];
  createdTagIds?: string[];
  createdFieldDefIds?: string[];
  matchedNodeIds?: string[];
  duplicatedFrom?: string;
  targetId?: string;
  definition?: NodeDefinitionMutation;
  outline?: string;
}
```

Result behavior:

- If `after_id` is provided without `parent_id`, the parent is `after_id`'s parent.
- If both are provided, `after_id` must be a child of `parent_id`.
- If `outline` has multiple root lines, the first root is inserted at the
  requested position and following roots are inserted after the previous root.
- Top-level `Field:: value` lines in `node_create.outline` write structured
  fields onto `parent_id` itself and do not create root nodes. Indented
  `Field::` lines under a created node write fields onto that created node.
- `target_id` creates one reference node at the requested position.
- `duplicate_id` deep-copies the source subtree at the requested position.
- `definition` creates a tag or field definition under Schema. Same-name active
  definitions are returned unchanged in `matchedNodeIds`; creation does not
  opportunistically modify existing definition config.
- Normal user-authored detail belongs in child nodes, not in node descriptions.
- Normal user-authored detail also belongs in child nodes rather than fields,
  tags, saved searches, or checkboxes unless the user clearly asks for those
  structured affordances.
- Missing normal node tags and fields may be created by the outline application
  layer. Search-node `field::`, `tag::`, and `target::` operands must reference
  existing nodes.
- Search/view directives, normal tag/field annotations, references,
  descriptions, checkboxes, and field values come through `outline`; standalone
  tag/field definition nodes use `definition`.
- `node_create.outline` must not contain `%%node:id%%` markers. Those markers are
  only emitted by read/search results and accepted by edit replacements.
- After apply, model-visible data returns a fresh annotated `outline` for the
  created roots.
- The `node_create` tool description independently identifies those
  `%%node:id%%` markers as edit handles and tells the model to use
  `[[node:^exact-id]]` in final answers. This guidance cannot depend on
  `node_read`, `node_search`, or `node_edit` also being present in the tool catalog.
- Reference targets must exist and must not be in Trash.
- `preview_only: true` returns preview and validation without applying.

Example:

```json
{
  "outline": "- Project Alpha #project\n  - Status:: Active\n  - Q2 rollout\n  - [ ] Draft plan"
}
```

### `node_edit`

Edit existing outliner content. The content edit path uses exact
replacement: read the node, copy an exact fragment from the returned annotated
outline, and replace it with a new annotated fragment.

Parameters:

```ts
type NodeEditParams =
  | NodeOutlineEditParams
  | NodeMoveParams
  | NodeMergeParams
  | NodeReferenceReplaceParams
  | NodeDefinitionConfigParams
  | NodeFieldDefinitionReuseParams
  | NodeDefinitionMergeParams;

interface NodeOutlineEditParams {
  operation: "replace_outline";
  node_id: string;
  old_string: string; // exact fragment, or "*" for the whole editable outline
  new_string: string;
  expected_revision?: string;
  preview_only?: boolean;
}

interface NodeMoveParams {
  operation: "move";
  node_id?: string;
  node_ids?: string[];
  move: {
    parent_id?: string;
    after_id?: string | null;
    structural_action?: "indent" | "outdent" | "move_up" | "move_down";
  };
  preview_only?: boolean;
}

interface NodeMergeParams {
  operation: "merge";
  node_id: string; // target node
  merge_from_node_ids: string[]; // source nodes
  preview_only?: boolean;
}

interface NodeReferenceReplaceParams {
  operation: "replace_with_reference";
  node_id: string;
  replace_with_reference_to: string;
  preview_only?: boolean;
}

interface NodeDefinitionConfigParams {
  operation: "configure_definition";
  node_id: string; // tagDef or fieldDef
  definition_patch: FieldConfigPatch | TagConfigPatch;
  existing_values?: "validate"; // default
  preview_only?: boolean;
}

interface NodeFieldDefinitionReuseParams {
  operation: "reuse_field_definition";
  node_id: string; // fieldEntry
  target_definition_id: string; // fieldDef or supported sys:* field id
  preview_only?: boolean;
}

interface NodeDefinitionMergeParams {
  operation: "merge_definition";
  node_id: string; // surviving fieldDef or tagDef
  merge_from_node_ids: string[]; // duplicate definitions
  existing_values?: "validate"; // default
  preview_only?: boolean;
}
```

`operation` is the canonical discriminator. Runtime compatibility may infer the
operation from legacy field combinations, but model-facing tool calls should set
`operation` explicitly so the intended edit mode is unambiguous.

Outline edit semantics:

- `old_string` must match exactly once in the current editable outline for
  `node_id`.
- `old_string: "*"` replaces the whole single-node editable outline. Non-preview
  `*` edits require `expected_revision` from `node_read`; preview-only `*` edits
  may omit it because they do not mutate.
- For the target root line only, `old_string` and `new_string` may omit the
  leading `%%node:id%%` marker. TypeScript restores the `node_id` marker before
  matching/applying the replacement.
- The editable outline contains the target node's root line, field entry/value
  lines, and saved-search query lines. It does not include normal child nodes, so
  child omission cannot express deletion.
- `new_string` is not parsed in isolation. The full single-node outline after
  replacement must be valid Lin Outline Format and contain exactly one root line.
- Existing field/value lines should preserve their `%%node:id%%` marker. The
  target root line may omit it because `node_id` already names that node.
  Unmarked field lines resolve through the semantic field write resolver by
  display name; unmarked value lines append values. Omitted fields and values are
  preserved.
- Annotated field value ids can update text in place only when the stored value
  kind stays compatible. Changing a plain value into a reference, a reference into
  text, or a reference target is rejected before mutation; delete the old value id
  and create the replacement value explicitly.
- TypeScript replaces the matched fragment, parses the resulting single-node
  outline, validates it, renders a preview, and then applies it after approval
  when needed.
- The root line maps to `node_id`. If the root would become ambiguous, return an
  error.
- If the root line has a marker, it must match the `node_id` parameter.
- Annotated ids must be unique and must belong to the target node itself, one of
  its field entries, or one of its field values. Moving external nodes should use
  the explicit move form.
- For precise child edits, prefer `node_read` to obtain the child id, then
  call `node_edit` on that child. Do not rely on sibling line numbers.
- If a replacement introduces normal child lines under a non-search node,
  validation rejects it with guidance to use `node_create`, `node_edit` move, or
  `node_delete`.
- Deletion is never represented by omission. Remove nodes, field entries, or field
  value nodes only with `node_delete` by id.

Move semantics:

- `parent_id + after_id` is an absolute move.
- `structural_action` mirrors user operations: indent, outdent, move up, move
  down.
- `node_ids` is allowed only for homogeneous move operations.
- Moving a node under itself or under one of its descendants is invalid.

Merge semantics:

- `node_id` is the target that survives.
- `merge_from_node_ids` are sources whose children, fields, tags, and references
  are merged into the target.
- Target and sources must be ordinary content nodes (`type` absent). Field/tag
  definitions merge only through `merge_definition`; field entries, references,
  saved searches, views, config nodes, and other structural nodes use dedicated
  operations instead of ordinary merge.
- Sources are moved to Trash after merge.
- Source order determines child and field-value append order.
- Target title and position are preserved.
- Matching fields are merged by field display name. If the target already has a
  matching field, source field values move into the target field and the emptied
  source field entry moves to Trash. If the target does not have that field, the
  source field entry moves under the target.
- Merge return data includes those emptied source field entries in
  `trashedNodeIds`, and moved field values or field entries in `movedNodeIds`.
- External tree references to sources are redirected to the target. References
  inside a source subtree are not rewritten during the merge because their parent
  is being moved or trashed as part of the source content.
- Merge cannot be combined with outline edit or move in the same call.

Reference replacement semantics:

- `replace_with_reference_to` replaces the node at `node_id` with a reference node to
  the target at the same parent and position.
- The original node is moved to Trash after the replacement, preserving undo.
- If `node_id` is already a reference, only its target is changed.

Definition config semantics:

- `configure_definition` targets a `tagDef` or `fieldDef` node and writes
  definition config through the same typed core commands the UI uses.
- Field definition patches accept keys such as `field_type`, `source_supertag`,
  `nullable`, `hide_field`, `auto_initialize`, `autocollect_options`,
  `min_value`, and `max_value`.
- Tag definition patches accept keys such as `color`, `extends`,
  `child_supertag`, `show_checkbox`, `done_state_enabled`,
  `done_map_checked`, and `done_map_unchecked`.
- Field type changes validate all active field entries that use the definition.
  Incompatible existing values reject the mutation and return the incompatible
  field entry/value ids in both runtime details and model-visible `data`
  (`definition.validation.incompatibleValues`) so the agent can repair them.
- Agents must not try to edit locked `defConfig` rows with `replace_outline`;
  config rows are internal storage, while definition nodes are the editable
  surface.

Field definition reuse semantics:

- `reuse_field_definition` targets a field entry node and relinks it to an
  existing field definition, matching the UI action of picking an existing field.
- The target definition's type validates the field entry's existing values before
  mutation.
- Core may remove the draft field definition that becomes orphaned after relink;
  model-visible results include only ids still readable after mutation.

Definition merge semantics:

- `merge_definition` is the definition-management merge operation. Ordinary
  `merge` remains content-node merge and must not be used for field/tag
  definitions.
- Target and sources must be active definitions of the same kind: field into
  field, or tag into tag.
- Field definition merge currently requires matching field types. Values are
  still validated against the target type before mutation.
- Options field merge maps source options to target options by label. Missing
  options move under the target field definition; duplicate labels retarget
  option references to the target option before the source option is removed.
- Field entries using a source field definition are relinked to the target
  definition. If the owner already has the target field entry, source values move
  into the target entry and the source entry is removed.
- Field ids are rewritten in saved-search rules, view field refs
  (`groupField`, sort/filter/display fields), and reference nodes.
- Tag definition merge replaces source tag applications with the target tag,
  rewrites saved-search tag refs, config refs such as `extends`,
  `childSupertag`, and `sourceSupertag`, and moves missing template children from
  source tag to target tag.
- Definition merges rewrite rich-text inline node references that pointed at a
  source definition before deleting the source, preserving user-authored links;
  preview/return data includes the affected host node ids.
- Target definition config wins. Source config is not merged implicitly; use
  `configure_definition` before or after merge for intentional config changes.

Return data:

```ts
interface NodeEditData {
  action:
    | "replace_outline"
    | "move"
    | "merge"
    | "replace_with_reference"
    | "configure_definition"
    | "reuse_field_definition"
    | "merge_definition";
  status: "updated" | "unchanged";
  affectedNodeIds: string[];
  createdNodeIds?: string[];
  trashedNodeIds?: string[];
  matchedNodeIds?: string[];
  movedNodeIds?: string[];
  updatedFields?: string[];
  updatedTags?: string[];
  beforeOutline?: string;
  afterOutline?: string;
  revisions?: Record<string, string>;
  definition?: NodeDefinitionMutation;
  reusedFieldDefinition?: {
    fieldEntryId: string;
    targetDefinitionId: string;
  };
  definitionMerge?: NodeDefinitionMerge;
  merge?: {
    targetNodeId: string;
    sourceNodeIds: string[];
    movedChildren: number;
    mergedFields: Array<{
      fieldName: string;
      sourceFieldEntryId: string;
      targetFieldEntryId: string;
      movedValueIds: string[];
      mode: "merged_values" | "moved_entry";
    }>;
    appliedTags: number;
    redirectedReferences: number;
  };
}
```

Examples:

```json
{
  "operation": "replace_outline",
  "node_id": "node_task",
  "old_string": "- [ ] Check weather",
  "new_string": "- [x] Check Chengdu weather #weather"
}
```

```json
{
  "operation": "replace_outline",
  "node_id": "node_task",
  "old_string": "*",
  "new_string": "- [x] Check Chengdu weather #weather\n  - Status:: Done",
  "expected_revision": "node_task:1780000000000"
}
```

```json
{
  "operation": "replace_outline",
  "node_id": "node_task",
  "old_string": "  - %%node:field_status%% Status::\n    - %%node:value_open%% Open",
  "new_string": "  - %%node:field_status%% Status::\n    - %%node:value_open%% In progress\n    - Blocked"
}
```

```json
{
  "operation": "move",
  "node_ids": ["node_task_a", "node_task_b"],
  "move": { "parent_id": "node_done" }
}
```

```json
{
  "operation": "merge",
  "node_id": "node_canonical",
  "merge_from_node_ids": ["node_duplicate_1", "node_duplicate_2"]
}
```

```json
{
  "operation": "replace_with_reference",
  "node_id": "node_old",
  "replace_with_reference_to": "node_canonical"
}
```

### `node_delete`

Move nodes to Trash, or restore them from Trash. Supports a single ID or an
array for batch operations. Works on any node: content, field values, and
references. Deleting a field value node removes that value; deleting a field
entry clears that field. Deleting a reference removes the link.

Parameters:

```ts
interface NodeDeleteParams {
  node_id?: string;
  node_ids?: string[];
  restore?: boolean; // true = restore from Trash; omit/false = move to Trash
  preview_only?: boolean;
}
```

Return data:

```ts
interface NodeDeleteData {
  action: "trashed" | "restored";
  trashId: string;
  requestedNodeIds: string[];
  deletedNodeIds: string[];
  restoredNodeIds?: string[];
  deletedCount: number;
  restoredCount?: number;
  affectedNodeCount: number;
  preview: Array<{
    nodeId: string;
    title: string;
    type: NodeKind;
    parent?: { nodeId: string; title: string } | null;
    childCount: number;
    subtreeNodeCount: number;
  }>;
  skippedNodeIds?: Array<{
    nodeId: string;
    reason: string;
    coveredBy?: string;
  }>;
}
```

Result behavior:

- Use either `node_id` or `node_ids`, not both.
- Validate all node ids before mutating.
- Delete means move to Trash. Agent v1 does not expose permanent delete.
- Restore uses the node's recorded original parent/position when available. If
  the original location is no longer valid, return an error with guidance instead
  of guessing a new parent.
- Batch delete is supported by `node_ids`. This is not a generic batch protocol;
  it is the natural shape of the delete operation.

### `outline_undo_stack`

Inspect, undo, or redo operations. Unlike nodex's AI-only `undo`, Lin should
support both user and agent operations because the agent may need to reason about
recent user edits or redo a user action on request.

Parameters:

```ts
interface OutlineUndoStackParams {
  action?: "list" | "undo" | "redo"; // default "list"
  steps?: number; // default 1, max 10 for undo/redo
  operation_id?: string; // stack-top guard, not arbitrary history jumping
  origin?: "all" | "agent" | "user"; // default: all for list, agent for undo/redo
  limit?: number;  // for list, default 20, max 100
  offset?: number; // for list
}
```

Return data:

```ts
interface OutlineUndoStackData {
  action: "list" | "undo" | "redo";
  historyMode?: "journal" | "undo_stack";
  count: number;
  total?: number;
  hasMore?: boolean;
  items?: OutlineUndoStackItem[];
  undone?: OutlineUndoStackItem[];
  redone?: OutlineUndoStackItem[];
  canUndo: boolean;
  canRedo: boolean;
  cursor?: {
    topUndoOperationId?: string;
    topRedoOperationId?: string;
  };
}

interface OutlineUndoStackItem {
  operationId: string;
  origin: "agent" | "user" | "system";
  tool?: string;
  command?: string;
  action: string;
  summary: string;
  affectedNodeIds: string[];
  createdAt: string;
  canUndo: boolean;
  canRedo: boolean;
}
```

Result behavior:

- Omitted `action` means `list`.
- `list` is read-only, defaults to `origin: "all"`, and should not require
  approval.
- `undo` and `redo` are stack operations. Agent v1 does not support arbitrary
  history jumping.
- `steps` defaults to 1 and should stay small. Initial maximum: 10.
- `undo` and `redo` default to `origin: "agent"` for safety.
- `origin: "agent"` means undo/redo the nearest stack operation whose origin is
  agent, stopping at unsafe dependencies.
- `origin: "user"` means undo/redo the nearest user-origin stack operation and
  is still logged through the permission layer.
- `operation_id` is only a guard for the current stack target or a continuous
  stack range. If it would require skipping unrelated later operations, return
  `boundary` and do nothing.
- User-origin undo/redo defaults to allow under the global policy unless the
  user adds a matching block rule.
- Redo follows the redo stack and must fail if a new document mutation has
  invalidated the redo stack.
- If history storage cannot list operations yet, implement `undo` and `redo`
  first but return a clear `boundary` for `list`.

## TypeScript Parser, Preview, and Validation

Electron main owns the complete outliner mutation pipeline. The public pi-mono
tool definitions should stay thin: normalize arguments, call the TypeScript tool
gateway, and wrap gateway responses in `ToolResult`. The gateway may call
in-process TypeScript core services directly today; if the document core moves
behind another runtime boundary later, the public tool contract should not
change.

### Parser modules

Expected TypeScript modules:

```txt
lin_outline_parser
lin_outline_serializer
lin_outline_resolver
lin_mutation_planner
lin_tool_preview
lin_tool_validation
```

Core responsibilities:

```ts
parseOutline(input: string): OutlineDocument
serializeOutline(state: DocumentState, nodeId: string, opts: SerializeOptions): SerializedOutline
resolveOutline(ast: OutlineDocument, state: DocumentState, policy: ResolvePolicy): ResolvedOutline
buildMutationPlan(resolved: ResolvedOutline, context: ToolContext): MutationPlan
validatePlan(plan: MutationPlan, state: DocumentState): ValidationReport
renderPreview(plan: MutationPlan, state: DocumentState): ToolPreview
applyPlan(plan: MutationPlan, state: DocumentState): OperationResult
```

`SerializedOutline` contains annotated model-facing text. `%%node:id%%` markers
are protocol metadata and are stripped before writing node content.
Its `revision` is computed from the serialized editable outline content plus the
root node revision, so fields, values, and saved-search config participate in the
stale-write guard.

```ts
interface SerializedOutline {
  text: string;
  revision: string;
}
```

The parser accepts `%%node:id%%` only at the start of an outline line after
`- `. For field values written on the same line as a field header, it also
accepts an inline value marker after `::`. `node_create` rejects these markers;
`node_edit` uses them to map existing nodes, fields, and field values.

### `node_edit` flow

Content edits use this sequence:

```txt
validate operation === "replace_outline" and reject fields from other operations
  -> load current node state
  -> serialize current single-node editable outline
  -> check expected_revision when provided
  -> replace old_string with new_string
  -> parse the whole replacement result
  -> validate annotated ids are unique and belong to the target node, its fields, or its field values
  -> resolve tags, fields, refs, dates, search/view directives
  -> reject child-structure edits outside saved-search query config
  -> reject annotated field value kind/target changes before mutation
  -> render preview
  -> wait for approval when required
  -> apply the single-node edit as one transaction and one undo group
```

`old_string` matching rules:

- `old_string === "*"` replaces the whole single-node editable outline and is
  the only non-exact-match replacement mode. It is not a subtree replacement:
  child creation, deletion, and movement still use `node_create`, `node_delete`,
  or move parameters.
- Non-preview `old_string === "*"` requires `expected_revision` from `node_read`
  so stale context cannot overwrite a user's newer edit.
- `old_string` must match exactly once.
- Zero matches means the agent is using stale context and should call
  `node_read` again.
- Multiple matches means the agent should include more surrounding context or
  edit the child directly by node id.
- Matching is byte-exact against the single-node editable outline for `node_id`,
  after normalizing line endings to `\n`. If the first line is the target root
  line and omits `%%node:id%%`, TypeScript restores the target `node_id` marker
  before matching.

Identity rules:

- The root line maps to the `node_id` argument.
- If the root line carries `%%node:id%%`, that id must match the `node_id`
  argument.
- Existing field and value lines keep identity through their marker.
- Unmarked field lines resolve by field display name and reuse an existing owner
  field entry or unique field definition before creating a new field.
- Unmarked value lines append a new value unless they exactly match one existing
  unambiguous value.
- Removed marked lines are preserved. Delete nodes, field entries, or field value
  nodes explicitly with `node_delete`.
- Reordered field/value lines do not move existing nodes; use explicit move
  operations when order matters.

### Mutation plan

`MutationPlan` is internal. It is the only object that can be applied to
document state.

```ts
type MutationOp =
  | 'createNode'
  | 'updateNodeContent'
  | 'updateNodeDescription'
  | 'setChecked'
  | 'applyTag'
  | 'removeTag'
  | 'createFieldEntry'
  | 'setFieldValues'
  | 'clearField'
  | 'createReference'
  | 'replaceWithReference'
  | 'moveNode'
  | 'mergeNodes'
  | 'redirectReferences'
  | 'trashNode'
  | 'restoreNode'
  | 'updateSearchConfig'
  | 'updateViewConfig';
```

Planning must be deterministic. If the same current state and same tool
arguments are provided, the plan and preview should be identical.

### Preview data

Every mutating node tool can return a preview before apply.

```ts
interface ToolPreview {
  summary: string;
  creates: Array<{ title: string; parentId: string; kind: NodeKind }>;
  updates: Array<{
    nodeId: string;
    title: string;
    before?: unknown;
    after?: unknown;
  }>;
  moves: Array<{ nodeId: string; fromParentId: string; toParentId: string }>;
  deletes: Array<{ nodeId: string; title: string; destination: "trash" }>;
  warnings: string[];
  requiresApproval: boolean;
}
```

Preview should be concise in the model-visible response and richer in the UI
details object. Broad deletes, merges, and ambiguous identity preservation must
be called out explicitly.

### Validation rules

TypeScript validation is the security and correctness boundary.

Required checks:

- `node_edit.operation` is one of `replace_outline`, `move`, `merge`,
  `replace_with_reference`, `configure_definition`, or
  `reuse_field_definition`, or `merge_definition`; fields from other operations
  are rejected before any document state is read or mutated.
- The workspace/document boundary is valid for every referenced node.
- `parent_id`, `after_id`, `node_id`, `node_ids`, `target_id`, and
  `merge_from_node_ids` exist and are editable.
- `after_id` is a child of `parent_id` when both are provided.
- Moves cannot create cycles and cannot move locked/system nodes.
- Batch move operations are homogeneous and preserve selected-root semantics.
- Merge target and sources are distinct and have no unsafe ancestor/descendant
  relationship.
- Ordinary merge target and sources are content nodes; definition merges are
  same-kind field/tag definitions.
- Field values match field type constraints.
- Tag and field auto-creation follows the active policy.
- Search/view directives compile to a canonical `SearchQueryExpr`.
- `expected_revision` matches the current editable-outline revision when
  provided.
- Parser compatibility normalization does not silently change meaning.

Validation should produce structured guidance:

```ts
interface ValidationReport {
  ok: boolean;
  errors: Array<{ code: string; message: string; span?: SourceSpan }>;
  warnings: Array<{ code: string; message: string; span?: SourceSpan }>;
  instructions?: string;
}
```

### Apply rules

- A tool call applies as one transaction.
- A transaction creates one undo group.
- If any op fails, apply nothing.
- Operation history records origin, tool name, summary, affected nodes, and undo
  group id.
- Apply returns fresh revisions for affected root nodes.

## Local File Tools

File tools are for local files under the configured local file root (the **workdir**:
the agent's cwd, the default `file_glob`/`file_grep` root, and where `file_write`
output lands). The app-owned **scratch** sibling (materialized attachments, web-fetch
binaries, bash overflow logs, PDF pages) is read-accessible by absolute path but is
never the default listing root. Generated images are the narrow exception: their
tool-returned `generated-images/...` paths resolve under scratch for preview and
follow-up `generate_image.image_paths` use — see
[`agent-tool-permissions.md` → Allowed file area](./agent-tool-permissions.md#allowed-file-area)
for the two-root model. They must not mutate the outliner
document. The design keeps dedicated tools for each local file role:

- `file_read` inspects file content.
- `file_edit` applies exact replacements.
- `file_write` creates files or rewrites already-read files.
- `file_glob` lists matching files.
- `file_grep` searches file content.

The model-facing descriptions, parameters, and `data` payloads should stay as
close to the proven local-tool shape as possible. Lin keeps lower snake case
names and wraps the payload in the common `ToolResult` envelope, but should not
invent a second filesystem protocol.

For local tools, the model-facing descriptions should intentionally follow the
same operational habits: use dedicated file/search tools before `bash`, read
before edit/write, use exact string replacement, and background long-running
commands through the tool parameter instead of shell syntax.

The important design rule is that `bash` is not the filesystem API. Agents
should use dedicated tools for reading, editing, writing, listing, and searching
files, and reserve `bash` for commands that actually need a shell.

Path rules:

- Concrete file tools use `file_path`.
- Search tools use `path` as an optional search root.
- Model-facing `file_path` input values should be absolute paths. Search outputs
  such as `file_glob.filenames` and `file_grep.filenames` are local-root-relative
  to save tokens and keep path output compact.
- TypeScript must enforce the configured local file root unless the user
  explicitly hands Tenon a broader root.

Document and image conversion is not a dedicated tool. It runs through `bash`
invoking the installed converter binaries directly — LibreOffice-compatible
`soffice`/`libreoffice` for office and presentation files to PDF, Poppler
`pdftoppm` for PDF page images, and macOS `sips` for image format conversion.
These binaries are already default-allowed by the shell floor, and `bash` runs
in the same process environment (`buildAgentLocalToolProcessEnv` PATH, env, and
workdir cwd) as the other local tools, so no separate conversion surface is
needed. The `bash` tool description points the agent at these binaries.

## Per-Turn Context And Attachments

Dynamic context should be sent with the latest user turn, not baked into the
stable system prompt. This follows the agent runtime pattern:

- Stable identity, behavior, and tool policy live in the system prompt.
- Turn-specific state lives in one or more leading text parts wrapped in
  `<system-reminder>...</system-reminder>`.
- The renderer hides these reminder parts from the transcript, but debug panels
  show them under the request context.
- Current outliner context is a reminder part. Today node id is included because
  `node_create` defaults to today.
- Uploaded files, folders, and images are represented in model-facing user text
  as `[[file:<label>^<path>]]` markers. The path is rewritten to the
  materialized local-root path when the original path is outside the agent local
  root.
- Attachment payloads are runtime transport state, not the normal model-visible
  resource index. Historical `<user-attachments>` markers may still be parsed
  for replay, but new normal turns should rely on file markers.
- The marker convention is **bidirectional**: the agent also *emits*
  `[[file:<label>^<path>]]` in its own final answer to surface a file it produced
  for the user — a deliverable they asked for or should review (whether written via
  `file_write` or `bash`), not an intermediate/scratch file — using an absolute path
  inside the agent local root. Generated image answers use the returned standard
  Markdown image string with a `file:^...` target instead. The renderer resolves
  file markers and Markdown image file targets through the trusted-local-file
  gate (`resolveTrustedLocalFileReference`) and renders an inline file chip or
  image the user can preview, save, or insert into the outliner — the same chip an
  incoming attachment marker renders. Preview source resolution issues an opaque
  `preview-local://<token>` stream URL for trusted regular files, backed by a
  main-process token registry and range-capable file stream; the renderer never
  receives a `file://` URL or path-read capability. This is what lets a
  `bash`-produced binary (e.g. a `.pptx`, which `file_write` cannot author)
  appear in the message flow instead of only as a path in prose.
- Uploaded images remain inline image blocks in addition to their file marker.
  The inline part uses pi-ai's native `ImageContent` contract:
  `{ type: "image", data: base64, mimeType }`.
- Inline uploaded images are limited to provider-safe pi-mono/coding-agent
  formats (`image/jpeg`, `image/png`, `image/gif`, `image/webp`). Large static
  images should be resized before sending so the base64 payload stays under the
  same 4.5 MB inline-image budget used by pi-mono's coding-agent.
- Attachments without a native local path are staged under the agent local file
  root and then sent as file markers. Runtime still accepts inline text
  attachments for historical events.

### Referenced outliner files (the materialize bridge)

The document stores app-owned bytes as a **handle** (`asset://<id>` on an image /
attachment node); the agent lives in a **path**-addressed world. The *materialize*
bridge copies bytes across that boundary so a referenced document file reaches the
agent the same way a composer attachment does — a readable path, plus inline vision
for images. This is the input mirror of the `file_write` output side: input and
output are both a workdir/scratch path the agent reads with `file_read`.

- **Trigger and authorization.** Only nodes the user **explicitly references** into
  the turn (the composer's `@`-mention `referencedNodes`) are materialized — the
  explicit reference is the authorization. A merely-embedded asset the user did not
  reference is never copied, and a referenced plain/text node copies nothing.
- **At send time** (no lazy-on-read), each referenced image/attachment node with an
  `assetId` is resolved (`assetService.pathFor`/`lookup`) and copied into the
  **scratch** root via the same `materializeAgentLocalPath` machinery as composer
  attachments (size-capped by `MAX_MATERIALIZED_ATTACHMENT_BYTES`; oversized or
  unreadable assets are skipped, never failing the send).
- **Images** are additionally inlined as native `ImageContent` blocks for vision
  (same 4.5 MB base64 budget; if it would exceed the budget the image is still
  surfaced as a readable path, just not inlined).
- **Path surfacing.** The materialized read paths are listed in a hidden
  `<referenced-files>` reminder (one `<file node_id title mime size_bytes path
  inline_image />` per asset) inside the turn's `<system-reminder>`, instructing the
  agent to `file_read` them. The renderer keeps the `asset://` handle for its own
  display; only the agent-facing side gains a path.
- **Bound.** At most `MAX_REFERENCED_INLINE_IMAGES` images are inlined per turn,
  **counting the composer image attachments already in the turn**; any beyond that
  (and every non-image) are still surfaced as readable paths, so a turn that
  references many images cannot balloon the request with base64. A known oversized
  image skips the inline read entirely.
- **Scope.** Materialization is wired into the standard send only; a `/slash`-skill
  turn (which replaces the user prompt wholesale) and a **steer** message (sent while
  a run is active, carrying only text) surface the reference marker but not the bytes.
  Referencing an asset on those paths is a documented no-op for the bytes, not an error.

### Saving a conversation file into the outliner (the ingest bridge)

The inverse of materialize. A file the agent produced (`file_write` / `file_edit`,
rendered as a local-file chip in the transcript) is a **working** file: a workdir
path, mutable, GC'd with the conversation. The *ingest* bridge promotes it to a
**committed** outliner node — `working → committed`, a copy + freeze — so an
agent-produced file becomes the same kind of node as a user-added one.

- **Trigger.** A user action: the "Insert into outliner" button on the file chip
  (`AgentToolCallBlock` → `InsertIntoOutlinerButton`). Explicit, matching "export is
  explicit"; the agent has no auto-commit and (today) no ingest tool. Re-clicking
  inserts again — the document references a snapshot, so saving a newer version is
  just another click.
- **Path → asset (main).** The chip fires `requestInsertFileIntoOutliner(path)` on the
  decoupled `agentFileInsert` channel (the chip is deep in the message tree, with no
  path to App's document state — mirrors `agentReveal`). App's registered bridge calls
  the `ingest_local_file` command, which resolves the path through
  `resolveTrustedLocalFileReference` against the agent **workdir/scratch** roots — the
  same gate that backs previewing these chips — then `assetService.ingest({ kind:
  'path' })`. The renderer can only ingest a file it could already preview, so this is
  **not** the arbitrary-local-file read primitive that `ingest_asset`'s buffer-only
  rule guards against; directories and GC'd/out-of-root paths return null.
- **Asset → node (renderer).** The shared `createAssetNode` helper (also used by
  paste/drop) derives the node **type from the sniffed mimeType** (`image/*` →
  `create_image_node`, else `create_attachment_node`), never chosen by the user, and
  reuses the same `attachmentNodeInput` metadata shape as a user-added file. The node
  lands the way paste/drop lands one — `insertionTargetFor`: a sibling right after the
  focused row (so it is never buried as a child of a media/code leaf), else appended
  into the current outline root. Focus is **not** stolen from the agent panel
  (`applyFocus: false`). `run` swallows a failed command to `null`, so the bridge
  confirms only on a real `CommandResult` (no false "inserted").
- **Symmetry.** Ingest and materialize are inverses over the one workdir↔asset-store
  boundary: a file saved out becomes the same `asset://` handle a user attachment has,
  and referenced back in becomes a workdir path again (materialize). The document only
  ever stores handles; the agent only ever sees paths.

### `file_read`

Read a file with bounded output. This is the only tool that should inspect file
contents before an edit.

Parameters:

```ts
interface FileReadParams {
  file_path: string;
  offset?: number; // one-based starting line number, default 1
  limit?: number;  // max lines, default 2000
  pages?: string;  // PDF page selector, for example "1-3" or "7"
}
```

Return data:

```ts
type FileReadData =
  | FileReadTextData
  | FileReadImageData
  | FileReadPdfData
  | FileReadMarkdownData
  | FileReadNotebookData
  | FileReadUnchangedData;

interface FileReadTextData {
  type: "text";
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
}

interface FileReadImageData {
  type: "image";
  file: {
    filePath: string;
    base64: string;
    type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    originalSize: number;
    dimensions?: {
      width: number;
      height: number;
    };
  };
}

interface FileReadPdfData {
  type: "pdf";
  file: {
    filePath: string;
    originalSize: number;
    totalPages: number;
    // Runtime-selected representation summary. This is not a file_read input,
    // and it is kept out of the model-visible projection.
    representation: "text" | "images" | "text_and_images" | "metadata";
    pages: {
      firstPage: number;
      lastPage: number;
    };
    extractedText?: {
      chars: number;
      truncated: boolean;
    };
    renderedImages?: {
      count: number;
      outputDir: string;
    };
  };
}

interface FileReadMarkdownData {
  type: "markdown";
  file: {
    filePath: string;
    content: string;
    converter: "markitdown";
    contentChars: number;
    truncated: boolean;
    originalSize: number;
  };
}

interface FileReadNotebookData {
  type: "notebook";
  file: {
    filePath: string;
    cells: Array<{
      cellType: "code" | "markdown" | "raw" | "unknown";
      source: string;
      outputs?: string[];
      executionCount?: number | null;
    }>;
    content: string;
    totalCells: number;
    originalSize: number;
  };
}

interface FileReadUnchangedData {
  type: "file_unchanged";
  file: {
    filePath: string;
  };
}
```

Result behavior:

- Reading directories should fail. Use `file_glob` for file discovery, or
  `bash` with `ls` only when directory metadata is required.
- Large text files are paginated with `offset` and `limit`. A partial read
  (offset past the start, or fewer lines returned than the file holds) sets
  `status: "partial"` so the model gets a structured truncation signal it can act
  on without relying on the prose instructions.
- Image reads return dimensions when they can be determined, attach the image
  block for the model to inspect, and omit base64 from the model-visible JSON so
  text output stays compact.
- The model-visible `content[0].text` JSON is a compact metadata projection.
  Runtime-extracted document bodies are attached as additional tool-result parts:
  PDF text and rich-document Markdown use text parts, and rendered PDF pages use
  image parts. Ordinary text/source files keep their bounded text directly in the
  JSON because the file itself is already text.
- Rich non-PDF documents use a runtime-owned Markdown path. Supported formats are
  `.docx`, `.pptx`, `.xlsx`, `.xls`, and `.epub`; the model still passes only
  `file_path`, while the runtime converts the document to bounded Markdown and
  attaches that Markdown as a text content part. `.html` and `.htm` stay on the
  ordinary text path so they remain zero-dependency readable and editable.
- MarkItDown is the Markdown backend for rich documents. The runtime probes
  `LIN_AGENT_MARKITDOWN_COMMAND`, then `markitdown`, then
  `python3 -m markitdown`. `LIN_AGENT_MARKITDOWN_COMMAND` may be a bare
  executable path or a command with arguments such as `python3 -m markitdown`.
  Successful command resolution is cached for the process; failed resolution is
  not cached so installing MarkItDown and retrying can succeed. Plugins, cloud
  backends, and LLM-assisted extraction are not enabled by the runtime. Missing
  MarkItDown returns a recoverable tool error that tells the agent to install a
  local Python/uv backend through `bash` and retry the same `file_read` call; the
  file tool does not install packages itself and does not assume Homebrew.
- MarkItDown output is capped. Truncated Markdown sets `status: "partial"`,
  records `truncated: true` and the emitted `contentChars` count in the runtime
  data, and marks the attached Markdown text part as truncated.
- Runtime ingestion keeps a small in-process derived-result cache for expensive
  text extraction. Cache keys include the source file hash, extractor identity,
  relevant options such as PDF page range, and the local tool environment. The
  cache is disposable and never becomes truth: errors are not cached, ordinary
  text-file freshness still comes from the per-run read record, and rendered PDF
  page image directories remain per-read scratch outputs.
- PDF reads are provider-neutral. `file_read` never sends the original PDF bytes
  to the model as a provider-native document block; the runtime extracts local
  text and/or page images first, then attaches those model-readable parts to the
  tool result.
- Reading a PDF without `pages` uses `pdfinfo` for page count and `pdftotext`
  for embedded text extraction over the full document, capped by the PDF text
  limit. Text PDFs therefore stay searchable and token-efficient on every model.
  If no embedded text is available and the PDF has at most 10 pages, the runtime
  renders the pages as JPEG images automatically; larger scanned PDFs return
  metadata plus instructions to call `file_read` again with a narrower `pages`
  range.
- PDF reads with `pages` ranges such as `"3"` and `"1-5"` render the selected
  pages with `pdftoppm`, with a maximum of 20 pages per request. When
  `pdftotext` extracts text for that range, the text part is attached before the
  page images so visual layout inspection and text search both work. Missing
  `pdftotext` does not block an explicit page-image read when `pdftoppm` is
  available.
- If Poppler is missing for page rendering or PDF conversion, the tool returns a
  recoverable error that tells the agent to use `bash` to detect an available
  package manager and install Poppler. The recovery path must not assume
  Homebrew: it can use an installed manager such as Homebrew, MacPorts, apt, dnf,
  or pacman, then retry the same `file_read` call. If no
  supported package manager is available, the agent reports that Poppler must be
  installed so `pdfinfo`, `pdftotext`, and `pdftoppm` are on `PATH`. The file
  tools never install system packages themselves.
- Notebook reads parse `.ipynb` cells and outputs into a compact text rendering
  plus structured cell metadata.
- Binary files should return a typed result only when Lin supports the media
  type; otherwise return a recoverable error.
- Successful reads update a per-run file freshness record used by `file_edit`
  and `file_write`.

### `file_glob`

Find files by path pattern. Use this for file discovery by name or extension.

Parameters:

```ts
interface FileGlobParams {
  pattern: string; // for example "**/*.rs" or "src/**/*.ts"
  path?: string;   // optional absolute search root, default local file root
}
```

Return data:

```ts
interface FileGlobData {
  durationMs: number;
  numFiles: number;
  filenames: string[];
  truncated: boolean;
}
```

Result behavior:

- Results should be sorted by modified time, newest first.
- Returned filenames are local-root-relative, matching `file_grep` and saving
  model tokens.
- Candidate enumeration may use Tenon's ripgrep provider for the fast path, but
  `file_glob` keeps a TypeScript directory-walk fallback when ripgrep is
  unavailable or times out.
- TypeScript should cap result count and set `truncated` when needed.
- Use `file_grep`, not `file_glob`, when the task is content search.

### `file_grep`

Search file contents through Tenon's ripgrep provider. The provider resolves
`LIN_AGENT_RIPGREP_COMMAND` first, then bundled app resources, then system `rg`
as a development fallback. Missing `rg` on the user's shell `PATH` should not
break `file_grep` in dev or packaged builds. Use this tool instead of running
`grep`, `rg`, or similar commands through `bash`.

Parameters:

```ts
interface FileGrepParams {
  pattern: string; // regular expression
  path?: string;   // file or directory root, default local file root
  glob?: string;   // include filter, for example "**/*.rs"
  output_mode?: "content" | "files_with_matches" | "count"; // default files_with_matches
  "-B"?: number;
  "-A"?: number;
  "-C"?: number;
  context?: number;
  "-n"?: boolean;
  "-i"?: boolean;
  type?: string;       // optional language/file type filter
  head_limit?: number; // max returned lines/items; 0 means unlimited within hard caps
  offset?: number;
  multiline?: boolean;
}
```

Return data:

```ts
interface FileGrepData {
  mode?: "content" | "files_with_matches" | "count";
  numFiles: number;
  filenames: string[];
  content?: string;
  numLines?: number;
  numMatches?: number;
  appliedLimit?: number;
  appliedOffset?: number;
}
```

Result behavior:

- Default to `files_with_matches` so broad searches stay cheap.
- Results paths are local-root-relative to reduce tokens and keep
  output.
- `content` mode should include file paths and line numbers when useful.
- Multiline search should be explicit because it is more expensive.
- TypeScript streams ripgrep output and applies `offset` while reading, so large
  result sets do not need to be buffered before pagination. `head_limit: 0` means
  "use the hard maximum page size", not truly unbounded output. If Lin needs to
  expose hard-page truncation beyond `appliedLimit`, put it in the common
  `ToolResult.metrics`, not inside `FileGrepData`.
- `ripgrep_unavailable` means Tenon's configured/bundled provider is broken or
  inaccessible. It is a packaging/runtime issue, not a primary instruction to
  install ripgrep through the user's package manager.

### `file_edit`

Apply exact string replacements. This is intentionally not a mini patch
language.

Parameters:

```ts
interface FileEditParams {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}
```

Return data:

```ts
interface FileEditData {
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string;
  structuredPatch: Hunk[];
  userModified: boolean;
  replaceAll: boolean;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

```

Result behavior:

- The agent must call `file_read` on the file before `file_edit`.
- `old_string` must match the file exactly.
- If `old_string` appears multiple times, fail unless `replace_all` is true.
- If the file changed after the last `file_read`, fail with `userModified` and
  guidance to read again.
- Return `unchanged` when the requested replacement is already reflected in the
  file.
- Return a compact local hunk around the changed region, not a whole-file
  before/after patch, so small edits stay cheap for the model.

### `file_write`

Create a new file or rewrite a whole file. Prefer `file_edit` for modifying an
existing file.

Parameters:

```ts
interface FileWriteParams {
  file_path: string;
  content: string;
}
```

Return data:

```ts
interface FileWriteData {
  type: "create" | "update";
  filePath: string;
  content: string;
  structuredPatch: Hunk[];
  originalFile: string | null;
}
```

Result behavior:

- Creating a new file does not require a prior `file_read`.
- Updating an existing file requires a prior `file_read` freshness record.
- Overwriting a file should be treated as a high-signal mutation in logs; the
  global permission policy may still allow it by default.
- Do not use `file_write` to append small changes; use `file_edit`.
- Writes under self-definition directories are validated by the file-tool gateway
  after the ordinary permission decision. Skill writes validate `SKILL.md` /
  support-file shape and hot-reload the skill registry. The self-definition gate
  guards **skills only** (`.agents/skills`) — agent-definition (`AGENT.md`) writes
  are no longer a self-definition surface (`single-agent-finish-collapse`): the one
  agent (Neva) is a built-in, not a file, so a dropped `.agents/agents/*` file is
  an inert workspace file.

## Shell Tools

### `bash`

Run a local command. It is for shell execution, not file reading, file editing,
or content search.

Parameters:

```ts
interface BashParams {
  command: string;
  description?: string;
  timeout?: number; // milliseconds
  run_in_background?: boolean;
  dangerouslyDisableSandbox?: boolean; // optional, hidden or approval-gated
}
```

Return data:

```ts
interface BashData {
  stdout: string;
  stderr: string;
  rawOutputPath?: string;
  interrupted: boolean;
  isImage?: boolean;
  backgroundTaskId?: string;
  backgroundedByUser?: boolean;
  assistantAutoBackgrounded?: boolean;
  dangerouslyDisableSandbox?: boolean;
  returnCodeInterpretation?: string;
  noOutputExpected?: boolean;
  structuredContent?: unknown[];
  persistedOutputPath?: string;
  persistedOutputSize?: number;
  command?: string;
  taskStatus?: "running" | "completed" | "failed" | "stopped";
  exitCode?: number | null;
  startedAt?: string;
  completedAt?: string;
}
```

Result behavior:

- Commands run in the local file root by default. Lin should not expose a
  model-facing `cwd` parameter initially; the agent can use shell syntax when a
  command truly needs another directory.
- Long-running commands should use `run_in_background: true` and return
  `backgroundTaskId`. The agent should not append `&`.
- Foreground commands that outlive Lin's blocking budget may be auto-backgrounded
  and return `assistantAutoBackgrounded: true` with a task output file path.
- Output must be bounded and file-first. The runner captures stdout/stderr to
  files instead of accumulating unbounded strings in the main process; foreground
  output is read inline only when it is under the inline cap. Large output is
  persisted and referenced by `persistedOutputPath`, which the agent can read
  with `file_read`. Foreground and background output have a disk-size watchdog
  that fails and terminates runaway commands before output can grow without
  bound.
- Bash stdout/stderr capture must use pipes streamed into files, not shell-owned
  file descriptors, so Node can observe descendants that inherit stdio.
- Foreground and background bash completion is based on process `close` (stdio
  closed), not shell `exit`. A shell wrapper exiting while a descendant still
  owns stdout/stderr must leave the foreground call blocked/auto-backgrounded or
  the background task running and stoppable.
- Running background task files record the stdout/stderr capture file paths; when
  the task completes, fails, or is stopped, Lin composes the returned output file
  with stdout, stderr, and a final status footer.
- `bash` timeout, cancellation, `bash_stop`, and output watchdog termination must
  stop the shell process tree, not only the shell wrapper process.
- Completion of a background command should be surfaced through the agent
  runtime event stream with the same output path. Do not add a polling-first
  `TaskOutput` equivalent unless real usage proves `file_read` is insufficient.
- Risky commands run by default unless they hit a hard redline, a built-in soft
  block, restricted sandbox rules, or a user blocklist rule.
- Non-zero command exit is represented through `stdout`, `stderr`, `exitCode`,
  and optional `returnCodeInterpretation`.
- Do not use `bash` to read, edit, write, glob, or grep files when the dedicated
  file tool fits the task.

### `bash_stop`

Stop a background command created by `bash`. It is not a generic process
manager and does not provide status/read/wait operations.

Parameters:

```ts
interface BashStopParams {
  task_id: string;
}
```

Return data:

```ts
interface BashStopData {
  message: string;
  task_id: string;
  task_type: string;
  command?: string;
  status: "stopped";
  outputPath: string;
}
```

Result behavior:

- Only stop tasks created by Lin's own `bash` tool.
- If a background task finishes, Lin should surface completion through the agent
  runtime event stream; the agent should not need a polling tool.
- If the output is too large, `bash` should persist it and return a path that
  can be read with `file_read`.

## Web Tools

Web tools are read-only retrieval tools. Follow lin-agent's split: `web_search`
discovers sources, `web_fetch` reads one known URL. Do not merge them into a
generic `web` tool, and do not route routine web reads through `bash`.

They should be disabled or approval-gated if the workspace is configured for
offline/private mode. Permission scope is host-based:

- `web_fetch`: `Web(<url host>)`
- `web_search`: `Web(<site host>)` when `site` is set, otherwise
  `Web(<search provider host>)`

Shared behavior:

- Tools are `isReadOnly: true`, `isConcurrencySafe: true`, and should use a
  `maxResultSizeChars` budget around `100_000`.
- Prefer an embedded browser/session-backed fetch path when available so normal
  user cookies and proxy settings work. A TypeScript HTTP client is acceptable for v1
  if browser session plumbing is not ready.
- Return content separately from telemetry. The `data.content` or
  `data.results` fields carry what the model needs; status, bytes, final URL,
  duration, hints, and pagination metadata stay in structured fields.
- Hints are successful tool results, not thrown errors. They tell the agent what
  cannot be completed automatically.
- Fatal validation, network, extraction, and parse failures return
  `status: "error"` with a categorical `error.code`.

Shared hint and error types:

```ts
type WebToolHint =
  | {
      type: "login_required";
      origin: string;
      detectedVia: "url_redirect" | "selector_match" | "title_keyword" | "http_401";
    }
  | { type: "needs_browser"; reason: "spa_shell" | "cloudflare" | "http_error" }
  | { type: "search_blocked"; reason: "captcha" | "rate_limit" | "unusual_traffic"; origin: string }
  | { type: "redirected_host"; originalUrl: string; finalUrl: string; finalHost: string };

type WebErrorCode =
  | "invalid_args"
  | "invalid_url"
  | "unsupported_scheme"
  | "permission_denied"
  | "offline_mode"
  | "no_session"
  | "network_error"
  | "timeout"
  | "extraction_failed"
  | "parse_failed"
  | "binary_unsupported"
  | "rate_limited"
  | "aborted";
```

### `web_search`

Search the web for current external information. Use this when the agent does
not already have a specific URL. Do not use it as a round trip before
`web_fetch` when the URL is already known.

Parameters:

```ts
interface WebSearchParams {
  query: string; // 1..500 chars. Natural language and search operators are allowed.
  kind?: "web" | "image"; // default "web"; "image" returns image results
  limit?: number; // default 10, max 20
  site?: string; // optional host; appended as `site:<host>`
  recency_days?: number; // optional provider hint for fresh results
}
```

Return data:

```ts
interface WebSearchData {
  query: string;
  effectiveQuery: string;
  kind: "web" | "image";
  provider: "google" | "provider" | "custom";
  finalUrl?: string;
  resultCount: number;
  totalResults?: number;
  truncated: boolean;
  durationMs?: number;
  hint?: WebToolHint;
  results: WebSearchResult[];
}

interface WebSearchResult {
  title: string;
  url: string; // for images: the source page the image was found on
  snippet: string; // empty for image results
  source?: string;
  publishedAt?: string;
  // Image-result fields (kind === "image"):
  imageUrl?: string; // direct full-size image to download with web_fetch
  thumbnailUrl?: string; // smaller preview
}
```

Result behavior:

- `kind: "image"` runs an image search (Bing Images is the current provider,
  scraped from the `a.iusc[m]` JSON; `providerName: "bing_images"`). Each result
  carries `imageUrl` (the binary to download with `web_fetch`, which saves a
  `binaryFile`) and `thumbnailUrl` (a preview to pick by). `site` and
  `recency_days` still apply. The downstream "download + embed" path is
  `web_fetch` → `file_read`/embed — image search only adds discovery. Image
  results may be copyright-protected, so the success envelope warns to treat them
  as drafts and confirm reuse with the user. `kind: "web"` (default) is unchanged.
- `kind: "web"` (default) runs Google (`providerName: "google_serp"`) and, when
  Google is blocked, fails recoverably, or returns zero results, automatically
  falls back to the DuckDuckGo HTML endpoint (`providerName: "duckduckgo_html"`).
  A bad query (`invalid_args`) or a caller abort does not trigger the fallback.
  A DuckDuckGo page that loads and parses is authoritative even when empty and is
  returned (so an empty fallback reports "no results — broaden the query" rather
  than a misleading "retry / use a browser"); the envelope warns — only then —
  that results came from the DuckDuckGo fallback because the primary returned no
  usable results (it does not assert Google was "unavailable", which may be
  false). If DuckDuckGo also fails to produce a parsed page, the primary,
  user-intended Google outcome is surfaced (its hint/error and its google.com
  `finalUrl`), not DuckDuckGo's own failure.
- The off-screen search window renders with a real Chrome desktop User-Agent
  (not Electron's default), so engines serve the standard desktop SERP the
  scrapers target.
- A transient navigation fault is retried once with a short backoff, on both the
  primary and the fallback engine. Because the engines are fixed reputable hosts,
  a `navigation_failed` (the dominant outcome of a mid-flight network/DNS blip),
  `network_error`, or nav `timeout` all count as transient; blocks, extraction
  misses, bad queries, and aborts do not. The rate-limit gate is acquired once
  per `web_search` call, so the internal retry + fallback cascade never
  self-throttles or spends the cross-call burst budget mid-call.
- `site` is a convenience parameter for a single host. For multiple hosts, the
  agent should issue multiple searches or put explicit search syntax in
  `query`.
- `recency_days` is a hint, not a hard guarantee. If the backend cannot enforce
  it, return results and add a warning.
- CAPTCHA, unusual traffic, or search-provider block pages return
  `status: "success"` with `data.hint.type: "search_blocked"`, not retries in a
  loop. For `kind: "web"` this is surfaced only after the DuckDuckGo fallback has
  also failed to produce results.
- Empty results return `status: "success"` with `resultCount: 0` and a
  `instructions` suggesting a broader query.
- The model-visible result should make sources easy to cite. If the adapter
  renders a compact text view in addition to JSON, use a short numbered source
  list and include a reminder that answers using search results must cite
  sources with markdown links.

Example success data:

```json
{
  "query": "loro crdt move operation",
  "effectiveQuery": "loro crdt move operation site:loro.dev",
  "provider": "google",
  "finalUrl": "https://www.google.com/search?q=loro+crdt+move+operation+site%3Aloro.dev",
  "resultCount": 2,
  "truncated": false,
  "results": [
    {
      "title": "Loro Docs",
      "url": "https://www.loro.dev/docs/...",
      "snippet": "Loro supports move operations for tree structures..."
    }
  ]
}
```

### `web_fetch`

Fetch and read a known URL. It returns extracted content directly, not a
secondary-model summary. If the page is large, use read pagination or `query`
mode to get relevant snippets.

Parameters:

```ts
interface WebFetchParams {
  url: string; // absolute http(s) URL, max 2000 chars; http may be upgraded to https
  format?: "markdown" | "text" | "raw" | "metadata"; // default markdown
  offset?: number; // read mode character offset, default 0
  max_chars?: number; // read mode character cap, default 30000

  // Find mode. When set, return matching snippets instead of the full page.
  query?: string;
  context?: number; // chars before/after each match, default 500
  head_limit?: number; // max matches, default 10
  match_offset?: number; // skip first N matches, default 0
  case_insensitive?: boolean; // default true
}
```

Return data:

```ts
interface WebFetchData {
  url: string;
  finalUrl: string;
  statusCode: number;
  statusText?: string;
  contentType?: string;
  byteLength?: number;
  durationMs?: number;
  mode: "read" | "find" | "metadata";
  format: "markdown" | "text" | "raw" | "metadata";
  title?: string;
  content?: string;
  metadata?: WebPageMetadata;
  totalChars?: number;
  returnedChars?: number;
  nextOffset?: number;
  matches?: WebFetchMatch[];
  totalMatches?: number;
  returnedMatches?: number;
  nextMatchOffset?: number;
  truncated: boolean;
  hint?: WebToolHint;
}

interface WebPageMetadata {
  title?: string;
  description?: string;
  canonicalUrl?: string;
  siteName?: string;
  language?: string;
  headings?: string[];
  links?: Array<{ text: string; url: string }>;
}

interface WebFetchMatch {
  index: number;
  start: number;
  end: number;
  snippetStart: number;
  snippetEnd: number;
  snippet: string;
}
```

Result behavior:

- `format: "markdown"` converts HTML to readable markdown. Plain text and JSON
  may be returned verbatim.
- `format: "metadata"` returns only page metadata and selected links/headings;
  it should not return full body content.
- `query` activates find mode. It searches the extracted content and returns
  snippets with offsets, similar to `file_grep` over one fetched URL.
- `offset`/`max_chars` page full content in read mode.
  `match_offset`/`head_limit` page matches in find mode.
- Requests present a real Chrome desktop User-Agent and the matching browser
  request headers (`sec-ch-ua`, `sec-fetch-*`, `accept-language`,
  `upgrade-insecure-requests`) so origins that gate on a browser identity serve
  real content instead of a bot challenge. The embedded-browser fallback renders
  with the same identity. Across a redirect chain the headers track a real
  navigation: `Referer` follows Chrome's default strict-origin-when-cross-origin
  policy (full URL same-origin, origin-only cross-origin, omitted on an https→http
  downgrade) and `Sec-Fetch-Site` degrades monotonically (it stays `cross-site`
  once the chain has crossed origin).
- Redirects are followed transparently across hosts (link shorteners, trackers,
  regional/mobile subdomains), preserving the server's literal scheme on each hop
  (no http→https upgrade once redirecting — that would break an http-only
  target). When the landing host differs from the requested host the result still
  returns content plus a non-fatal `data.hint.type: "redirected_host"` and a
  warning, with `finalUrl` reflecting the landing page — the agent does not need
  to re-fetch. A redirect to a local/private host is the one case that is refused,
  on both the HTTP path (each hop is validated) and the embedded-browser fallback
  (`will-navigate`/`will-redirect` are blocked and the landing URL is re-checked).
- A raw network throw is retried once with a short backoff before surfacing,
  UNLESS it is a deterministic transport fault that would fail identically on a
  retry (DNS NXDOMAIN, refused connection, TLS/cert, unsafe/blocked port, bad
  scheme), which is surfaced immediately. The decision is a denylist of those
  deterministic faults rather than a whitelist of transient codes, so the retry
  still fires whether the platform surfaces a Chromium `net::ERR_*` code or a
  generic fetch rejection. HTTP responses — 403/429/5xx, Cloudflare, JS shells —
  are not network faults and are never retried at the HTTP layer: they route
  straight to the embedded-browser render fallback.
- Authentication walls return `login_required`; JavaScript-only shells,
  Cloudflare, or HTTP errors that might work in a live browser return
  `needs_browser` and trigger the embedded-browser render fallback. A Cloudflare
  challenge is detected by narrow markers (the `*cf_chl*` tokens and the visible
  interstitial phrases) that appear only on the actual block page — a full article
  that merely embeds a Cloudflare analytics/turnstile beacon or the
  challenge-platform script bundle is returned as-is, not flagged as a challenge.
- Binary content returns `binary_unsupported` unless Lin implements a binary
  persistence path. If binary persistence is added, return a file path in
  `data.metadata` and keep model-visible text short.

Example read result data:

```json
{
  "url": "https://example.com/article",
  "finalUrl": "https://example.com/article",
  "statusCode": 200,
  "contentType": "text/html; charset=utf-8",
  "mode": "read",
  "format": "markdown",
  "title": "Example Article",
  "content": "# Example Article\n\n...",
  "totalChars": 45210,
  "returnedChars": 30000,
  "nextOffset": 30000,
  "truncated": true
}
```

## Agent Timeline Memory

Durable memory is ordinary outline content on the timeline, not a separate
model-visible semantic-memory tool. The node family is:

- `#d-memory`: the single per-day memory container under that day's journal node.
  Its title is a generated daily memory headline, not a fixed label.
- `#d-episode`: a replayed episode or observed pattern under the day's memory
  container.
- `#d-belief`: a stable model update under an episode.
- `#d-question`: an unresolved tension, uncertainty, or follow-up to test.
- `#d-guidance`: a future handling note that should improve later help.

The child tags are optional. Dream does not force every episode to contain a
belief, question, and guidance line; it writes each only when useful.

The foreground model uses `node_search` and `node_read` to pull memory nodes when
stable preferences, prior decisions, or project memory may matter. There is no
resident `<memory>` briefing, no model-visible `recall` tool, and no foreground
fact CRUD tool. The model must not claim that it saved, updated, or forgot
durable memory from a foreground turn; memory consolidation is background runtime
work and user edits to memory nodes are authoritative.

Memory provenance uses the normal rich-text inline reference mechanism with the
`chat-source` target branch. Provenance is selective, not a mandatory suffix on
every memory line: a citation is shown when it clarifies a specific claim,
correction, conflict, or source cluster. An episode-level citation may cover child
beliefs derived from the same evidence, and repeated child citations should be
avoided when they add visual noise.

```ts
{
  kind: "chat-source",
  stream: "conversation" | "run",
  streamId: string,
  range: {
    fromSeqExclusive: number,
    throughSeq: number,
    throughEventId?: string | null
  }
}
```

Its marker form is `[[chat:<label>^<stream>:<streamId>@<from>-<through>]]`, with
an optional `:<throughEventId>` suffix. The parser splits the raw marker value
before `decodeURIComponent`, so ids that contain encoded separators round-trip
without ambiguity. Agent node writes validate every `chat-source` inline ref by
dereferencing the exact `past_chats` source coordinates before mutating the
outline; fabricated or stale coordinates fail loudly.

Runtime Dream is a private built-in skill, `memory-dream`. It is runtime-only:
not model-invocable, and not exposed as `/dream` or a foreground `dream` tool.
The scheduled-routines path is at-most-once per daily due occurrence; Settings
also exposes a manual run button that uses the same restricted Dream-channel path
and is not blocked by the scheduled due gate. The manual button first calls a read-only
`agent_dream_readiness` pre-check (new evidence since the watermark vs. the
scheduled volume bar); below the bar it advises that there is little new chat
since the last Dream (a run would mostly reconcile existing memory rather than
capture new conversations) and offers a "Dream anyway" override instead of
running — the advisory flags thin new-chat volume, not "nothing to do", since a
sub-bar manual run is still a valid consolidate-only reconciliation. A run computes per-stream seq ranges from
the Dream watermark, renders the skill, appends a manual or scheduled anchor to
the protected Dream channel, and starts an unattended top-level run with a
Dream-only profile whose tools are only `past_chats`, `node_search`, `node_read`,
`node_create`, `node_edit`, and `node_delete`. The Dream channel does not accept
ordinary chat messages, is excluded from Dream evidence, and supplies no prior
active path to the Dream agent; its transcript is visible audit history rather
than model context for later Dreams. That audit history is bounded to the newest
512 Dream-channel runs; older run ledgers, launch anchors, `dream.finished`
markers, and search-index entries are pruned while durable outline memory and the
Dream watermark remain intact.
The run first reads today's journal node. When it yields durable memory
worth writing, it creates or reuses exactly one direct `#d-memory` container under
it and updates that container's generated daily memory headline in place; when
nothing is worth remembering it writes nothing and a clean run still completes,
recording `dream.completed` with zero changes and advancing the watermark. It uses
`node_search` / `node_read` to gather relevant
prior `#d-memory` / `#d-episode` / `#d-belief` / `#d-question` / `#d-guidance`
nodes and user-authored outline context for the topics extracted from the raw
chat spans. Manual `consolidate_only` runs may have no new chat sources; then the
run consolidates from today's outline, prior Dream memory, and relevant
user-authored outline context. Prior Dream results are treated as current
beliefs, tensions, and guidance to reconcile, not as evidence that can reinforce
itself. User-authored outline nodes may be cited with normal `[[node:...]]`
references when they materially inform the memory. The run may update, merge,
move, or delete ordinary outline nodes when consolidation warrants it; `node_delete`
moves nodes to Trash. The run follows a single
human-dream cycle: replay salient fragments, associate them with outline context,
reconcile prior memory, abstract stable patterns, expose unresolved tensions as
optional `#d-question`, simulate future behavior as optional `#d-guidance`, and
downselect weak evidence. The run brief gives exact `past_chats` source
objects and the corresponding `[[chat:...]]` marker templates. The run applies
the valuable-memory filter, keeps the target coordinates intact, and replaces the
visible marker label with a short phrase that reads as part of the memory
sentence when a visible citation is useful. It does not cite every line
mechanically. After the run completes cleanly, the runtime records
`dream.completed` with the processed ranges and advances the watermark; the memory
nodes themselves are the durable model-readable result. A run that ends
`completed` but was actually cut off mid-work by an unresolved context overflow
is flagged `incomplete` on its result; a zero-write `incomplete` run is
treated as a failure (no `dream.completed`, watermark unchanged) so the span is
retried rather than dropped. (A truncated run that already committed memory writes
keeps them and still completes, since the work is durable.)

### `past_chats`

`past_chats` is a read-only tool over the local event-log conversation/run
record. It introduces no transcript snapshot store. It reuses the same visible
transcript rules as the renderer and the same raw-span dereference path as
memory evidence expansion.

Modes:

- `recent=true`: list recent visible user-message anchors. This is navigation,
  not evidence.
- `query`: search visible prior conversation messages by concrete text terms.
  Search results include `message_id` anchors and source coordinates.
- `message_id`: read a bounded conversation window around a returned anchor.
- `source`: read a raw `{stream, stream_id, from_seq_exclusive, through_seq?}`
  conversation/run span. Returned results include the concrete source range
  (`through_seq`, `through_event_id`) so later writers can cite only spans they
  have actually read.

The current conversation is excluded by default from `recent`, `search`, and
`message_id` reads. The model may opt into `include_current_conversation` only
when it is recovering compacted current-conversation content that is no longer
in the active context. The protected Dream channel is excluded from all
`past_chats` modes, including explicit conversation-id filters and source
coordinates, so Dream reasoning/tool transcript stays user-visible audit history
rather than ordinary recall material. Source reads are explicit coordinates and
are otherwise not current-conversation filtered.

Tool results use the shared envelope and expose only the slim model-visible
projection:

```json
{
  "ok": true,
  "data": {
    "entries": [
      {
        "memory_id": "memory-1",
        "fact": "the user prefers direct answers",
        "status": "active",
        "created_at": 1800000000000,
        "sources": [],
        "evidence": []
      }
    ],
    "total_entries": 1
  }
}
```

## Self-Maintenance Controls

Agent self-configuration tools (`runtime_status`, `config`, `doctor`) were
removed as over-built for their current value. Runtime settings are managed by
the user through Settings → Agent; a future change may reintroduce agent
self-configuration through a different mechanism. The standing safety principle
survives the removal:

- The agent must not use `file_edit`, `file_write`, or `bash` to mutate provider
  settings, permission config, hook config, skill registry metadata, or
  last-known-good recovery state. Runtime-owned configuration changes only
  through runtime-owned APIs or Settings, never as ordinary file writes.
- Skill maintenance does not add a separate model-facing CRUD tool family in v1.
  It follows cc-2.1's smaller surface: `/skillify` produces/reviews content, then
  uses existing file tools. There is **no** agent-definition authoring surface —
  the one agent (Neva) is a built-in edited only via Settings → Agent; the
  `/create-agent` skill and file-backed `.agents/agents/*` definitions are removed
  (`single-agent-finish-collapse`).
- Skill files use the ordinary `file_write` / `file_edit` permission decision.
  After that decision, the file-tool gateway recognizes writes under registered
  skill directories, validates frontmatter/support files, carries rollback
  metadata in tool details, emits `skill.created` / `skill.patched` /
  `skill.replaced` audit events on success, records provenance hashes, and
  hot-reloads the skill registry.
- Agent definition files use the ordinary `file_write` / `file_edit` permission
  decision. After that decision, the file-tool gateway recognizes writes under
  user/project agent directories, accepts only `AGENT.md` files with
  `permission-mode: restricted`, validates strict frontmatter/body shape, rejects
  support files, deletes, trusted permission mode, reserved built-in names, and
  unsafe metadata, and hot-reloads live agent registries on success. Shell writes
  are not self-definition authoring routes.

## Mapping to Current Lin Commands

The public tools should compile down to TypeScript-backed commands. Current command
coverage maps as follows:

| Public tool | Current or needed backend capability |
|---|---|
| `node_search` | Temporary/saved search node parser compiled to full-text, tag, field, link-relationship, and view metadata. |
| `node_read` | `get_projection`, `backlinks`, annotated outline serialization, computed field and child summaries. |
| `node_create` | `create_node`, `create_tag`, `create_field_definition`, `create_field_def`, `create_inline_field`, `set_node_checkbox_visible`, `add_reference`, `create_search_node`, duplicate support. |
| `node_edit` | Single-node exact replacement compiled to `apply_node_text_patch`, `set_node_checkbox_visible`, `toggle_done`, tag/field upserts, value appends/updates, `move_node`, `set_reference_target`, `replace_node_with_reference`, `set_search_node`, `set_field_config`, `set_tag_config`, `reuse_field_definition`, and `merge_definitions`. Merge/reference replacement may trash explicitly named source nodes; ordinary deletion belongs to `node_delete`. |
| `node_delete` | `trash_node`, `batch_trash_nodes`, `restore_node`; permanent delete is not exposed to agent v1. |
| `outline_undo_stack` | Loro UndoManager-backed `undo`/`redo` plus operation journal listing with origin metadata. |
| `file_read` | Implemented TypeScript file read command with path normalization, text pagination, image content/dimensions, PDF page rendering, notebook parsing, and freshness tracking. |
| `file_glob` | Implemented TypeScript glob command under allowed roots with local-root-relative output paths. |
| `file_grep` | Implemented ripgrep-backed search command under allowed roots through Tenon's ripgrep provider, with relative paths, output modes, and streamed pagination. |
| `file_edit` | Implemented TypeScript exact-replacement command with read-before-edit freshness checks. |
| `file_write` | Implemented TypeScript create/rewrite command with read-before-write freshness checks for existing files. |
| `bash` | Implemented TypeScript command runner with timeout, output caps, background task support, and output persistence. |
| `bash_stop` | Implemented TypeScript background task stop command scoped to Lin-created bash tasks. |
| `web_search` | Needed web search adapter: provider-backed search or embedded-browser SERP extraction, host permission scope, rate limiting, structured hints. |
| `web_fetch` | Needed URL fetch adapter: TypeScript HTTP and/or embedded browser session fetch, HTML-to-markdown extraction, pagination, find mode, structured hints. |
| `generate_image` | Implemented TypeScript image-generation adapter that resolves enabled image-capable providers, writes generated image files, and returns model-visible local paths. |

Lin should prefer adding semantic TypeScript core commands where the current command
set is too UI-shaped. For example, semantic target/source merge is better for
agents than only `merge_node_into_previous`.

## Approval Policy

The permission **policy** — the allow/ask/deny model, platform hard blocks, the
bash projection, ask resolution, sensitive-data redlines, the global store, and
events — is specified in `agent-tool-permissions.md`. This section only
classifies each tool as read-only vs mutating (the input that policy acts on).

Read-only tools run immediately when their permission scope is already allowed:

- `node_search`
- `node_read`
- `file_read`
- `file_glob`
- `file_grep`
- `past_chats`
- `outline_undo_stack(action: "list")`

Web tools are also read-only, but may be blocked by host/offline policy:

- `web_search`
- `web_fetch`

Mutating tools still pass through the global permission layer:

- `node_create`
- `node_edit`
- `node_delete`
- `outline_undo_stack(action: "undo" | "redo")`
- `file_edit`
- `file_write`
- `bash`
- `bash_stop`
- `generate_image`

How risk maps to allow / ask / deny (broad node/file edits, user-origin
undo/redo, risky shell, exfiltration redlines, permissive-mode behavior) is owned
by `agent-tool-permissions.md`.

## Implementation Notes

- Tool schemas live beside the Electron main-process pi-mono runtime, but
  validation and mutation semantics live in the TypeScript tool gateway.
- The pi-mono tool adapter should remain thin: normalize parameters, invoke the
  gateway, and convert gateway responses into `ToolResult`.
- TypeScript should own outliner parsing, tag resolution, field resolution, operation
  grouping, permissions, and persistence.
- All document mutations should create an operation history entry with origin,
  summary, affected nodes, and undo group id.
- Active UI context is injected every user turn and should not be fetched with a
  tool.
- Large tool outputs must be paginated or truncated with `metrics.truncated`.
- Tool results should be stable enough to persist in conversation history.
