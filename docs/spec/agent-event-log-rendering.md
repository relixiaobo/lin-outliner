# Agent Event-Sourced Runtime

This document is the canonical architecture for Tenon's current agent
data, debug, persistence, and rendering model.

## Decision

Tenon uses an event-sourced agent runtime.

The durable product source of truth is the **Agent event-log family**:

```txt
conversation segments + run events + agent identity records + referenced payload files
```

Everything else is derived:

- pi-mono `Message[]`
- pi-agent-core `Agent.state`
- transcript render rows
- debug timelines
- conversation list/search metadata
- branch tree state
- checkpoints

Derived data may be cached for speed, but it must be disposable and rebuildable
from the event store.

## Core Boundary

pi-mono remains the execution core.

Use pi-mono for:

- provider and model abstraction
- provider streaming
- message/content wire shapes
- tool-call parsing
- agent loop orchestration
- steering and follow-up
- abort
- message replacement during live execution

Do not reimplement pi-ai or pi-agent-core behavior in Tenon.

Tenon owns:

- product event log
- local tool gateway
- permissions and approvals
- outliner/file/bash/web tool effects
- undo grouping
- payload storage
- debug and performance records
- render projection
- persistence and restore policy
- self-maintenance audit events for hooks, recovery, skill write previews,
  skill writes, and skill rollback

```txt
command
  -> Electron AgentRuntime
  -> append Tenon event(s)
  -> derive pi-mono messages
  -> run pi-agent-core Agent
  -> normalize pi-mono events into Tenon event(s)
  -> append Tenon event(s)
  -> derive render/debug/checkpoint projections
```

pi-mono runtime state participates in producing new events. It is not Tenon's
persisted product state.

## Implementation Snapshot

The current main branch implements this architecture through these modules:

- `src/main/agentRuntime.ts`: owns conversation lifecycle, stable runtime agent
  identity, active-run state, pi-agent-core execution, Tenon event append,
  projection emission, attachment persistence, debug capture, and checkpoint
  writes.
- `src/main/agentEventStore.ts`: owns the filesystem event store split into
  conversation and run logs, scoped payload files, agent identity records, write
  queues, rebuildable indexes, seq-based checkpoint replay, and checkpoint
  retention.
- `src/main/agentDomainEvents.ts`: owns the internal domain-event bus. It is
  separate from renderer IPC and exposes persisted-log, renderer-projection,
  trusted-observer, and hook-interceptor lanes.
- `src/core/agentEventLog.ts`: owns event DTOs, replay reducers, parent-linked
  branch state, active-path derivation, and pi-ai message projection helpers.
- `src/core/agentRenderProjection.ts`: derives the compact renderer projection
  from replay state.
- `src/main/agentDebugView.ts`: pure run-grounded debug derivation — a run's own
  event stream + meta into the execution tree (rounds, tool exchanges, per-run
  system/tools snapshot). No seq-matching and no replay of the message transcript
  from the wire; the only wire read is the minimal system-prompt + tool-schema
  extraction for the per-run snapshot.
- `src/renderer/agent/runtime.ts`: adapts `AgentRenderProjection` into the
  renderer store/view consumed by the React agent UI.

The old mutable chat snapshot store is no longer part of the runtime.

## Renderer Projection UX

`AgentRenderProjection` is also the authority for the current conversation UI:

- `entities.messages[*].actor` identifies who produced each message. The
  conversation is single-agent — members are always `{user, Neva}` — so the
  renderer resolves the actor through `members[]` and the agent-definition
  registry for the display name and the deterministic circular identity chip.
  There is no `@`-mention routing; the handle (`assistant`) is the stable internal
  id, not a user-facing addressing affordance. A message whose recorded actor no
  longer resolves falls back to the recorded id rather than erasing historical
  identity.
- Message `createdAt`/`updatedAt`, `providerId`, `modelId`, and `usage` are quiet
  metadata. The transcript renders gap-based time separators, and the native
  message context menu's Details action opens an anchored popover with speaker,
  timestamp, model/provider, and token usage. These details are derived from the
  event log; no separate metadata store is introduced.
- The composer footer's model control edits the **agent profile**, not a
  per-conversation model identity. A conversation talks to an agent identity
  (Neva), not to a single model, so the quick model/effort chip
  (`AgentComposerModelControl`) is a shortcut to Neva's *standing* model/effort —
  the same value Settings → Agent owns — never a per-conversation override. It
  writes through the normal `agent_update_agent_definition` path (mirroring the
  current definition so the user's tools/persona/skills are preserved), and the
  runtime applies the change on the **next turn** (the agent loop re-reads
  `state.model`/`thinkingLevel` at each `agent_start`, the same hot-swap as a
  persona edit). Model/provider/effort otherwise stay visible only where they are
  diagnostic or configuration-relevant: the Details popover, the run/debug panel,
  ledger metadata, and the agent profile editor. See `agent-delegation-runtime.md`
  for how a profile owns model + effort.

## Reference Analysis

### Previous lin-outliner snapshot store

Before the event-sourced runtime, Tenon stored agent sessions in one mutable
snapshot file:

```txt
<userData>/agent-chat-sessions.json
```

Shape:

```ts
interface AgentChatStoreFile {
  sessions: Record<string, AgentChatSession>;
}

interface AgentChatSession {
  id: string;
  title: string | null;
  mapping: Record<string, AgentChatMessageNode>;
  currentNode: string;
  createdAt: number;
  updatedAt: number;
}
```

That model was intentionally replaced. It supported simple branch rendering, but
it was a poor source of truth for streaming, debug replay, approvals, tool
lifecycle analysis, performance inspection, and durable payload references.

### nodex

Nodex uses an IndexedDB-backed mutable chat tree plus derived metadata stores:

```txt
soma-ai-chat IndexedDB
  sessions
  session-metas
  session-user-metas
  session-debug-turns
```

Keep from nodex:

- branch semantics
- separate history/search metadata projection
- model/provider choice attached to session view

Do not copy:

- IndexedDB as the primary storage for Tenon's Electron runtime
- mutable tree as durable truth
- separate debug store as a competing fact source

### lin-agent

lin-agent uses fs-first JSONL channel logs:

```txt
<userData>/channels/<channelId>/meta.json
<userData>/channels/<channelId>/conversation.jsonl
```

Its `ConversationLine` model is append-only:

```ts
type ConversationLine =
  | MessageLine
  | EditLine
  | DeleteLine
  | CompactLine
  | SessionBoundaryLine;
```

Keep from lin-agent:

- fs-first JSONL
- versioned line records
- mutation-line mindset
- content refs for images and large payloads
- explicit bridge between persisted data and pi-ai `Message[]`
- compaction as log data, not hidden runtime mutation

Adapt for Tenon:

- store runtime event lifecycle, not only conversation lines
- keep branch selection and approval/tool lifecycle as first-class events
- derive conversation rows from events instead of storing a collapsed message
  list as truth

### Reference Shape

Some terminal-first agents use per-session JSONL transcripts under project directories:

```txt
~/.agents/projects/<sanitized-cwd>/<sessionId>.jsonl
```

Each transcript entry is append-only. Conversation messages carry `uuid` and
`parentUuid`; metadata is also appended as entries. Resume rebuilds the
conversation chain from the file.

Keep from the reference implementation:

- per-session JSONL
- parent-linked message chain
- metadata as append-only entries
- sidecar payload/metadata files
- write queue and flush discipline
- resume from chain plus repair/filter passes
- delegation/sidechain concept as future-compatible shape
- compaction and content replacement as persisted events

Do not copy:

- CLI-specific transcript entry taxonomy
- terminal UI details
- broad metadata re-append behavior unless a derived index proves insufficient
- mutable in-memory transcript array as product truth

## Storage Layout

Current filesystem layout:

```txt
<userData>/agent/
  agents/
    <agentId>/
      identity.json
  principals/
    <agent-<agentId> | user-<userId>>/
      runs.json
  conversations/
    <conversationId>/
      meta.json
      cursors.json
      runs.json
      segments/
        000001.jsonl
      payloads/
        <payloadId>.<ext>
      checkpoints/
        checkpoint-<seq>.json
  runs/
    <runId>/
      meta.json
      events.jsonl
      payloads/
        <payloadId>.<ext>
  indexes/
    conversation-index.json
    search-index.json
```

Authoritative:

- `conversations/<id>/segments/*.jsonl`
- `runs/<id>/events.jsonl`
- `agents/<id>/identity.json`
- payload files referenced by event payload refs

Derived and rebuildable:

- `checkpoints/*.json`
- `indexes/*.json`
- `conversations/<id>/meta.json`
- `conversations/<id>/runs.json`
- `principals/<principal>/runs.json`

Clean-cut startup policy (pre-release, no migration) — the storage-generation
sentinel:

- ONE root file `layout.json` `{"v": <generation>}` is written once per on-disk
  format generation (`STORAGE_LAYOUT_VERSION`, currently `4` = Dream-channel
  audit history + outline-only durable memory). First store access reads this single line; a
  matching `v` proceeds with no per-conversation probing.
- A stale `v` or a MISSING sentinel is positive proof of another generation:
  the WHOLE agent data root is hard-deleted (logged with the old generation) —
  identities, conversations, runs, principal sidecars, indexes — and the layout is recreated
  lazily with a fresh sentinel. There is no legacy reader, adapter, or
  migration.
- An unreadable or corrupt sentinel is AMBIGUITY, not proof: the store fails
  open onto the current layout (warn + re-probe next launch) — a permissions or
  I/O error can never trip a wipe.
- Future format breaks bump the integer instead of authoring a new detector
  (this sentinel replaced the per-artifact legacy-detector pile).

The event vocabulary is `conversation` end to end: renderer IPC, the event
schema, and storage all key the delivery log by `conversationId`.
`AgentEventStore.readEvents(conversationId)` joins the conversation segment and
the JOINED run logs listed in `conversations/<id>/runs.json` (turn/background
runs), then sorts by seq before replay. Runs the index marks `delegation` are
EXCLUDED from this join — a delegated run's ledger is its own stream with its
own seq space ([[agent-run-unification]]), so interleaving it would mix two seq
spaces; the conversation carries only its slim `child_run.*` markers.

## Event Store

Each line in `events.jsonl` is one JSON event.

Conversation segments and run logs share one append-only seq-log primitive for
JSONL serialization, per-key write queues, latest-seq caches, chunked
physical-tail reads, offset-bounded replay, and file-size checkpoint guards.
Conversation replay still joins the conversation segment with its indexed JOINED
run logs (delegation ledgers excluded) and sorts by `seq`. Principal sidecars no
longer hold a memory event log; they only hold the derived reflective-run index
for runs anchored to that principal. Delegated-run ledgers use the tolerant
sidecar torn-tail policy (drop a torn FINAL line on read, truncate it on the next
append's repair; mid-file corruption still fails loudly).

```ts
interface AgentEventBase {
  v: 1;
  eventId: string;
  seq: number;
  conversationId: string;
  type: AgentEventType;
  createdAt: number;
  actor: AgentActor;
  runId?: string;
  turnId?: string;
  messageId?: string;
  parentMessageId?: string | null;
  causedByEventId?: string;
}

type AgentActor =
  | { type: 'user'; userId: string }
  | { type: 'agent'; agentId: string }
  | { type: 'tool'; toolName: string; toolCallId: string }
  | { type: 'system' };
```

Rules:

- `seq` is monotonic per conversation.
- Events are append-only.
- Corrections are new events.
- Every persisted JSON shape has `v`.
- Large content is stored by reference.
- Secrets are redacted before persistence.
- Derived projections cannot introduce facts that are not present in the event
  store.

## Event Taxonomy

Current event schema:

```ts
type AgentEventType =
  | 'conversation.created'
  | 'conversation.renamed'
  | 'conversation.settings_changed'
  | 'debug.run_snapshot.created'
  | 'branch.selected'
  | 'user_message.created'
  | 'user_message.edited'
  | 'assistant_message.started'
  | 'assistant_message.delta'
  | 'assistant_message.completed'
  | 'assistant_message.failed'
  | 'thinking.delta'
  | 'tool_call.started'
  | 'tool_call.delta'
  | 'tool_call.completed'
  | 'tool_call.failed'
  | 'tool_result.created'
  | 'tool_result.replaced'
  | 'tool.permission.checked'
  | 'tool.permission.resolved'
  | 'user_question.requested'
  | 'user_question.answered'
  | 'user_question.cancelled'
  | 'widget_state.updated'
  | 'approval.requested'
  | 'approval.resolved'
  | 'follow_up.queued'
  | 'follow_up.applied'
  | 'notification.created'
  | 'notification.read'
  | 'skill.created'
  | 'skill.patched'
  | 'skill.replaced'
  | 'skill.enabled'
  | 'skill.disabled'
  | 'skill.rolled_back'
  | 'skill.curation.updated'
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'child_run.started'
  | 'child_run.updated'
  | 'compaction.completed'
  | 'dream.finished'
  | 'payload.created'
  | 'payload.derived'
  | 'checkpoint.created';
```

Not every schema event is emitted by the current runtime yet. Widget-state,
skill enable/disable/rollback/curation, thinking delta, tool-call delta, and
derived payload events remain schema-reserved so these features can land
without changing the event-store model. Events that are emitted today still go
through the same append-only rules.

### Notification + attention projection

`notification.created` and `notification.read` carry the conversation list's
unread delivery + attention signal (M2 — [[agent-conversation-model]] §Background tasks).
A `notification.created` is **anchored to exactly one conversation**
(`conversationId`, mandatory — there are no conversation-less notifications) and
carries a `kind` (`task_completed` / `task_failed`; `needs_input` and `status` are
reserved with no emitter yet) plus an optional `source`
(`{ type: 'run'; runId }`) naming the off-floor run that produced it. A
detached child-run terminal emits one with an id keyed on the completion instant
(`notification-<runId>-<completedAt>`) so a *resumed* run that finishes again is
delivered, not deduped; a **user-initiated stop** raises none (the user's own
action); a child run left **running when the app dies** is marked failed and raises
its notification on the next restore. `needs_input` (reserved) would reuse the
run-log `user_question.*` lifecycle for the actual pause/answer/resume; the
notification only routes the attention signal to the origin conversation.
`user_question.answered` stores the resolved `AskUserQuestionResult`: either an
`answered` payload with per-question text, selected option ids, structured node
refs, local-file refs, and answer attachment payload refs, or a `discussed`
payload with a short message that closes the card and returns the run to normal
conversation. Path-backed answer attachments are materialized through the same
local-root jail as normal composer attachments before the event is appended.

Replay projects two derived structures on `AgentEventReplayState`:

- `notifications: Record<notificationId, AgentNotificationRecord>` — each record
  carries its `seq` and a derived `read` flag; `notification.created` is
  idempotent on `notificationId`.
- `attentionByConversationId: Record<conversationId, AgentConversationAttention>`
  — a **folded** per-conversation `unreadCount` with a `lastReadThroughSeq`
  cursor. Unread = notifications in that conversation with `seq >
  lastReadThroughSeq`. `notification.read { conversationId, throughSeq }` advances
  the cursor (monotonically) and marks matching notifications read; it scopes to
  its own conversation only. Because the whole model is event-sourced, an
  undelivered/unseen notification survives restart, and a notification appended
  after a read cursor re-counts as unread.

`notification.created` / `notification.read` are off-floor attention bookkeeping,
**not** conversation activity: they do not bump the conversation's `updatedAt` (so a
background delivery or a read never reorders or re-timestamps the conversation
list). The folded `unreadCount` is also carried on the persisted conversation index
(folded incrementally — `+1` per created, `0` per read-through-tail — matching the
replay reducer, so no full replay per delivery) so a badge can be **seeded on
launch** for listed conversations before they are reopened. The incremental `read →
0` step is only equal to the replay reducer because `markConversationRead` computes
`throughSeq` **inside the serial append queue** (the tail at write time), so the read
always covers every notification already in the log — including one that raced in
just before it. Snapshotting `throughSeq` outside that queue would let a delivery slip
a higher `seq` into the gap, leaving the replay reducer counting it unread while the
incremental fold collapsed to `0`: a permanent drift, since the index only rebuilds
on a missing entry. Marking a conversation
read is an **explicit signal that the user can see it** (`markConversationRead` → a
`notification.read` cursor): the renderer drives it only when the **agent dock is
actually open** (it collapses CSS-only while keeping the conversation loaded, so
"loaded" ≠ "viewed") showing that conversation — never on a config reload (which also
restores). The same dock-open + window-focus signal (reported to main as the *viewed
conversation*) governs OS-banner suppression: a banner is suppressed only when the
user is actually looking at that task's conversation.

Dream audit state is derived from the protected Dream channel's run meta plus
`dream.finished` markers. Durable model-readable memory is ordinary timeline
outline content; `dream.finished` entries are the audit summary, and the Dream
cursor is the maximum clean completed `dream.finished.window.end`.
Change counts are derived from the Dream-channel run's successful `node_create`
/ `node_edit` writes; a zero-write completion is a valid no-op — remembering
nothing is a normal Dream outcome, so it records a clean windowed
`dream.finished` marker with zero change counts, keeping a
considered-but-empty date window from being re-read. The no-op is gated on a
**clean** terminal state: a run that ended `completed` but was actually cut off
mid-work (an unresolved context overflow truncated it) carries an `incomplete`
flag, and a zero-write run that is
`incomplete` is treated as a **failure**, not a no-op — `dream.completed` is not
recorded and no clean completed window is recorded, so the span is retried rather
than silently dropped. There is **one** Dream — a runtime-only `memory-dream` skill run that
consolidates the user's member conversations into `#d-memory`, `#d-episode`,
`#d-belief`, optional `#d-question`, and optional `#d-guidance` nodes. Scheduled
Dream attempts use the fixed `agent.runtime.dreamSchedule` date-schedule string;
a failed due may retry after backoff, but at most three attempts are recorded for
that due before the runtime gives up until the next scheduled occurrence. Manual
Dream uses the same Dream-channel path and date-window machinery; a manual run
that completes a day suppresses scheduled Dream for that already-covered day.
Manual consolidate-only runs may have no new chat sources and can reconcile
outline/prior Dream context directly. The Dream run applies the valuable-memory
filter, uses `node_search` / `node_read` to
reconcile relevant prior `#d-*` memory and user-authored outline context, and —
when the run has memory worth writing — maintains at most one direct `#d-memory`
container under each source-date journal node and updates that container's
generated daily memory headline in place instead of creating multiple same-day
memory containers;
a run that finds nothing worth remembering writes no container at all. The run may write optional `#d-question` nodes for unresolved
tension and optional `#d-guidance` nodes for future handling, and may delete
obsolete nodes through `node_delete`; an episode does not need all child tags.
Prior Dream output is a belief graph to update, not self-confirming evidence. The
former agent-self / run-log Dream is cut (no
run-evidence harvesting, no per-agent self-model dream). Dream run meta is
anchored to the protected Dream channel so replay joins the run transcript. The protected Dream transcript is
visible audit history only: ordinary chat sends to the Dream channel are rejected
before persistence, the channel is forced out of Dream evidence, and Dream runs
start with an empty prior active path so previous Dream transcript rows are not
fed into the next Dream model context. Ordinary `past_chats` lookup also excludes
the Dream channel, so its reasoning/tool transcript is user-visible audit history
rather than recall material for normal chats. That audit history is retained as a
bounded transcript: after Dream completion, the runtime keeps the newest 512
Dream-channel runs and prunes older run ledgers, their anchor messages, their
`dream.finished` markers, and their search-index entries. The retention pass does
not prune durable outline memory nodes or the newest retained completed windows
needed for the derived Dream cursor.

## Message Model

Persisted message identity is Tenon-owned.

```ts
interface UserMessageCreatedEvent extends AgentEventBase {
  type: 'user_message.created';
  messageId: string;
  parentMessageId: string | null;
  content: AgentPersistedContent[];
  attachments?: AgentPayloadRef[];
  replacesMessageId?: string;
}

interface AssistantMessageStartedEvent extends AgentEventBase {
  type: 'assistant_message.started';
  messageId: string;
  parentMessageId: string | null;
  runId: string;
  providerId: string;
  modelId: string;
  apiId?: string;
}

interface AssistantMessageDeltaEvent extends AgentEventBase {
  type: 'assistant_message.delta';
  messageId: string;
  delta: AgentContentDelta;
  providerChunkCount: number;
  startedAt: number;
  endedAt: number;
}

interface AssistantMessageCompletedEvent extends AgentEventBase {
  type: 'assistant_message.completed';
  messageId: string;
  stopReason: string;
  content: AgentPersistedContent[];
  usage?: Usage;
}
```

Use pi-ai content block shapes at the bridge boundary, but do not make pi-ai's
runtime message array the persisted source of truth.

`assistant_message.delta` is the streaming transport. For completed turns,
`assistant_message.completed.content` is the final canonical content for replay,
search, debug projection, and pi-mono rehydration.

## Branching

Do not persist the old `mapping` tree as truth.

Persist parent links and branch selection events:

```ts
interface AgentMessageNodeEventFields {
  messageId: string;
  parentMessageId: string | null;
  replacesMessageId?: string;
}

interface BranchSelectedEvent extends AgentEventBase {
  type: 'branch.selected';
  leafMessageId: string;
}
```

The conversation branch projection derives:

- children per message
- current child per parent
- active linear path
- branch counters

Edit/regenerate flow:

```txt
old user message
  -> user_message.created with parentMessageId = old.parentMessageId
  -> replacesMessageId = old.messageId
  -> branch.selected(newMessageId)
  -> run.started from new active path
```

This preserves nodex's branch UX without persisting a mutable tree as truth.

## Tool Lifecycle

Tool calls and tool results are first-class events.

```ts
interface ToolCallStartedEvent extends AgentEventBase {
  type: 'tool_call.started';
  toolCallId: string;
  messageId: string;
  name: string;
  inputSummary: string;
  args?: Record<string, unknown>;
  inputRef?: AgentPayloadRef;
}

interface ToolResultCreatedEvent extends AgentEventBase {
  type: 'tool_result.created';
  runId?: string;
  toolCallId: string;
  toolName: string;
  messageId: string;
  parentMessageId: string | null;
  isError: boolean;
  content: AgentPersistedContent[];
  outputSummary: string;
  outputRef?: AgentPayloadRef;
}

interface ToolResultReplacedEvent extends AgentEventBase {
  type: 'tool_result.replaced';
  runId?: string;
  toolCallId: string;
  messageId: string;
  content: AgentPersistedContent[];
  outputSummary: string;
  outputRef?: AgentPayloadRef;
}
```

Runtime-emitted execution events carry `runId` so run-log assembly has an
explicit join key. Replacement events preserve the existing run ownership unless
they provide a more explicit `runId`.

`tool_call.completed` and `tool_call.failed` fire for **every** tool execution
(authoritative, unlike `tool_result.created`, which some built-in SDK tools never
emit). Replay handles them by stamping `outcome: 'completed' | 'failed'` onto the
matching `toolCall` content part — the durable, reload-surviving signal the
renderer uses to settle a tool row's status (see the live-header/tool-status rule
under Rendering). It is render-only metadata: the model context derivation never
includes `outcome`.

A run is a **linear spine**: every execution segment (an assistant continuation or
a tool result) sets `parentMessageId` to the run's own tail — the previous segment
— not to the addressing assistant message. This is load-bearing for **parallel
tool calls**: when one assistant emits N calls, their results chain `assistant →
result₁ → result₂ → … → resultₙ` instead of fanning out as N siblings of the
assistant. The visible transcript is the single-leaf active path (one child per
node), so sibling results would leave all but one off-path — invisible, and
rendered as resultless "Failed" rows. Results re-associate to their calls by
`toolCallId`, so spine order never affects which call shows which output.

The pi-mono projection reconstructs pi-ai messages as:

```txt
AssistantMessage(content includes toolCall)
ToolResultMessage(toolCallId, toolName, content)
```

The render projection may group thinking, tool calls, and tool results under a
single process block.

A successful file-producing tool result (`file_write` / `file_edit`) renders the
written path as a local-file chip — the same `InlineFileReference` the agent's
prose file references use, so a produced file reads identically to a referenced
one — plus an inspectable unified diff, instead of the raw model-visible JSON.
The chip carries `data-inline-ref-kind="local-file"`, so the app-wide
`InlineFilePreviewLayer` gives it hover preview; the chip shows the basename
while the full path stays on the preview/open path.

A transcript chip is a **pointer to a working file on disk**, so a **click opens
the center workspace area's file-only reader** with the same preview content shell
used by file preview panes. It reuses the active / available workspace pane rather
than adding a split pane or previewing in the agent dock. A **right-click** opens
the bespoke `AgentTranscriptFileMenu` — *Add to Today* (copy the source into the
asset store and create a file node under today's daily note), *Open with default
app*, *Show in Finder*. The split is **by location**, not by
node data: a chip is a transcript chip when it has a `[data-agent-transcript-chips]`
ancestor. That marker is set in exactly **one** place — the live assistant message
body (`AgentAssistantContent`) — so every chip a live turn renders (answer prose,
interim narration, and `file_write` / `file_edit` result chips) opens in the
workspace file-only reader, while the **same** components on meta surfaces (compaction / child-run summaries and
the child-run-details panel) have no such ancestor and keep the workspace preview.
An outliner file reference is a node-model field, never under this marker, so it
too keeps its workspace preview-pane click-to-open and native context menu unchanged.
(The working file is path-addressed; durability is what Save-to-outliner / Export
are for — see `docs/plans/agent-file-artifact-model.md`.)

`chat-source` inline references use the same chip renderer but navigate to agent
history instead of files. A click on a `conversation` source opens the agent dock,
selects that conversation, and scrolls to the first visible transcript row with
any projected message `sourceSeqs` entry inside the cited `(fromSeqExclusive,
throughSeq]` range. The short flash highlight is scoped to the cited message's
content body (for user turns, the user bubble), not the full transcript row. A
click on a `run` source opens the owning conversation and the matching child-run
transcript panel when the run ledger can be resolved; if that run also has a
visible parentless boundary row, the row is highlighted too. The renderer never
guesses by timestamp or text content; `sourceSeqs` are projected from the replayed
events that `past_chats` also exposes as source evidence. The marker renders as a
chat glyph plus the marker label, distinguishing it from node references (text
only) and local-file references (file glyph plus filename). Runtime Dream provides
a `chat_marker_template` with the target fixed and instructs the model to replace
only the label with a natural sentence fragment when a visible citation is useful,
so memory text reads continuously rather than surfacing bookkeeping labels such
as `source-1`. Dream avoids mechanically citing every line; one episode-level
reference may cover child nodes that rely on the same source.

## Conversation vs Runtime Transcript Projections

The on-disk store is physically split, and replay exposes two read seams:

- `getAgentEventConversationPath()` returns communication messages: user
  messages and final assistant replies. It excludes run-scoped execution
  messages: tool-result messages and assistant messages whose completed content
  is a tool call (`stopReason: 'toolUse'` or persisted `toolCall` content).
- `getAgentEventRuntimeTranscriptPath()` returns the joined pi-agent-core
  transcript. `AgentEventStore.readEvents()` performs the physical
  conversation/run join before reducer replay, so runtime consumers still read a
  valid parent-linked transcript.

This is the M0 F2 seam: product conversation views can stop treating tool
execution as communication, while pi-mono still receives a valid transcript with
assistant tool calls followed by matching tool results.

## Payload Refs

Large payloads live outside event lines.

```ts
interface AgentPayloadRef {
  kind: 'payload_ref';
  id: string;
  storage: 'file';
  mimeType: string;
  byteLength: number;
  sha256: string;
  scope?: { type: 'conversation'; conversationId: string }
    | { type: 'run'; conversationId: string; runId: string };
  role?: AgentPayloadRole;
  summary?: string;
  truncated?: boolean;
  display?: AgentPayloadDisplayMetadata;
}

type AgentPayloadRole =
  | 'source'
  | 'thumbnail'
  | 'preview'
  | 'text_extract'
  | 'tool_output'
  | 'debug';

interface AgentPayloadDisplayMetadata {
  width?: number;
  height?: number;
  durationMs?: number;
  pageCount?: number;
}

interface PayloadCreatedEvent extends AgentEventBase {
  type: 'payload.created';
  payload: AgentPayloadRef;
}

interface PayloadDerivedEvent extends AgentEventBase {
  type: 'payload.derived';
  sourcePayloadId: string;
  payload: AgentPayloadRef;
  derivation: 'thumbnail' | 'preview' | 'text_extract' | 'page_render';
}
```

Use payload refs for:

- provider request/response JSON
- long stdout/stderr
- large tool results
- images
- PDFs or rendered pages
- fetched web page bodies
- diff bodies

Rules:

- Events carry summaries and refs.
- Render rows never inline huge payloads.
- Debug panel loads refs on demand.
- Copy/open actions read refs directly.
- Payload refs are part of the authoritative event store bundle.

## Multimedia Payloads

Multimedia content is event metadata plus referenced payload files. Binary data
must not be embedded in event lines, React state, IPC snapshots, or debug rows.

Ingestion flow:

```txt
user/tool/provider produces media
  -> write source payload file
  -> append payload.created
  -> attach AgentPayloadRef to the message/tool/debug event
  -> derive previews asynchronously
  -> append payload.derived for thumbnails, page renders, text extracts, etc.
```

Represent media in three tiers:

- source payload: original image, PDF, audio, video, archive, or binary output
- derived payloads: thumbnails, previews, rendered PDF pages, OCR/text extracts,
  poster frames, waveform summaries
- render rows: small metadata and refs only

Renderer rules:

- Image rows render thumbnails or bounded previews first.
- Full-resolution media loads only after explicit open/expand.
- PDF rows render page thumbnails lazily, then page images on demand.
- Audio/video rows render duration, poster/waveform metadata, and lazy media
  elements.
- Object URLs must be created only for visible media and revoked when rows
  unmount.
- Markdown and transcript rows never receive base64 payloads.

pi-mono bridge rules:

- Send media to pi-mono only when the active model/tool path needs it.
- Prefer provider-native content refs or small derived text extracts.
- Do not expand full binaries into pi-mono messages unless the provider adapter
  explicitly requires that shape.
- Keep OCR/extracted text as derived payloads, not replacements for the source.

Deduplication:

- Payload identity should be content-addressed by `sha256` where practical.
- Multiple events may reference the same payload id.
- Global cross-conversation dedupe is optional; per-conversation correctness is
  required.

## Projections

### Pi-mono projection

Builds the active-path pi-ai `Message[]` for execution.

Inputs:

- event log
- active branch projection
- compaction events
- payload refs expanded only when needed

Output:

```ts
Message[]
```

This projection is the only place that should translate Tenon events into pi-ai
message shapes.

### Render projection

The renderer consumes compact rows, not raw events.

```ts
interface AgentRenderProjection {
  conversationId: string;
  revision: number;
  conversationTitle: string | null;
  activeRunId: string | null;
  // One run-active flag. Conversations are single-agent and inline-streaming, so
  // there is no DM-vs-Channel split: a serial run is either in flight or not.
  runActive: boolean;                                // serial run in flight (composer stop/steer)
  streaming: AgentStreamingRenderState | null;       // the inline streaming tail
  model: Record<string, unknown>;
  thinkingLevel: string;
  pendingToolCallIds: string[];
  errorMessage: string | null;
  rows: AgentRenderRow[];
  entities: AgentRenderEntities;
}
```

Rules:

- Completed rows are immutable by identity.
- Only the active streaming row changes during token streaming.
- `runActive`/`streaming` carry the single composer/stream state. There is no
  separate channel work surface and no per-mode flag pair: every conversation
  streams its active turn inline and drives the composer's stop/steer the same
  way. Conversation `kind` is never stored, and there is no Channel-identity or
  multi-agent-roster branch left to derive a mode from.
- The active turn streams inline. Its in-flight thinking, interim narration, and
  tool-call/segment events render live in the transcript through the streaming
  tail (`streaming`); there is no whole-utterance-only delivery path and no
  per-run channel activity surface. A run orphaned `running` by a crash/quit (absent
  from the live in-memory active-run set the runtime passes in via
  `options.activeRuns`, NOT merely persisted `status === 'running'`) still renders
  its interrupted turn rather than silently vanishing. A child run anchored to a
  live parent turn is folded into that turn (see the child-run rules below). On
  completion the turn renders through the **result-first fold** (final answer as
  prose, process collapsed behind "Worked for …").
- Render flushes are coalesced to at most one per animation frame.
- `compaction.completed` events become dedicated compaction rows keyed by the
  compact root message, with summary and trigger metadata in
  `entities.compactions`.
- The compact root user message remains available for pi-mono projection but is
  not rendered as a normal user bubble.
- Outside the protected Dream channel, historical `dream.finished` events become
  dedicated Dream boundary rows keyed by their hidden anchor message, with status,
  processed counts, and memory-change counts in `entities.dreams`. Inside the
  Dream channel, `dream.finished` is metadata attached to the visible manual or
  scheduled anchor, so the anchor remains an ordinary message row and the
  assistant/tool transcript stays inline. Users can trigger a manual run only
  from Settings, and durable Dream history is surfaced in Settings → Agent
  "Memory & activity" via the `agent_list_dream_history` IPC. Dream runs do not
  appear in the Work/Runs view; `AgentRenderDreamTaskEntity.principal` remains
  the Dream subject for audit labeling.
- `child_run.*` events back `entities.childRuns` — the conversation's permanent
  record of a run, whose final result is an expandable summary with a "View full
  run" link into the full transcript. **Where** that record renders depends on
  whether the run was spawned inside a turn:
  - **Turn fold (`parentToolCallId` set).** A
    child run is the agent's own implicit behavior — it quietly delegated a slice
    of the current turn — so it gets **no conversation-level boundary row**.
    Instead it folds into the spawning turn's process: the `agent` tool-call block
    is **kept** (not suppressed) and renders the child-run summary inline
    (`childRunsByParentToolCallId` → "Agent run · {description}", expandable to the
    result with the same "View full run" link). Because it lives inside the turn's
    own message, it is turn-anchored and branch-pruned with that message — editing
    the user message that started the turn removes it, with no orphan left at the
    transcript end.
  - **Boundary row (a parentless run).** A parentless run (a scheduled command
    fire) becomes a dedicated **child-run boundary row** in `transcriptRows`
    (kind `'child-run'`, keyed by run id), ordered by start time among the
    messages.
  - A running boundary row shows a live status line and is not yet expandable;
    once it seals it expands to the result (or error) and the full-run link.
    Boundary rows live only in `transcriptRows`, never in the active `rows` path.
- The Work/Runs view is a global run index backed by `agent_list_runs`, not a
  projection-only task list on the active conversation. Opening Work replaces the
  agent dock's chat body with the first-level run tree; opening a row switches
  that same body area to the second-level run detail view. The first level lists
  non-turn, non-Dream runs across channels as a compact task-list tree using
  `parentRunId`: each row shows the shared checkbox marker on the left, the run
  title as the primary text, and one muted metadata line
  (`channel · kind · status · time`); rows with direct child runs also show a
  trailing `completed/total` count on the title row. Row actions reveal on
  hover/focus. Expanded child runs render as checklist-style subrows below the
  parent content with fine separators, not as a strongly indented tree; the
  disclosure control sits on the trailing side, never before the checkbox marker.
  The detail view still reads the selected conversation's `entities.childRuns` and
  run transcript.
- Long output rows are collapsed by default.
- **Result-first turn fold (one flat level).** Every assistant turn renders
  result-first: the **final answer is the trailing text** after the turn's last
  thinking/tool block and shows as prose. **One** turn-level process fold
  (`AgentProcessBlock`, Codex's per-turn collapse — *machine C*) sits above that
  final answer and collapses/expands every earlier block. The fold renders the
  whole pre-answer body through a single `AgentProcessTimeline`: interim narration
  text ("let me check X first") is a row inside that timeline, reasoning renders as
  thinking rows, and adjacent tool calls fold into counted tool-activity groups
  (*machine B*, below). There is **no second per-narration "process group" nesting**
  — the turn fold is the only collapse level above the activity groups. A turn with
  no thinking/tools is a direct answer and renders without a fold. This is one
  mechanism with no per-mode forks and no single-tool inline special case. The
  turn partition (process vs final answer), the synthetic Working/Worked-for
  process item, and the stable disclosure ids are computed by a pure
  `agentTurnProjection` module (`projectAssistantTurn` → `AgentTurnProcessProjection`)
  that sits between the `AgentRenderProjection` message and the React components,
  so `AgentProcessBlock` / `AgentProcessTimeline` consume a ready projection
  rather than re-deriving message-flow semantics. The
  timeline body has **no left rail or indent**: every row's leading icon column
  left-aligns with the divider text above it, so the pre-answer body reads as a
  flat list under the "Working / Worked for {t}" header, not an indented sub-tree
  (Codex's layout).
- **Codex-style auto-collapse + persistent divider.** The turn fold mirrors
  Codex's *machine C*: while the turn is **working and has not started its answer**
  the body shows **expanded** (the user watches reasoning + tool activity stream
  1:1); the moment the **final answer starts** (`answerStarted` — trailing prose
  appears) the body **auto-collapses** to the divider with the answer streaming
  below. The header is a **persistent** divider that stays put through expand and
  auto-collapse — the live "Working" / "Working for {t}" clock while active, the
  "Worked for {t}" resting line once sealed — so it never disappears when the body
  opens. The fold renders immediately for an active assistant turn, even before the
  first thinking/tool block, so later tool events do not insert a new header above
  already-streamed text. A tool-free live answer keeps its prose in the normal
  answer position (not inside process narration), so the same markdown subtree
  survives the live→sealed transition. A **user toggle is sticky** for that process
  id and overrides the auto default through the live→sealed transition. The toggle
  is **persisted per conversation** (`agentDisclosureStore`, a localStorage-backed
  store keyed by conversationId → disclosure id — the renderer analog of Codex's
  `collapsedTurnsById`), so an explicit expand/collapse survives reload, conversation
  switch, and the row remount; absence of a stored choice means the auto default
  applies. (A detached preview row with no conversationId keeps ephemeral state.)
  In the **expanded** timeline the spinner is per row: while the turn is
  live, **every un-settled tool row** (no result, no `outcome`, no child run) spins,
  not just the most recent one — so when an assistant fans out a parallel tool batch,
  the earlier calls never flash red in the frame before the runtime populates
  `pendingToolCallIds`. The same un-settled rule drives the collapsed activity-group
  summary and the process header's counted "Ran N commands" status, so a parallel
  batch is never miscounted as failed mid-turn. A call settles (and stops spinning)
  the instant it gains a result, an `outcome`, or a child run; once the turn ends, an
  un-settled call falls through to its real error/incomplete state rather than
  spinning forever.
  - A **resultless** turn (last visible block is a thought/tool — no trailing
    answer prose) drives two SEPARATE decisions, decoupled so a cleanly-completed
    turn never mislabels:
    - **The red "Interrupted" label + error styling** fire ONLY when the run was
      **genuinely interrupted** — its producing run `failed`, was `cancelled`, or
      was left `running` by a crash. This is the authoritative **`turnInterrupted`**,
      stamped on the message entity by the core projection from the run's *real*
      status, NEVER inferred from block structure. A cleanly `completed` resultless
      turn is **never** red. **Interruption is a property of a SETTLED turn:** the
      verdict is additionally gated on `!turnActive`, so a turn that is still
      working never reads as interrupted. `turnInterrupted` is per-message (one
      run's status) while `turnActive` is per-turn (the conversation has a live
      run), so a failed/cancelled run still on the path while a newer run is
      already recovering it — **retry / reactive-compaction** — would otherwise
      paint the live, streaming turn RED ("Interrupted after thinking") even as
      its stop button and streaming process are on screen.
    - **Surfacing the process** (auto-expand so its interim work / error context
      isn't buried — `surfaceResultlessProcess`) fires for a genuine interruption
      AND — per the result-first design — for a sealed resultless turn the user
      watched stream 1:1. A surfaced resultless
      turn also suppresses the "Worked for …" resting header (which would read as a
      clean unit of work and hide that there is no answer), falling back to the
      descriptive group summary.
  - (Tying the *label* to the run's real status — not to the mere absence of
    trailing prose — is what fixed the recurring resultless-turn mislabel: the old
    `turnEnded && !finalIsProse` rule painted every result-less turn red regardless
    of outcome. Keying the result-first *split* off the *trailing* answer, not *any*
    text in the turn, still stops a surfaced resultless turn from burying interim
    narration behind a collapsed header.)
  - **Default-open states:** a working turn with no answer yet (auto-expand, above)
    and a surfaced resultless turn. Every other steady state — answer streaming, or
    sealed — defaults collapsed. The **sticky override wins**: once a user toggles
    the block it keeps that choice through live→sealed; completion only updates the
    same disclosure row's header.
- **Persistent live divider.** While the turn is active the header is the ticking
  clock — bare **"Working"** under one second (no number, so it never flickers a
  "0s"), then **"Working for {t}"** once a whole second elapses. The clock is
  driven by `runStartedAtMs` (the producing run's `startedAt`, threaded onto the
  message entity **only while the run is running**; a `useElapsedTick` hook
  re-renders once a second and is gated on the live segment, so a sealed/crashed
  run never keeps ticking). The divider is the header **whether the body is
  collapsed or expanded** — it stays put through the auto-collapse. The single
  activity spinner rides the trailing slot only while the process is **collapsed
  AND working**; once the body expands the spinner moves to the running tool row in
  the timeline. The trailing affordance is a **`chevron-right`** that rotates 90° to
  point down when the body opens (not a flipping up/down caret), and — unlike the
  reasoning/group chevrons — it stays **visible at rest** on this turn-fold header
  (Codex shows `Worked for 5m 29s ›`). A faint **full-width hairline**
  (`.agent-process-rule`, `currentColor` /20 ≈ Codex `border-current/20`) sits under
  the resting fold line, just above the answer — shown only in the collapsed
  Working/Worked state (an interrupted RED label is not a divider, and an expanded
  body provides its own structure). Once the turn **seals**, the header reads
  **"Worked for {duration}"** (codex-style; duration = the producing run's
  `updatedAt − startedAt`, threaded as `runDurationMs` on the message entity
  **only once the run is sealed** — a still-`running` run, whether live or left
  running after a crash, has `updatedAt === startedAt` and so no meaningful
  wall-clock, and is left unknown rather than shown as "<1s"; a multi-run turn
  sums each run's wall-clock). When the duration is unknown the header falls back
  to the static group summary — a **counted, kind-named, tense-aware** activity
  line ("Ran 3 commands · read 2 nodes", "Thought · searching the web"), not a
  generic "used N tools". A tool call's
  **settled outcome** is authoritative for its status: replay stamps
  `outcome: 'completed' | 'failed'` onto the `toolCall` content part from the
  `tool_call.completed` / `tool_call.failed` events (independent of whether a
  `tool_result.created` ever lands — some built-in SDK tools complete without one).
  A settled `outcome` resolves the row to **done**/**error** even with no result
  message, so a completed step never spins forever. Only a tool call that is
  **neither** settled nor resulted is eligible for the live-activity heuristic: a
  row is running when its id is present in `pendingToolCallIds`, and the renderer
  may use an active-turn fallback for the latest *un-settled, resultless* tool only
  when the projection currently reports no pending ids at all. It must not treat
  every resultless tool call in an active turn as pending, because later
  continuation text can coexist with an earlier resultless/stale tool row. A **genuinely
  interrupted** turn (run `failed`/`cancelled`/crash-orphaned —
  `turnInterrupted` — with no trailing answer) keeps the "Interrupted…" label,
  never a duration. A cleanly `completed` resultless turn never shows
  "Interrupted": it surfaces its process (per the result-first design) under the
  descriptive group summary rather than the "Worked for …" resting header.
- **Consecutive tool calls fold into one counted activity group** (Codex's
  render-group split, `splitTimelineIntoGroups`/`summarizeToolActivity` in
  `agentRenderGroups.ts`). Inside the expanded process timeline, a maximal run of
  ≥2 adjacent **non-child-run** tool calls collapses into a single
  `AgentToolActivityGroup` disclosure whose header is the counted summary,
  expandable to the member rows. A thinking or narration block — a child-run
  tool call (rich inline content), and a **loaded-skill chip** (a compact
  glanceable affordance, not an expandable row) — **breaks the run** (reasoning is
  a hard boundary); a lone tool call renders standalone, never wrapped. The summary
  buckets members by activity kind (`toolActivityKind`), dedupes file/read kinds by
  subject (editing the same node twice reads "Edited a file") keyed on the model's
  **raw snake_case wire args** (`node_id`, `file_path`), expanding a `node_ids`
  batch to one subject per id so a 5-node read counts as 5. Node *creation* is not
  deduped — a new node has no pre-execution id, so N creations under one parent are
  N distinct files. The summary uses the **per-kind** running/done tense so a
  finished command beside a still-running search reads "Ran a command · searching"
  — never a group-global mislabel. This
  is Codex's per-tool-activity-group collapse (machine B) nested inside the
  per-turn process fold.
- **Per-step glyph by exception** (Codex machine A, `progress-step-row`). A tool row
  leads with its **tool-type icon by default — success carries NO badge**. The
  past-tense verb ("Fetched web …", "Read a node") already reads as success, so a
  green success check is redundant noise; a **done** step shows its plain tool icon.
  Only states that need attention get a glyph: **running** the spinning ring;
  **failed** a red ✕ inside a subtle danger ring (`--status-danger` /40 border, /15
  fill) + red row text — the only badged state, reserved for a **confirmed failure**
  (an error result or a failed outcome). A tool that simply never settled — no
  result, no outcome, not running, turn over (e.g. the tail of an interrupted batch)
  — is **`incomplete`** and likewise shows the neutral tool icon; **done and
  incomplete are not visually distinguished** (neither needs a badge — only a failure
  stands out). Codex's `pending` (declared-but-not-*started*, a dim hollow ring)
  remains **deferred**: our projection does not cheaply distinguish it from `running`.
  The ✕ ring fades out with the glyph when the disclosure chevron reveals on hover.
- **Reasoning folds like a tool step; narration is body prose.** Inside the
  expanded turn (machine C) the three kinds of block render at three different
  weights, matching Codex's typed items — they are NOT one uniform body:
  - **Interim narration** is the assistant's own SPEECH (Codex `assistant-message`,
    `text-primary` = full foreground) → shown in **full** at the same bright
    `--text-strong` as the final answer (`.agent-process-narration`). The running
    commentary reads continuous with the answer below it; only the tool steps and
    the "Worked for {t}" divider separate them.
  - **Reasoning** is the model's THINKING (Codex `reasoning`) → it **collapses like
    a tool step**: a one-line row (`.agent-reasoning-toggle`) with a trailing
    `chevron-right` (hover-revealed; rotates 90° to point down when open), the full
    thinking **tucked inside** and revealed on click — NOT shown as open body prose.
    The leading label is the **fixed lifecycle word** — **"Thinking"** while the
    thought streams, **"Thought"** once the turn settles — never the thought's own
    first line as the headline (the ratified 折中: Codex's uniform reasoning-minimal
    label, but without the per-item "Thought for {t}" timing our projection does not
    track). Collapsed, a **dim one-line gist** of the first line (markdown emphasis/
    heading markers stripped; `.agent-reasoning-gist` at `--text-faint`, truncated)
    trails the label — Codex previews the body under the header; this is the
    single-line form — so a column of reasoning rows stays distinguishable rather than
    a wall of identical "Thought". The whole thinking text is the body: a streaming row
    opens (the user watches it 1:1) and a sealed row rests folded (except a lone-thought
    turn, which opens by default); expanded, the gist gives way to the full body, soft
    (`--text-soft` ≈ Codex `text-secondary`), the dimmer thinking layer distinct from
    the assistant's own words.
  This is the fix for "reasoning shows fully expanded": only narration (assistant
  speech) is open body prose; reasoning, like every tool, folds to a summary the
  user expands on demand. There is no lightbulb and no meta typography — the fold is
  a clean chevron row at content register.
- **Reasoning active cue.** A reasoning row's headline is a **static lifecycle
  label** — **"Thinking"** while it streams (no ellipsis and **no shimmer**: the
  cadenced shimmer is a Codex Statsig A/B experiment, not the default; the live
  surfaces are the static label + the per-step spinner), sealing to **"Thought"**
  (with a dim one-line gist of the first line beside it, above) once the turn settles.
  Only the **timed** variant — Codex's "Thought for {elapsed}" — remains deferred (it
  needs per-reasoning-item timing we do not track); the sealed label **is** adopted,
  with the full thinking kept one click away in the body so nothing the user watched
  stream is lost.
- **One assistant-turn renderer.** The conversation transcript and the child-run
  task detail timeline both render assistant content through the
  same assistant turn/process fold components. The task detail panel reads a raw
  child-run transcript, but only adapts it into normal transcript rows; it does
  not own separate thinking/tool/result UI. A running task only marks the
  transcript's last assistant turn live when that turn is actually unfinished
  (pending tool call or null stop reason); task-level running status stays in the
  panel header/actions. The child-run adapter also threads the run terminal
  status and wall-clock into the last assistant row, skips hidden-only context
  user rows, and renders orphan tool results as capped plain text rather than
  markdown. This keeps the differences at the data-adapter boundary instead of
  forking presentation behavior.
- Large details are refs, not row payloads.
- **Context slimming is invisible to the transcript.** Budget offload and
  time-based microcompact shrink only the *model's* copy of a tool result: a
  `tool_result.replaced` writes a separate `modelSlimmedContent`, leaving the
  reduced record's `content` full. So `toRenderMessageEntity` (and the
  `buildToolResultMap` it feeds) always render the full output — an old
  `web_search` / `web_fetch` row never decays into input-only / no-output. Only
  the debug projection above, a model-context inspector, surfaces the slimmed
  copy. (Slimming authority: [[agent-pi-mono-implementation]].)
- A run/provider failure rides on the terminal assistant message: the run marks
  it `assistant_message.failed` (error stop reason + `errorMessage`), so it
  renders inline as a failed turn with a retry action — not as a separate
  banner. The top-level `errorMessage` field is reserved for transient
  operational errors delivered out-of-band via the runtime `error` event (e.g.
  attachment/queueing failures), never run failures. Context-overflow failures
  are left unmarked because reactive compaction recovers them automatically.

### Debug projection (run-grounded — [[agent-debug-run-grounded]])

The run-details surface is a read-only **view of one concrete run**. It is opened
with `(conversationId, runId)` from a specific assistant reply, then loads that
run through `agent_debug_run`; it does not render the old conversation-level
debug timeline or a selector over every run in the conversation. Its pane chrome
uses the shared pane breadcrumb/close layout used by node and file panes. The
projection is loaded on open and refreshed from agent runtime events; there is no
separate manual refresh button in the pane toolbar.

The pane groups the run projection by inspection task:

```txt
run
  modelInput
    system/developer prompt
    tool definitions
    initial request messages
  execution[]
    responseParts[]
    toolExchanges[]
    usage
```

The run detail is ordered for inspection:

1. **Run summary** — a flat overview of compact diagnostic facts: model/provider,
   duration with the start/end range, model/tool-call counts, input-context
   tokens, output tokens, cached share, aggregate cost, and non-default status
   only when the run is not completed. It is not a nested metrics card, and it
   does not surface agent kind or raw identifiers (`runId`, `agentId`, parent ids)
   as primary content.
2. **Model Input** — the input side that seeded this run: system/developer
   instructions, tool definitions/schemas, and the captured provider message
   window (history/current user/file context, or the compacted summary message if
   compaction already replaced older history) from the final outbound provider
   request, normalized for display. The message window is presented as direct
   sibling sections: `History` (messages before the final outbound user message)
   and `Current request` (that user message and its attached reminder/file/text
   parts), preserving provider order inside each slice. Model Input uses one
   disclosure-row grammar throughout: top-level items show only their label and
   count, messages provide scoped one-line summaries, and rows use short labels
   such as `user`, `asst`, `call`, and `result` instead of exposing transport
   roles. Each part can expand into the full body. The section renders these
   disclosures directly rather than wrapping them in an additional frame.
3. **Execution** — the execution side. Each rendered item is a provider call
   (internally, one debug `round`: one provider request/response). The visible
   header labels it as `Call N`, hides the default completed state, and keeps
   only non-default status plus an `Info` affordance. Each call is a collapsible
   disclosure, default-open. The `Info` hover uses the same token/cost breakdown
   format as the assistant-reply hover, scoped to that provider call. The body is
   a flat, expandable call-event list using the same row grammar as Model Input:
   a short semantic label (`think`, `asst`, `call`, `result`) plus a one-line
   summary, followed by the expandable full body. Tool result
   rows use the same part-disclosure control as the rest of the pane, and orphan
   tool calls are synthesized from the exchange args only when the provider
   response did not capture the original tool call.
   Calls render as a lightweight disclosure list directly under the Execution
   header; each `Call N` header uses the same top-level disclosure row hierarchy
   as `System prompt` / `Tools` / `History` / `Current request`, with subtle
   dividers rather than separate cards. The run summary carries the main
   token/cost readout.

The chat transcript exposes this through an assistant-message **Details** icon
button that uses the `Info` glyph. Hovering it previews the whole run's token and
cost summary, not merely the final provider call's usage. Call-level usage is
shown only on each **Execution → Call N** info hover. Both previews include cached
share when cache activity exists. Cached share is derived from the normalized
usage as `cacheRead / (input + cacheRead + cacheWrite)` so it describes the
portion of this input context served from cache, not provider-specific cache-hit
semantics; clicking opens a run-details pane keyed by that reply's
`runId`. If the same run pane already exists, it is activated; opening a
different reply opens or repurposes a pane for that different `(conversationId,
runId)`. There is no standalone/global debug entry in the agent dock.

The internal debug unit is `round` = one provider call = `(request, response)`,
bounded by `assistant_message.started` (always present, independent of any wire
capture). `round` is not a user-facing agent concept; the UI labels it as a
**Call** inside **Execution**. Walking a run's own stream in order yields
its rounds: each `assistant_message.started`
opens a round, its `.completed` closes the response (content / usage / stopReason
from the ledger), and the intervening `tool_result.created` (and `tool_result.replaced`,
which records what the model saw after output slimming) are that round's tool
exchanges. A `run.failed` / `run.cancelled` with a round still open (a crash mid-stream
left no terminal `assistant_message`) closes that round with the run's terminal
status, so a round's pill never reads *running* under a Failed run.

**A run's own ledger is not self-sufficient** — two kinds of event live in the
CONVERSATION stream (appended with no runId) and are spliced in at derivation:

- The **triggering user message** (`user_message.created`, appended before
  `startRun`). It is prepended ahead of `run.started` so it folds into round 0's
  request window — without it, every turn run's first window would be empty. (A
  child run already carries its directive in its fork prefix, so the splice is
  skipped when the trigger is already in the run stream.)
- **Conversation-budget `tool_result.replaced`** slimming. It is matched to the
  producing run by the globally-unique `toolCallId` (NOT stamped with a runId — the
  slimming usually runs during a *later* turn than the one that produced the
  result), so the run that owns the call reflects the slimmed output regardless of
  which run did the slimming. A replacement matching no call in a run is dropped;
  only a `tool_result.created` may OPEN an exchange (never an empty-named phantom).

A round stores the *new* context entering that provider call (the triggering /
prior tool-result messages), not the whole growing history. This `requestWindow`
is an internal derivation aid for the execution tree; **Model Input** is sourced
from the captured provider payload's full message window. Rounds begin only after
the run's own `run.started`, so a child run's inherited fork prefix is folded into
the first round's internal window rather than counted as a model call.

**Everything rendered is redacted.** The surface is read-only but on screen, so
every string passes the shared `agentSecretRedaction` gate before display:
secret-keyed object values, value-pattern matches over free text (sk-/PRIVATE KEY
/ `Bearer …` / GitHub / JWT / `password=…`), and large-blob elision (inline base64
→ a length note). This covers tool-call arguments, tool RESULTS, message text,
thinking, and the per-run system prompt + tool schemas alike.

**Capture (the only additive writes).** The semantic tree is already in the
ledger; one gap is filled: a per-run `debug.run_snapshot.created` event carries the
run's outbound **system prompt + tool schemas + model input message window** from
the final provider payload after transport-specific rewriting, deduped on an
in-memory content hash (re-emitted only on a real provider-request shape change;
the hash is recorded only **after** the append succeeds, so a swallowed write
never poisons the dedupe — and never persisted on the event, which no reader
needs). It is replay-neutral. The detail view reads system/tool metadata from the
latest snapshot, but **Model Input** uses the first captured non-empty message
window so later tool-result calls do not overwrite the run's entry context. File
parts are normalized to file placeholders for display instead of expanding inline
file data. The system prompt is read tolerantly across providers: a
top-level `system` / `instructions` (Anthropic) **and** a `system` / `developer`
role message folded into `input` / `messages` (the OpenAI responses / completions
shape).
(Delegation/child request-context capture — plumbing the child run id through the
delegation agent's payload callback — per-ROUND snapshot attribution when the
system/tools change mid-run, and per-round transport metadata + a gated byte-exact
wire disclosure are scoped follow-ups, deliberately **not** pre-modeled in the type;
the view degrades gracefully to no system prompt / empty tools / legacy
request-window messages when a snapshot is absent. Legacy message fallback is
explicitly labelled in the UI because it is not the full provider input window.)

**Read model + IPC.**

- `agentDebugView(conversationId)` → the tree: per-run summary nodes (agent, kind,
  status, model, **real usage**, round count), the conversation shape, and rolled-up
  totals. The tree builds each node from a LIGHT summary pass (`summarizeRunStream`:
  one scan of the run stream for round count + last provider/model + usage) — it
  never materializes the per-round detail / request windows / redaction it would
  immediately discard. **The conversation shape comes from the conversation's
  authoritative member roster** (`readConversationMetaProjection`) — always
  `{user, Neva}` — not from distinct run executors, so a conversation that
  delegates to a sub-agent never shows the transient sub-agent as a member. The
  agents that actually executed runs are surfaced separately by the renderer
  (derived from the runs) so a delegated sub-agent is still filterable. Run usage
  is `meta.usage` when the run terminated, else **rolled up from the rounds** so an
  in-flight run's totals stay live instead of reading zero. Reads the store
  directly, so it works on closed conversations. Believer-anchored Dream runs are
  excluded (they span conversations).
- `agentDebugRun(conversationId, runId)` → one run's full detail (rounds + per-run
  snapshot), derived from `readRunStreamEvents(runId)` spliced with the conversation
  context (above) and cached by the run's `latestSeq` + the conversation context seq
  (so it invalidates when slimming of its tool results lands). `parentToolCallId` is
  sourced from the parent conversation's `child_run.started` (never in the child's
  own ledger). The conversation context itself (trigger messages / parent links /
  slimming) is read ONCE from the conversation segment (`readConversationStreamEvents`,
  not the full merged `readEvents`) and cached by the conversation `latestSeq`, shared
  across every run in the view. All three debug caches are bounded LRUs. Works for
  `turn` and `delegation` runs
  alike — the seq convention is irrelevant to a single-stream walk.

The pure derivation lives in `src/main/agentDebugView.ts`; the renderer
`AgentDebugPanel.tsx` renders every conversation with one run list (single-agent,
members `{user, Neva}`), attributes each run to its agent, and eagerly loads the
currently selected run detail. It re-fetches the selected detail when the run shape
advances so in-flight usage and rounds stay live without subscribing React to raw
token events.

It must not:

- own runtime truth
- subscribe React to raw token events
- force payload refs into normal chat state
- block transcript rendering

### Conversation index projection

Conversation list/search metadata is a derived index.

It may cache:

- title
- updatedAt
- first user prompt
- last prompt
- model/provider
- user message summaries
- tags later if needed

If conversation/search/user-message indexes are corrupt or missing, discard them and
rebuild them from event logs.

Search/user-message indexes are candidate projections, not authority. Their
normalized text uses the shared text-search analyzer so node search and internal
conversation-history lookup agree on whitespace, punctuation, CJK grams, and
query-term handling. Internal conversation lookup must still apply
conversation/date/current-conversation filters, replay each candidate
conversation's visible active branch, and verify the visible message text before
returning a hit. It sorts verified hits by relevance first, then conversation
recency, then message
recency; recent-user-message lookup stays recency-only. The foreground model sees
`past_chats` for visible prior chat lookup and uses `node_search` / `node_read`
for durable `#d-*` memory nodes; runtime-owned Dream consolidation uses the same
raw source dereference path.

## Streaming Strategy

Streaming has two separate paths:

```txt
provider chunks
  -> pi-agent-core
  -> Tenon stream accumulator
  -> coalesced assistant_message.delta events
  -> render projection flush <= 1/frame
```

Do not persist or send a full conversation snapshot per token.

Canonical text deltas should be coalesced into short segments:

```ts
interface AgentTextDelta {
  type: 'text_delta';
  text: string;
}
```

Each delta segment records:

- provider chunk count
- segment start/end timestamps
- message id
- run id

Optional raw provider events can be recorded in debug payload refs or a debug
side stream, but they are not required for replaying the user-visible
conversation.

Flush policy:

- render projection: `requestAnimationFrame` or 16ms throttle
- event write: immediate for user messages and terminal events
- stream delta event writes: batched by segment
- provider request debug payload writes: awaited before the provider stream
  starts, so request snapshots and assistant completions keep stable event order
- provider response debug payload writes: captured after HTTP response metadata is
  available and before the response body is consumed; they do not bind usage or
  assistant content in debug totals
- later non-critical debug payload writes may use a slower batch, such as 250ms
  or size threshold
- terminal events always flush

## Checkpoints

Checkpoints are caches, not truth.

Create checkpoints:

- after a completed run
- after compaction
- after large event-count thresholds
- before pruning old payloads

Checkpoint content:

- latest included `seq`
- latest included event id
- target file byte offsets for the conversation segment and each run log
- replay state needed to rebuild active branch, render/debug projections, and
  pi-mono messages

Restore:

```txt
load latest checkpoint
  -> verify target offsets are not past the physical file tails
  -> read the conversation segment and indexed run logs from checkpoint offsets
  -> replay events after checkpoint.seq
  -> rebuild projections
  -> hydrate pi-agent-core when execution starts
```

If checkpoint load fails, replay the joined target logs from the beginning.
Checkpoint writes only commit when the supplied replay state matches the current
event-log tail `seq` and event id; stale replay state must not write a
checkpoint.

## Large Conversation Performance

A large conversation should not block normal outliner editing or chat rendering.

The hot path must never do these things:

- parse the whole event log for every token
- send the whole conversation over IPC for every update
- keep every transcript row mounted in the DOM
- inline large tool/media payloads into render rows
- re-lex completed markdown blocks during streaming

Open-conversation policy:

- The conversation list is read from `conversation-index.json`: conversations are
  the only primitive (no per-agent DM rows, no two-list / two-"+" split), and a
  row is listed when it carries a name (the conversation name lives in the legacy
  `goal` field). The reserved `lin-agent-channel-general` row is always ensured
  and sorts first as `#General`; every other row sorts by recency.
- `#General` is a normal event-sourced Conversation with `title/goal = General`.
  It stores no `kind`; its reserved id plus the runtime invariant make it special.
  Runtime ready, restore, list, and agent-registry reload all ensure it exists
  with members `{user, Neva}` (the single agent). The ensure is idempotent:
  repeated startup/list/reload calls do not append duplicate `member.added`
  events. Agent definitions are delegation child-agent types, not conversation
  members, so no roster ever joins a conversation.
- Every conversation — `#General` and user-created topic conversations alike — is
  a single-agent, inline-streaming, steerable thread whose members are implicitly
  `{user, Neva}` and not membership-editable. `#General` cannot be renamed or
  deleted; named topic conversations can. The Agent Dock startup path restores a
  remembered valid conversation id first, then falls back to `#General`.
- `conversation-index.json` carries list projection fields, including member
  roster (always `{user, Neva}`), unread count, message count, and the latest
  visible message snippet / timestamp. Opening the conversation menu does not
  replay each conversation log.
- Opening a conversation loads the latest checkpoint, reads the conversation segment
  and indexed run logs from the checkpoint target offsets, then replays only
  events after the checkpoint `seq`.
- If no usable checkpoint exists, replay falls back to the full joined log; a
  background progress UI can be added later if very large cold conversations need it.
- The active transcript starts from the render projection and uses row
  virtualization for long conversations.

Render policy:

- Completed rows are immutable and can be memoized by id/revision.
- The streaming row is the only row updated per frame.
- Transcript virtualization starts before row count becomes visible to users.
- Large text/tool outputs are windowed inside their own row.
- Expanding media or debug payloads creates localized state, not a new conversation
  projection.

Storage policy:

- Streaming text deltas are coalesced before persistence.
- Large outputs are payload refs, so event files remain mostly metadata.
- Checkpoints are written after completed runs and large event-count thresholds.
- Old checkpoints may be pruned; event logs and referenced payloads are not
  pruned unless an explicit retention/archive policy exists.
- The Dream channel is the current explicit conversation-run retention policy:
  only its latest 512 run transcripts stay in the channel log/search index; older
  Dream run ledgers and their launch/terminal markers are pruned.

## Runtime Flow

### Send

```txt
user sends prompt
  -> append user_message.created
  -> append branch.selected
  -> derive active pi-mono Message[]
  -> create/hydrate Agent
  -> append run.started
  -> stream pi-mono
  -> append assistant/tool events
  -> append approval events when approval runtime is enabled
  -> on failure, append assistant_message.failed for the terminal assistant turn
  -> append run.completed or run.failed
  -> write checkpoint
  -> update render/debug/conversation index projections
```

### Restore

```txt
open app
  -> clean-cut probe: any old-format artifact wipes the agent data root
  -> load conversation-index cache if it matches conversations/
  -> load selected conversation checkpoint
  -> replay later events
  -> derive render projection
  -> hydrate pi-mono only when a run is started or continued
```

### Debug

```txt
debug panel opens
  -> request debug projection
  -> load event timeline summary
  -> lazy-load payload refs on expansion
```

## What Becomes Obsolete

These are obsolete and must not be reintroduced as durable truth:

- `agent-chat-sessions.json`
- full chat snapshots as the main renderer contract
- mutable `AgentChatSession.mapping` as persistence
- `AgentDebugSnapshot` as independent stored truth
- full pi-agent-core `agent.state.messages` as persistence

The current renderer contract is `AgentRenderProjection`, carried by
`AgentRuntimeEvent` over the `lin-agent-event` channel.

## Implementation Status

### Landed

- Split conversation/run filesystem layout with conversation segments,
  run-local `events.jsonl`, run meta, scoped payloads, and agent identity
  records.
- Strict append ordering, per-conversation write queues, and replay reducers.
- Parent-linked message chain with active branch projection.
- pi-ai `Message[]` derivation from the joined conversation/run active event
  path.
- Stable built-in runtime agent identity (`built-in:tenon:assistant`) on
  agent-authored events and message records.
- Internal domain-event bus lanes for persisted-log, renderer-projection,
  trusted-observer, and hook-interceptor consumers.
- Run-scoped runtime state (`activeRun`) for active assistant text, tool output
  payload refs, tool-call message mapping, and the last submitted prompt.
- `AgentRenderProjection` IPC instead of full chat snapshots.
- Provider debug payload refs and event-derived debug history/totals.
- Large tool output payload refs with bounded model-visible labels.
- Conversation index, search index, and user-message index as rebuildable projections.
- Checkpoint writer/loader with target-offset + seq tail replay,
  corrupt-checkpoint fallback, atomic writes, stale-state guards, and best-effort retention of the latest three
  valid checkpoints.
- Transcript row virtualization and bounded large-output rendering.
- Shared append-only seq-log internals for conversation/run JSONL tails,
  offsets, queues, and seq caches, plus tolerant torn-tail handling for
  high-write run sidecars.
- Mixed-resolution runtime context assembly: compacted historical ranges render
  as compaction summaries for the model path while visible transcript replay can
  still expand archived raw/tool messages.
- Runtime consumers for `user_question.*` events, plus file-tool skill write
  validation/hot reload. Skill audit events are run-scoped tool-execution audit
  detail, not conversation replay state.
- Notification + attention replay projection: `notification.created` /
  `notification.read` fold into per-conversation `attentionByConversationId`
  unread counts and per-notification `read` flags (the M2 off-floor delivery
  signal's durable substrate; runtime emitters + renderer surfaces are the
  remaining consumer work).

### Remaining

- Performance instrumentation events and UI-facing analysis views for replay,
  projection, IPC bytes, render commits, and long transcript behavior.
- Richer non-text media previews and lazy full-payload loading in render/debug
  detail views.
- Memory consolidation beyond explicit tool writes, including extraction from
  summaries and mixed-resolution memory retrieval.
- Notification **delivery**: emitting `notification.created` on off-floor task
  terminal/needs-input states, the durable per-conversation in-stream message,
  the unread badge in the conversation list, and the opt-in OS notification
  (M2 — [[agent-conversation-model]] §Background tasks).
- Optional checkpoint retention preferences if real conversations show storage
  pressure.

## Success Criteria

- There is exactly one durable product truth: the agent event-log family.
- Deleting checkpoints and indexes does not lose agent state.
- Deleting render/debug projections does not lose agent state.
- pi-mono can be rehydrated from event-derived messages.
- Debug panel can explain a run without slowing normal chat.
- Streaming a long assistant response does not stall outliner editing.
- Large media and tool outputs do not enter event lines, IPC snapshots, or React
  transcript state.
- Branching, retry, edit, and tool lifecycle are represented as events; approval
  and compaction are already reserved in the schema and should be emitted when
  those runtime features become active.
- Self-maintenance mutations are reconstructable from events and never require
  reading raw settings files in the renderer.

## Non-Goals

- Replacing pi-mono.
- Reimplementing provider adapters or stream parsing.
- Persisting raw provider chunks as the normal render model.
- Rendering raw event logs as the transcript.
- Keeping mutable tree snapshots as durable truth.
- Streaming outliner document edits token by token.
- Building a global blob store before per-conversation payload correctness exists.
