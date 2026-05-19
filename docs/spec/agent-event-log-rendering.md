# Agent Event-Sourced Runtime

This document is the canonical architecture for Lin Outliner's current agent
data, debug, persistence, and rendering model.

## Decision

Lin uses an event-sourced agent runtime.

The single durable product source of truth is the **Agent Session Event Store**:

```txt
events.jsonl + referenced payload files
```

Everything else is derived:

- pi-mono `Message[]`
- pi-agent-core `Agent.state`
- transcript render rows
- debug timelines
- session list/search metadata
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

Do not reimplement pi-ai or pi-agent-core behavior in Lin.

Lin owns:

- product event log
- local tool gateway
- permissions and approvals
- outliner/file/bash/web tool effects
- undo grouping
- payload storage
- debug and performance records
- render projection
- persistence and restore policy

```txt
command
  -> Electron AgentRuntime
  -> append Lin event(s)
  -> derive pi-mono messages
  -> run pi-agent-core Agent
  -> normalize pi-mono events into Lin event(s)
  -> append Lin event(s)
  -> derive render/debug/checkpoint projections
```

pi-mono runtime state participates in producing new events. It is not Lin's
persisted product state.

## Implementation Snapshot

The current main branch implements this architecture through these modules:

- `src/main/agentRuntime.ts`: owns session lifecycle, pi-agent-core execution,
  Lin event append, projection emission, attachment persistence, debug capture,
  and checkpoint writes.
- `src/main/agentEventStore.ts`: owns the filesystem event store, payload files,
  write queues, rebuildable indexes, checkpoint replay, and checkpoint retention.
- `src/core/agentEventLog.ts`: owns event DTOs, replay reducers, parent-linked
  branch state, active-path derivation, and pi-ai message projection helpers.
- `src/core/agentRenderProjection.ts`: derives the compact renderer projection
  from replay state.
- `src/main/agentDebugProjection.ts`: derives debug history and totals from
  debug events, assistant completions, and debug payload refs.
- `src/renderer/agent/runtime.ts`: adapts `AgentRenderProjection` into the
  renderer store/view consumed by the React agent UI.

The old mutable chat snapshot store is no longer part of the runtime.

## Reference Analysis

### Previous lin-outliner snapshot store

Before the event-sourced runtime, Lin stored agent sessions in one mutable
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

- IndexedDB as the primary storage for Lin's Electron runtime
- mutable tree as durable truth
- separate debug store as a competing fact source

### lin-agent

Lin-agent uses fs-first JSONL channel logs:

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

Adapt for Lin Outliner:

- store runtime event lifecycle, not only conversation lines
- keep branch selection and approval/tool lifecycle as first-class events
- derive conversation rows from events instead of storing a collapsed message
  list as truth

### cc-2.1

cc-2.1 uses per-session JSONL transcripts under project directories:

```txt
~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl
```

Each transcript entry is append-only. Conversation messages carry `uuid` and
`parentUuid`; metadata is also appended as entries. Resume rebuilds the
conversation chain from the file.

Keep from cc-2.1:

- per-session JSONL
- parent-linked message chain
- metadata as append-only entries
- sidecar payload/metadata files
- write queue and flush discipline
- resume from chain plus repair/filter passes
- subagent/sidechain concept as future-compatible shape
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
  sessions/
    <sessionId>/
      events.jsonl
      payloads/
        <payloadId>.json
        <payloadId>.txt
        <payloadId>.bin
      checkpoints/
        checkpoint-<seq>.json
  indexes/
    session-index.json
    search-index.json
```

Authoritative:

- `events.jsonl`
- payload files referenced by event payload refs

Derived and rebuildable:

- `checkpoints/*.json`
- `indexes/*.json`

The directory name helps locate the session. The session creation event defines
the actual session identity and metadata.

## Event Store

Each line in `events.jsonl` is one JSON event.

```ts
interface AgentEventBase {
  v: 1;
  eventId: string;
  seq: number;
  sessionId: string;
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

- `seq` is monotonic per session.
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
  | 'session.created'
  | 'session.renamed'
  | 'session.settings_changed'
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
  | 'approval.requested'
  | 'approval.resolved'
  | 'follow_up.queued'
  | 'follow_up.applied'
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'compaction.completed'
  | 'payload.created'
  | 'payload.derived'
  | 'checkpoint.created'
  | 'metric.recorded';
```

Not every schema event is emitted by the current runtime yet. Approval,
follow-up, compaction, metric, thinking delta, tool-call delta, and derived
payload events are schema-reserved so these features can land without changing
the event-store model. Events that are emitted today still go through the same
append-only rules.

## Message Model

Persisted message identity is Lin-owned.

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
  toolCallId: string;
  toolName: string;
  messageId: string;
  parentMessageId: string | null;
  isError: boolean;
  content: AgentPersistedContent[];
  outputSummary: string;
  outputRef?: AgentPayloadRef;
}
```

The pi-mono projection reconstructs pi-ai messages as:

```txt
AssistantMessage(content includes toolCall)
ToolResultMessage(toolCallId, toolName, content)
```

The render projection may group thinking, tool calls, and tool results under a
single process block.

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
- Global cross-session dedupe is optional; session-local correctness is
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

This projection is the only place that should translate Lin events into pi-ai
message shapes.

### Render projection

The renderer consumes compact rows, not raw events.

```ts
interface AgentRenderProjection {
  sessionId: string;
  revision: number;
  sessionTitle: string | null;
  activeRunId: string | null;
  isStreaming: boolean;
  model: Record<string, unknown>;
  thinkingLevel: string;
  pendingToolCallIds: string[];
  errorMessage: string | null;
  rows: AgentRenderRow[];
  entities: AgentRenderEntities;
  streaming: AgentStreamingRenderState | null;
}
```

Rules:

- Completed rows are immutable by identity.
- Only the active streaming row changes during token streaming.
- Render flushes are coalesced to at most one per animation frame.
- Long output rows are collapsed by default.
- Large details are refs, not row payloads.

### Debug projection

Debug panel reads event-derived timelines and payload refs.

It currently shows:

- provider request context and sanitized payload snapshots
- context/token/cost metrics
- errors

The schema also supports later debug views for tool lifecycle, approval
lifecycle, and performance metrics once those event types are emitted.

It must not:

- own runtime truth
- subscribe React to raw token events
- force payload refs into normal chat state
- block transcript rendering

### Session index projection

Session list/search metadata is a derived index.

It may cache:

- title
- updatedAt
- first user prompt
- last prompt
- model/provider
- user message summaries
- tags later if needed

If session/search/user-message indexes are corrupt or missing, discard them and
rebuild them from event logs.

## Streaming Strategy

Streaming has two separate paths:

```txt
provider chunks
  -> pi-agent-core
  -> Lin stream accumulator
  -> coalesced assistant_message.delta events
  -> render projection flush <= 1/frame
```

Do not persist or send a full session snapshot per token.

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
- provider debug payload writes: awaited before the provider stream starts, so
  debug snapshots and assistant completions keep stable event order
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
- latest included event file byte offset
- replay state needed to rebuild active branch, render/debug projections, and
  pi-mono messages

Restore:

```txt
load latest checkpoint
  -> replay events after checkpoint.seq from checkpoint byte offset
  -> rebuild projections
  -> hydrate pi-agent-core when execution starts
```

If checkpoint load fails, replay `events.jsonl` from the beginning.
Checkpoint writes only commit when the supplied replay state matches the current
event-log tail `seq` and event id; stale replay state must not write a byte
offset checkpoint.

## Large Session Performance

A large session should not block normal outliner editing or chat rendering.

The hot path must never do these things:

- parse the whole event log for every token
- send the whole session over IPC for every update
- keep every transcript row mounted in the DOM
- inline large tool/media payloads into render rows
- re-lex completed markdown blocks during streaming

Open-session policy:

- The session list reads `session-index.json`, not every session log.
- Opening a session loads the latest checkpoint, then replays only events after
  the checkpoint byte offset.
- If no usable checkpoint exists, replay falls back to the full event log; a
  background progress UI can be added later if very large cold sessions need it.
- The active transcript starts from the render projection and uses row
  virtualization for long sessions.

Render policy:

- Completed rows are immutable and can be memoized by id/revision.
- The streaming row is the only row updated per frame.
- Transcript virtualization starts before row count becomes visible to users.
- Large text/tool outputs are windowed inside their own row.
- Expanding media or debug payloads creates localized state, not a new session
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
  -> append run.completed or run.failed
  -> write checkpoint
  -> update render/debug/session index projections
```

### Restore

```txt
open app
  -> scan agent/sessions
  -> load session-index cache if valid
  -> load selected session checkpoint
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

- Per-session `events.jsonl` and payload directory layout.
- Strict append ordering, per-session write queues, and replay reducers.
- Parent-linked message chain with active branch projection.
- pi-ai `Message[]` derivation from the active event path.
- `AgentRenderProjection` IPC instead of full chat snapshots.
- Provider debug payload refs and event-derived debug history/totals.
- Large tool output payload refs with bounded model-visible labels.
- Session index, search index, and user-message index as rebuildable projections.
- Checkpoint writer/loader with tail replay, corrupt-checkpoint fallback, atomic
  writes, stale-state guards, and best-effort retention of the latest three
  valid checkpoints.
- Transcript row virtualization and bounded large-output rendering.

### Remaining

- Performance instrumentation events and UI-facing analysis views for replay,
  projection, IPC bytes, render commits, and long transcript behavior.
- Richer non-text media previews and lazy full-payload loading in render/debug
  detail views.
- Persisted approval/follow-up/compaction event emission for the schema-reserved
  event types that are not yet active runtime events.
- Optional checkpoint retention preferences if real sessions show storage
  pressure.

## Success Criteria

- There is exactly one durable product truth: the session event store.
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

## Non-Goals

- Replacing pi-mono.
- Reimplementing provider adapters or stream parsing.
- Persisting raw provider chunks as the normal render model.
- Rendering raw event logs as the transcript.
- Keeping mutable tree snapshots as durable truth.
- Streaming outliner document edits token by token.
- Building a global blob store before session-local payload correctness exists.
