# Agent Event-Sourced Runtime

This document is the canonical architecture for Tenon's current agent
data, debug, persistence, and rendering model.

## Decision

Tenon uses an event-sourced agent runtime.

The durable product source of truth is the **Agent event-log family**:

```txt
conversation segments + run events + agent identity/memory logs + referenced payload files
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
- self-maintenance audit events for runtime config, hooks, doctor, recovery,
  skill write previews, skill writes, and skill rollback

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
- `src/main/agentDebugProjection.ts`: derives debug history and totals from
  debug events, assistant completions, and debug payload refs.
- `src/renderer/agent/runtime.ts`: adapts `AgentRenderProjection` into the
  renderer store/view consumed by the React agent UI.

The old mutable chat snapshot store is no longer part of the runtime.

## Renderer Projection UX

`AgentRenderProjection` is also the authority for the current conversation UI:

- `entities.messages[*].actor` identifies who produced each message. The
  renderer resolves it through `members[]` and the agent-definition registry for
  display names, `@` mentions, and the deterministic circular identity chip.
  Channel rows show this attribution for every assistant message, including the
  coordinator; a departed member falls back to the recorded id/mention rather
  than erasing historical identity.
- Message `createdAt`/`updatedAt`, `providerId`, `modelId`, and `usage` are quiet
  metadata. The transcript renders gap-based time separators, and the native
  message context menu's Details action opens an anchored popover with speaker,
  timestamp, model/provider, and token usage. These details are derived from the
  event log; no separate metadata store is introduced.
- The composer footer shows **no model identity control**. A DM talks to an agent
  identity and a channel to a roster — not to a single model — so the footer never
  presents model/provider as a primary conversation affordance (it would imply one
  global model and mislead in channels where members may answer with different
  profiles). Model/provider/effort stay visible only where they are diagnostic or
  configuration-relevant: the Details popover, the run/debug panel, ledger
  metadata, and the agent profile (where the model is actually chosen). See
  `agent-delegation-runtime.md` for how a profile owns model + effort.

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
      memory/
        events.jsonl
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
- `principals/<agent-<agentId> | user-<userId>>/memory/events.jsonl`
- payload files referenced by event payload refs

Derived and rebuildable:

- `checkpoints/*.json`
- `indexes/*.json`
- `conversations/<id>/meta.json`
- `conversations/<id>/runs.json`

Clean-cut startup policy (pre-release, no migration) — the storage-generation
sentinel:

- ONE root file `layout.json` `{"v": <generation>}` is written once per on-disk
  format generation (`STORAGE_LAYOUT_VERSION`, currently `3` = episodic memory
  episodes + memory source union). First store access reads this single line; a
  matching `v` proceeds with no per-conversation probing.
- A stale `v` or a MISSING sentinel is positive proof of another generation:
  the WHOLE agent data root is hard-deleted (logged with the old generation) —
  identities, conversations, runs, pools, indexes — and the layout is recreated
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

Conversation segments, run logs, and agent memory logs share one append-only
seq-log primitive for JSONL serialization, per-key write queues, latest-seq
caches, chunked physical-tail reads, offset-bounded replay, and file-size
checkpoint guards. Conversation replay still joins the conversation segment with
its indexed JOINED run logs (delegation ledgers excluded) and sorts by `seq`;
memory uses the same primitive with its own per-principal key, and delegated-run
ledgers use it with the memory log's torn-tail policy (drop a torn FINAL line on
read, truncate it on the next append's repair; mid-file corruption still fails
loudly).

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
  | 'debug.snapshot.created'
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

Agent-owned memory events live in the separate per-agent memory log.
`memory.entry_*` events project to editable durable memory entries;
`dream.completed` projects the latest Dream watermark and audit summary.
Agent-anchored Dream run meta is indexed per agent and added to the render task
projection as a read-only Dream task. A conversation-triggered Dream also writes
a conversation-side `dream.finished` marker keyed to a hidden user-message
anchor. That marker is for chat-stream placement only; the memory audit remains
in the per-agent memory log.

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
`InlineFilePreviewLayer` gives it hover preview and click-to-open into the
`FilePreviewPanel`; the chip shows the basename while the full path stays on the
preview/open path. (The working file is path-addressed; durability is what
Save-to-outliner / Export are for — see `docs/plans/agent-file-artifact-model.md`.)

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
  // Mode-specific run state (replaces the old overloaded `isStreaming`): DM
  // composer state vs. Channel work surface never share a flag.
  dmRunActive: boolean;                              // DM/single-agent run in flight (composer stop/steer)
  dmStreaming: AgentStreamingRenderState | null;     // DM streaming tail (null for multi-agent Channels)
  channelRunsActive: boolean;                        // any addressed Channel run active or pending
  channelActivityEntries: AgentRenderActivityEntry[]; // per-run Channel activity (overlay + per-run detail view)
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
- `dmRunActive`/`dmStreaming` and `channelRunsActive`/`channelActivityEntries` are
  mode-specific: a multi-agent Channel keeps `dmRunActive` false so its work never
  drives the composer's stop/steer, and a DM keeps the Channel fields empty. The
  split is derived from membership (`isMultiAgentConversation`); conversation
  `kind` is never stored.
- A running Channel agent's live `message_update` text rides on
  `channelActivityEntries[].streamingText` (the per-run detail view), never as a
  transcript row — the Channel message stream is whole-utterance only (**delivery**
  is atomic: the whole turn appears on completion). This is enforced in the
  projection: `buildTranscriptRows` **suppresses any message whose producing run is
  in the live active-run set** in a multi-agent Channel, so an in-flight turn (its
  thinking, interim narration, AND tool-call/segment events — not just streamed
  text) is kept out of the transcript until the run leaves that set, at which point
  its whole turn appears at once. The suppression is keyed off the **live**
  in-memory active runs the runtime passes in (`options.activeRuns`), NOT the
  persisted `status === 'running'`: a run orphaned `running` by a crash/quit is
  absent from the live set, so its interrupted turn still renders rather than
  silently vanishing. A child run anchored to a live parent turn is held back the
  same way, so its boundary row never orphans to the transcript end while the
  parent is hidden. (A DM streams its active turn live, so the suppression is gated
  on `isMultiAgentConversation`.) On completion the turn renders through the same
  **result-first fold** as a DM (final answer as prose, process collapsed behind
  "Worked for …"); only the live-drill-in vs. inline-stream split differs between
  the two modes.
- Render flushes are coalesced to at most one per animation frame.
- `compaction.completed` events become dedicated compaction rows keyed by the
  compact root message, with summary and trigger metadata in
  `entities.compactions`.
- The compact root user message remains available for pi-mono projection but is
  not rendered as a normal user bubble.
- `dream.finished` events become dedicated Dream boundary rows keyed by their
  hidden anchor message, with status, processed counts, and memory-change counts
  in `entities.dreams`. Active manual `/dream` runs append a transient
  `activeDream` row until the marker is written.
- `child_run.*` events back `entities.childRuns` — the conversation's permanent
  record of a run, whose final result is an expandable summary with a "View full
  run" link into the full transcript. **Where** that record renders depends on who
  spawned the run:
  - **DM fold (non-multi-agent conversation, `parentToolCallId` set).** In a DM a
    child run is the agent's own implicit behavior — it quietly delegated a slice
    of the current turn — so it gets **no conversation-level boundary row**.
    Instead it folds into the spawning turn's process: the `agent` tool-call block
    is **kept** (not suppressed) and renders the child-run summary inline
    (`childRunsByParentToolCallId` → "Agent task · {description}", expandable to the
    result with the same "View full run" link). Because it lives inside the turn's
    own message, it is turn-anchored and branch-pruned with that message — editing
    the user message that started the turn removes it, with no orphan left at the
    transcript end.
  - **Boundary row (multi-agent Channel, or a parentless run).** A run in a
    multi-agent channel, or a parentless run (a scheduled command fire), becomes a
    dedicated **child-run boundary row** in `transcriptRows` (kind `'child-run'`,
    keyed by run id). A parented channel run anchors right after its tool-result
    row, else after the assistant message that issued the call, and **suppresses
    that tool-call block** so the run reads as one boundary, not a tool interaction
    (an assistant turn left with no other blocks is dropped); a parentless run is
    ordered by start time among the messages.
  - The projection skip (no boundary row) and the renderer keep (tool-call block
    stays) are gated on the **same** multi-agent flag, so a single-agent channel
    never loses its child run to a dropped-but-not-folded gap. A running row shows a
    live status line and is not yet expandable; once it seals it expands to the
    result (or error) and the full-run link. Boundary rows live only in
    `transcriptRows`, never in the active `rows` path.
- Long output rows are collapsed by default.
- **Result-first turn fold (DM and Channel alike).** Every assistant turn renders
  result-first: the **final answer is the trailing text** after the turn's last
  thinking/tool block and shows as prose; **everything before it — thinking, tool
  calls, AND interim narration text** ("let me check X first") — folds into ONE
  collapsed process block. A turn with no thinking/tools is a direct answer and
  renders without a fold. This is one mechanism, not two: there is no
  channel-specific text-only path (a Channel turn renders the same fold once its
  utterance lands) and no single-tool inline special case.
- **Codex-style live disclosure.** A DM turn's process block **auto-expands while
  it is working** (thinking/tools streaming live, `liveSegment`) so the process is
  visible, then **auto-collapses the moment it seals** — when the final answer
  begins streaming or the turn ends. A Channel turn is delivered atomically (its
  rows are `idle`, never `liveSegment`), so it lands already collapsed.
  - A **resultless** turn (last visible block is a thought/tool — no trailing
    answer prose) drives two SEPARATE decisions, decoupled so a Channel never
    mislabels:
    - **The red "Interrupted" label + error styling** fire ONLY when the run was
      **genuinely interrupted** — its producing run `failed`, was `cancelled`, or
      was left `running` by a crash. This is the authoritative **`turnInterrupted`**,
      stamped on the message entity by the core projection from the run's *real*
      status, NEVER inferred from block structure. A cleanly `completed` resultless
      turn is **never** red, in either mode.
    - **Surfacing the process** (auto-expand so its interim work / error context
      isn't buried — `surfaceResultlessProcess`) fires for a genuine interruption
      in **either** mode, AND — per the result-first design — for a sealed
      resultless **DM** turn, where the user watched it 1:1. A cleanly-completed
      resultless **Channel** turn does NOT surface: it folds to the neutral
      "Worked for …" header like any other sealed turn (atomic delivery — its
      process lives in the activity detail view, not inline). A surfaced resultless
      turn also suppresses the "Worked for …" resting header (which would read as a
      clean unit of work and hide that there is no answer), falling back to the
      descriptive group summary.
  - (Tying the *label* to the run's real status — not to the mere absence of
    trailing prose — is what fixed the recurring Channel mislabel: a Channel turn
    is always `idle`, so the old `turnEnded && !finalIsProse` rule painted every
    result-less turn red regardless of outcome. Keying the result-first *split* off
    the *trailing* answer, not *any* text in the turn, still stops a surfaced
    resultless turn from burying interim narration behind a collapsed header.)
  - Every other steady state defaults collapsed. The **sticky override wins**: once
  a user toggles the block it keeps that choice and never auto-collapses on seal.
- The collapsed header carries the single activity spinner and, while a turn is
  live **and the user has collapsed it**, acts as a status line (current running
  tool with status, else the latest streaming thought). Once the turn **seals**,
  the collapsed header reads **"Worked for {duration}"** (codex-style; duration =
  the producing run's `updatedAt − startedAt`, threaded as `runDurationMs` on the
  message entity **only once the run is sealed** — a still-`running` run, whether
  live or left running after a crash, has `updatedAt === startedAt` and so no
  meaningful wall-clock, and is left unknown rather than shown as "<1s"; a multi-run
  turn sums each run's wall-clock). When the duration is unknown the header falls
  back to the static group summary (e.g. "Thought · used N tools"). Expanding the
  block moves the spinner to the running tool row inside the timeline. A
  **genuinely interrupted** turn (run `failed`/`cancelled`/crash-orphaned —
  `turnInterrupted` — with no trailing answer) keeps the "Interrupted…" label,
  never a duration. A cleanly `completed` resultless turn never shows "Interrupted":
  in a Channel it folds to "Worked for {duration}"; in a DM it surfaces its process
  (per the result-first design) under the descriptive group summary rather than the
  "Worked for …" resting header.
- Large details are refs, not row payloads.
- A run/provider failure rides on the terminal assistant message: the run marks
  it `assistant_message.failed` (error stop reason + `errorMessage`), so it
  renders inline as a failed turn with a retry action — not as a separate
  banner. The top-level `errorMessage` field is reserved for transient
  operational errors delivered out-of-band via the runtime `error` event (e.g.
  attachment/queueing failures), never run failures. Context-overflow failures
  are left unmarked because reactive compaction recovers them automatically.

### Debug projection

Debug panel reads event-derived timelines and payload refs.

It currently shows:

- provider request context and sanitized payload snapshots
- provider response status/header snapshots
- context/token/cost metrics
- errors

The schema also supports later debug views for tool lifecycle, approval
lifecycle, and performance metrics once those event types are emitted.

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
only `recall` over active durable memory entries; raw conversation lookup is
reserved for runtime-owned evidence expansion, Dream consolidation, and diagnostics.

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

- The conversation list combines the configured agent roster with
  `conversation-index.json`: every configured agent has an immutable canonical DM
  row, even before its log exists, and Channels are listed when they have a
  Channel name. The current event/index storage still carries that name in the
  legacy `goal` field.
- Restoring a canonical DM id is find-or-create keyed by `{ user, agentId }`.
  DMs have no goal, exactly one agent member, and cannot be renamed, deleted, or
  membership-edited. A Channel is a named room with the user, the coordinator
  agent as an implicit runtime participant, and optional invited agents that can
  be added later.
- `conversation-index.json` carries list projection fields, including member
  roster, unread count, message count, and the latest visible message snippet /
  timestamp. Opening the conversation menu does not replay each conversation log.
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
- Agent memory event emission, projection, reminder injection, and Settings
  list/edit/forget management.
- Shared append-only seq-log internals for conversation/run/memory JSONL tails,
  offsets, queues, and seq caches; memory projection caching keyed by latest seq;
  high-churn memory compaction back to the current projection.
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
