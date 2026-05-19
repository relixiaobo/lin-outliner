# Agent Event-Sourced Runtime

This is the implementation baseline for the next Lin agent persistence, debug,
streaming, rendering, and multimedia model.

## Decision

Lin uses pi-mono as the execution core, but Lin owns the durable product state.

The single durable source of truth is:

```txt
<userData>/agent/sessions/<sessionId>/events.jsonl
<userData>/agent/sessions/<sessionId>/payloads/*
```

Everything else is derived and rebuildable:

- pi-mono `Message[]`
- pi-agent-core `Agent.state`
- transcript render rows
- debug timelines
- session list/search indexes
- branch state
- checkpoints

No compatibility path is required for `agent-chat-sessions.json`. The project is
not shipped yet, so the old mutable tree can be removed once the event-backed
runtime is ready.

## Boundary

Use pi-mono for:

- provider/model abstraction
- provider streaming
- message/content wire shapes
- tool-call parsing
- agent loop orchestration
- follow-up, abort, and live replacement behavior

Lin owns:

- event log and replay
- payload storage
- local tool gateway
- permissions and approvals
- outliner/file/bash/web effects
- debug and performance records
- render projection
- restore, checkpoints, and indexes

```txt
user command
  -> Electron AgentRuntime
  -> append Lin event(s)
  -> derive active-path pi-mono Message[]
  -> run pi-agent-core Agent
  -> normalize pi-mono events into Lin event(s)
  -> append Lin event(s)
  -> derive render/debug/checkpoint projections
```

pi-mono state may produce new events. It is not persisted as Lin's product
truth.

## Storage Layout

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

Derived:

- `checkpoints/*.json`
- `indexes/*.json`
- any in-memory render/debug/runtime state

## Event Model

Each line in `events.jsonl` is one versioned event. `seq` is monotonic per
session. Events are append-only; corrections are new events.

Core event groups:

- session: `session.created`, `session.renamed`, `session.settings_changed`
- branch: `branch.selected`
- messages: `user_message.created`, `user_message.edited`,
  `assistant_message.started`, `assistant_message.delta`,
  `assistant_message.completed`, `assistant_message.failed`
- tools: `tool_call.started`, `tool_call.delta`, `tool_call.completed`,
  `tool_call.failed`, `tool_result.created`
- approvals: `approval.requested`, `approval.resolved`
- runs: `run.started`, `run.completed`, `run.failed`, `run.cancelled`
- payloads: `payload.created`, `payload.derived`
- debug: `debug.snapshot.created`
- maintenance: `compaction.completed`, `checkpoint.created`, `metric.recorded`

Current implementation starts in `src/core/agentEventLog.ts`.

Event append order is serialized per open runtime session. This keeps `seq`
monotonic even when provider debug capture, streaming deltas, and tool events
arrive close together.

For assistant messages, `assistant_message.delta` is the streaming transport and
`assistant_message.completed.content` is the final canonical content. Replay may
show deltas while a turn is active, but completed turns take their durable text,
thinking, and tool calls from the completion event.

## Branching

Do not persist the old `AgentChatSession.mapping` tree as durable truth.

Persist:

- message `parentMessageId`
- optional `replacesMessageId`
- `branch.selected`

Derive:

- children per message
- current sibling per parent
- active linear path
- branch counters

Editing a user message creates a sibling message with the same parent and
`replacesMessageId` pointing at the old message, then selects the new branch.
Switching back is only a `branch.selected` event.

## Multimedia

Multimedia is metadata plus payload refs. Binary data must not be embedded in
event lines, React state, IPC snapshots, or debug rows.

Ingestion flow:

```txt
user/tool/provider produces media
  -> write source payload file
  -> append payload.created
  -> attach AgentPayloadRef to message/tool/debug event
  -> derive previews asynchronously
  -> append payload.derived for thumbnails, page renders, text extracts, etc.
```

Represent media in three tiers:

- source payload: original image, PDF, audio, video, archive, or binary output
- derived payloads: thumbnail, preview, rendered page, OCR/text extract, poster
  frame, waveform summary
- render row: small metadata and refs only

Renderer rules:

- render thumbnails or bounded previews first
- load full-resolution media only after explicit open/expand
- create object URLs only for visible media and revoke them on unmount
- never put base64 into markdown or transcript rows

Current runtime baseline:

- `AgentEventStore.writePayload` writes payload bytes under the session
  `payloads/` directory and returns an `AgentPayloadRef`.
- User and tool image content append `payload.created` before the message event.
- Render projections carry only `AgentPayloadRef` metadata.
- Runtime pi-mono rehydration reads image payload bytes only when rebuilding the
  active path for model execution.
- Provider debug request JSON is stored as a debug `payload.created` ref. Debug
  summaries carry byte/hash metadata, and the raw JSON is loaded only when the
  debug panel disclosure is opened.
- Large text tool results are stored as `tool_output` payload refs once they
  exceed the inline threshold. The event message carries a stable
  `<persisted-output>` preview/reference string, while the full text remains in
  the payload file for explicit lazy loading.
- Tool output payload refs are exposed to the renderer as metadata. The tool
  detail UI loads full text only on demand through IPC and renders a bounded
  first/last text window, while copy actions can still use the full loaded text.

pi-mono bridge rules:

- send media to pi-mono only when the active model/tool path needs it
- prefer provider-native content refs or small derived text extracts
- do not expand full binaries into pi-mono messages unless the provider adapter
  requires that shape
- do not re-expand large `tool_output` payloads into pi-mono during restore or
  continue; preserve the recorded preview/reference string for context stability

## Large Session Performance

A large session must not stall normal outliner editing or chat rendering.

The hot path must never:

- parse the full event log for every token
- send the whole session over IPC for every update
- keep every transcript row mounted in the DOM
- inline large tool/media payloads into render rows
- re-lex completed markdown blocks during streaming

Open-session policy:

- session list reads `session-index.json`
- message search and user-message pickers read `search-index.json`
- opening a session loads the latest checkpoint
- checkpoint stores include `seq`, latest event id, replay state, and event
  file byte offset
- checkpoint writes are atomic and only commit when the supplied replay state
  matches the current event-log tail seq and event id; after a successful write,
  each session keeps the latest three valid checkpoints and best-effort removes
  older, corrupt, or stale temp checkpoint files
- only events after the checkpoint byte offset are replayed synchronously
- if no valid checkpoint exists, replay falls back to the full event log; a
  background progress UI can be added later if very large cold sessions need it
- malformed derived indexes are discarded and rebuilt from `events.jsonl`

Render policy:

- completed rows are immutable by id/revision
- only the active streaming row updates per frame
- transcript rows are virtualized once the conversation crosses the row-count
  threshold
- large text/tool output is windowed inside its own row
- media/debug expansion is local row state, not a new session projection

## Implementation Phases

1. Event store foundation
   Define events, payload refs, replay reducers, branch projection, and JSONL
   storage. Add tests before wiring runtime.

2. pi-mono bridge from events
   Replace `AgentChatSession -> Message[]` with `events -> Message[]`.
   Reconstruct tool results and active path from events.

3. Render projection hot path
   Replace snapshot IPC with compact render projection updates. Coalesce stream
   flushes to at most one per frame.

4. Debug projection and payload refs
   Convert debug snapshots into event-derived summaries. Store provider payloads,
   tool output, and media as payload refs. Lazy-load details. Provider request
   JSON and large text tool output now follow this path. Debug history and
   totals are derived from `debug.snapshot.created`, assistant completion
   events, and debug payload refs instead of a second mutable conversation
   model; this is covered by restore regression tests. Richer UI lazy-loading
   for non-text media payloads remains.

5. Checkpoints and indexes
   Add checkpoint writer/loader, session index, and search/user-message index.
   Run-end checkpoint writing, session index, checkpoint tail replay, and
   corrupt-checkpoint fallback are implemented. Checkpoint writes are atomic and
   tail-guarded before committing, then prune to the latest three valid
   checkpoint files per session. The derived session/search/user-message indexes
   are also implemented and can rebuild from the event log. Large-session
   regression tests cover checkpoint replay, indexes, render projection, and
   payload-bounded JSONL.

6. Long transcript/output virtualization
   Virtualize transcript rows, window large output, preserve scroll anchors, and
   keep copy/export based on payload refs. Transcript row virtualization and
   large tool output windowing are implemented. Assistant turn copy is
   payload-aware for persisted tool output; full-session export remains.

## Success Criteria

- Exactly one durable product truth exists: event log plus referenced payloads.
- Deleting checkpoints/indexes/projections loses no agent state.
- pi-mono can be rehydrated from event-derived messages.
- Debug explains a run without slowing normal chat.
- Large media and tool outputs never enter event lines, IPC snapshots, or React
  transcript state.
- Branching, retry, edit, tool lifecycle, approvals, and compaction are events.
