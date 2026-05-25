---
status: draft
priority: P2
owner: relixiaobo
created: 2026-05-21
updated: 2026-05-25
---

# Agent Past Chats Implementation Plan

This document is a handoff plan for implementing `past_chats` in Lin Outliner.
It should be read with:

- `../spec/agent-event-log-rendering.md`
- `../spec/agent-tool-design.md`
- `../spec/agent-pi-mono-implementation.md`

## Decision

Implement `past_chats` on top of Lin Outliner's existing event-sourced agent
history. Do not migrate to lin-agent's channel storage model.

Lin Outliner already has a stronger durable truth than a plain conversation log:

```txt
agent/
  sessions/
    <sessionId>/
      events.jsonl
      payloads/
      checkpoints/
  indexes/
    session-index.json
    search-index.json
```

Use the event log and payload files as the durable truth, derived indexes for
fast browsing/search, and a new service/tool layer to present history in an
agent-friendly shape.

## Goals

- Let the agent recall older Lin agent conversations when the user references
  prior work, decisions, preferences, or "last time".
- Keep history access read-only.
- Keep token use bounded with progressive disclosure.
- Preserve the current event-sourced model as the source of truth.
- Avoid exposing raw runtime events directly to the model.
- Support UI and model citations back to the source session/message.

## Non-Goals

- Do not implement long-term memory facts in this phase.
- Do not auto-inject historical summaries into every model turn.
- Do not create a channel/member system just for history.
- Do not read raw `events.jsonl` directly from the tool implementation.
- Do not make archived/deleted/private future states visible by default.

## Current Data Layers

History currently has five useful layers:

```txt
1. Payload files
   sessions/<sessionId>/payloads/*
   Large tool output, image refs, debug payloads, subagent transcript payloads.

2. Event log
   sessions/<sessionId>/events.jsonl
   Durable append-only truth.

3. Replay state
   AgentEventReplayState
   Rebuilt from events; contains messages, branches, runs, subagents,
   compactions, payload refs, and selected leaf.

4. Derived indexes
   indexes/session-index.json
   indexes/search-index.json
   Fast session list, message search, and user-message list.

5. Projections
   UI transcript, debug view, model context, and future past_chats results.
```

`past_chats` should use layer 4 for L0/L1 browsing and layer 3 for L2 detail.
It should only load layer 1 payload files when a detail result explicitly needs
payload text.

## Agent-Facing Shape

Use a three-level progressive disclosure contract. This is the same core shape
as nodex, sider-agent, and lin-agent, adapted to Lin Outliner's event store.

```ts
past_chats({ query?, after?, before?, limit?, offset? })
// L0: list/search sessions.

past_chats({ sessionId, query?, limit?, offset? })
// L1: list user messages in one session.

past_chats({ sessionId, messageId, maxChars?, textOffset? })
// L2: read one user message plus the following assistant/tool response detail.
```

Recommended limits:

- L0 default `limit = 10`, max `20`.
- L1 default `limit = 20`, max `50`.
- L2 default `maxChars = 2000`.
- L2 supports `textOffset` for paging long replies.

Public naming should use `past_chats` and lower snake case. Internally, prefer
`sessionId` because Lin Outliner already uses `AgentSession`/`sessionId`.
If product copy wants "conversation", keep that as UI wording only.

## Result Semantics

L0 returns session summaries:

```ts
interface PastChatsSessionSummary {
  sessionId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
}
```

L1 returns user-message summaries:

```ts
interface PastChatsUserMessageSummary {
  sessionId: string;
  messageId: string;
  createdAt: number;
  preview: string;
  hasAttachments: boolean;
}
```

L2 returns a focused exchange:

```ts
interface PastChatsMessageDetail {
  sessionId: string;
  messageId: string;
  title: string | null;
  user: {
    messageId: string;
    createdAt: number;
    text: string;
  };
  replies: Array<{
    messageId: string;
    role: "assistant" | "toolResult";
    createdAt: number;
    text: string;
    toolName?: string;
    isError?: boolean;
  }>;
  truncated: boolean;
  totalChars: number;
  nextTextOffset?: number;
}
```

Tool text output should be concise and model-readable. The user does not see the
tool listing directly, so the agent must surface relevant recalled facts in its
final answer.

## Visibility Rules

For MVP:

- Exclude the current active session from L0/L1 by default. The current session
  is already in model context.
- Allow current-session lookup only if a compaction makes older original text
  unavailable from active context.
- Deleted sessions must not be listed.
- Future archived/private workspace states should be hidden unless explicitly
  requested and allowed.
- L1 and L2 must re-check visibility. A guessed `sessionId` must not bypass L0.

For later workspace scoping:

- Add `workspaceId` or project scope to session metadata if Lin starts grouping
  agent sessions by workspace.
- Filter by scope in `PastChatsService`, not in the tool wrapper or UI.

## Branch Semantics

Lin Outliner stores branch state through parent-linked messages and
`selectedLeafMessageId`.

MVP behavior:

- L0 searches current indexed messages, not historical edited-away text.
- L1 lists user messages from the replayed active branch by default.
- L2 reads detail from the active branch. It starts at the selected user message
  and includes following assistant/tool-result messages until the next user
  message on that branch.

Optional future behavior:

- Add `branchMode: "active" | "all"` if users need recall from non-active
  branches.
- Include branch metadata in L1 summaries only when a message has siblings.

## Implementation Plan

### 1. Add a PastChats service

Create a main-process service, for example:

```txt
src/main/agentPastChats.ts
```

The service should depend on `AgentEventStore`, not renderer state.

Suggested API:

```ts
export class AgentPastChatsService {
  listSessions(args: ListPastChatSessionsArgs): Promise<PastChatsSessionPage>;
  listMessages(args: ListPastChatMessagesArgs): Promise<PastChatsMessagePage | null>;
  readMessage(args: ReadPastChatMessageArgs): Promise<PastChatsMessageDetail | null>;
}
```

Use existing store capabilities where possible:

- `AgentEventStore.listSessionIndexEntries()`
- `AgentEventStore.listUserMessageIndexEntries(sessionId?)`
- `AgentEventStore.searchMessages(query, options)`
- `AgentEventStore.replay(sessionId)`

Do not parse `events.jsonl` directly in this service.

### 2. Strengthen the indexes if needed

Current search index already tracks:

- all searchable messages
- user messages
- message preview
- normalized text
- payload ids
- latest seq

The service may need small additions:

- stable pagination helpers with `offset`/`limit`
- session search over title plus matching message previews
- helper to get the best preview for a session
- optional `updatedAt` or date filters on session index entries

Indexes are derived caches. Rebuild from event logs when missing or invalid.

### 3. Build the L2 detail projection

For L2:

1. Replay the target session with `AgentEventStore.replay(sessionId)`.
2. Build the active path from `getAgentEventActivePath(state)`.
3. Find the target user message by `messageId`.
4. Collect subsequent messages until the next user message:
   - include assistant messages
   - include tool-result messages when they are useful
   - skip raw debug/metric/runtime-only events
5. Convert content blocks to plain text snippets.
6. Page the combined reply text with `maxChars` and `textOffset`.

Tool results should use already-slimmed persisted content and `outputSummary`.
Do not inline large payloads unless the user explicitly needs them.

### 4. Add the public agent tool

Add a TypeScript-backed read-only tool:

```txt
src/main/agentPastChatsTool.ts
```

Register it with the existing tool registry/runtime as `past_chats`.

Tool metadata:

- read-only
- no approval
- concurrency safe
- bounded output
- concise activity label such as `Searching past chats`

The tool wrapper should only:

- validate parameters
- call `AgentPastChatsService`
- format a model-readable text result
- include structured details for future UI rendering

Visibility and data traversal belong in the service.

### 5. Update model guidance

Update the agent system/tool guidance so the model knows when to call
`past_chats`.

Rules:

- When the user says "last time", "previously", "do you remember", or refers
  to prior decisions, call `past_chats` before answering.
- Use concrete keywords, not meta words like "mentioned" or "discussed".
- Do not claim old context is unavailable until `past_chats` has been tried.
- Do not use `past_chats` for the current active session unless compaction
  requires recovering original text.
- Summarize or cite recalled content in the final answer because the user does
  not see tool listings.

### 6. Add citations and UI hooks later

MVP can return plain text. A later UI pass can render:

- `cite type="chat" id="<sessionId>"`
- click-to-open session
- click-to-scroll to message id
- "Past conversation" badges in message rows

Do not block MVP on UI citation rendering.

## Tests

Add focused tests before broad E2E coverage.

Core service tests:

- L0 lists sessions sorted by `updatedAt` descending.
- L0 query matches session title and indexed message text.
- L0 excludes current session by default.
- L0 date filters are inclusive.
- L1 lists only user messages from one visible session.
- L1 query filters user-message previews.
- L2 reads a user message plus following assistant/tool-result replies.
- L2 stops at the next user message.
- L2 paginates long replies with `maxChars`/`textOffset`.
- L2 rejects assistant/tool-result message ids as anchors.
- guessed or missing session ids return a controlled error.
- missing search indexes rebuild from event logs.

Useful existing test files to extend or mirror:

- `/Users/lixiaobo/Documents/lin-outliner/tests/core/agentEventStore.test.ts`
- `/Users/lixiaobo/Documents/lin-outliner/tests/core/agentLargeSession.test.ts`
- `/Users/lixiaobo/Documents/lin-outliner/tests/core/agentEventLog.test.ts`
- `/Users/lixiaobo/Documents/lin-outliner/tests/core/agentRenderProjection.test.ts`

Add new tests if the service is separate:

```txt
tests/core/agentPastChats.test.ts
```

## Acceptance Criteria

- The agent can answer "what did we discuss last time about X?" by calling
  `past_chats`.
- The implementation does not alter event log truth or replay semantics.
- The current session is not returned by default.
- Large histories are browsed through indexes, not full replay.
- Detail reads replay only the selected session.
- The tool returns bounded output and clear next-step hints.
- Tests cover L0/L1/L2 behavior and index rebuild behavior.

## Reference Projects

### Lin Outliner current architecture

Use these as the implementation base:

- `/Users/lixiaobo/Documents/lin-outliner/src/main/agentEventStore.ts`
  - Current durable event store, session index, search index, payload storage,
    checkpoints, replay entry point.
- `/Users/lixiaobo/Documents/lin-outliner/src/core/agentEventLog.ts`
  - Event schema, replay state, active path, branch state, PI message derivation.
- `/Users/lixiaobo/Documents/lin-outliner/src/core/agentRenderProjection.ts`
  - UI projection pattern. Useful as an example of turning replay state into a
    purpose-built view.
- `/Users/lixiaobo/Documents/lin-outliner/src/main/agentRuntime.ts`
  - Session restore/list/create flow and event append flow.
- `/Users/lixiaobo/Documents/lin-outliner/docs/spec/agent-event-log-rendering.md`
  - Canonical durable agent architecture.
- `/Users/lixiaobo/Documents/lin-outliner/docs/spec/agent-tool-design.md`
  - Public agent tool protocol. Update its P1 `past_chats` sketch when this plan
    is implemented.

### lin-agent

Use for the clean service boundary and visibility rules. Do not copy the channel
storage model directly.

- `/Users/lixiaobo/Documents/Coding/lin-agent/src/main/tools/past-chats.ts`
  - Tool wrapper, three mode shape, validation, formatting.
- `/Users/lixiaobo/Documents/Coding/lin-agent/src/main/kernel/past-chats/service.ts`
  - Best reference for `PastChatsService`, visibility rules, paging, fuzzy
    filtering, and L2 detail logic.
- `/Users/lixiaobo/Documents/Coding/lin-agent/src/main/kernel/channel/conversation.ts`
  - Reference for session segmentation and "current live session" handling.
- `/Users/lixiaobo/Documents/Coding/lin-agent/src/shared/types/channel.ts`
  - Reference types for session segments and boundary lines.
- `/Users/lixiaobo/Documents/Coding/lin-agent/src/main/tools/past-chats.test.ts`
  - Tool-level tests.
- `/Users/lixiaobo/Documents/Coding/lin-agent/src/main/kernel/past-chats/service.test.ts`
  - Service-level visibility and L0/L1/L2 tests.
- `/Users/lixiaobo/Documents/Coding/lin-agent/src/main/kernel/channel/conversation.test.ts`
  - Segmentation tests.

### nodex

Use for the browser-extension IndexedDB version and a mature progressive
disclosure contract.

- `/Users/lixiaobo/Documents/Coding/nodex/src/lib/ai-tools/past-chats-tool.ts`
  - Three-level `past_chats` implementation using `sessionId`/`messageId`.
- `/Users/lixiaobo/Documents/Coding/nodex/src/lib/ai-persistence.ts`
  - IndexedDB session metadata and user-message metadata pattern.
- `/Users/lixiaobo/Documents/Coding/nodex/tests/vitest/past-chats-tool.test.ts`
  - Strong test coverage for current-session exclusion, fuzzy search, date
    bounds, paging, invalid params, and detail reads.
- `/Users/lixiaobo/Documents/Coding/nodex/src/lib/ai-agent-node.ts`
  - "Chat recall" guidance that tells the model when to use `past_chats`.
- `/Users/lixiaobo/Documents/Coding/nodex/src/components/layout/ChatDrawer.tsx`
  - UI history dropdown reference.

### sider-agent

Use as a second browser-extension reference and for UI/tool-result wording.

- `/Users/lixiaobo/Documents/Coding/sider-agent/src/lib/ai-tools/past-chats-tool.ts`
  - Similar three-level implementation, newer prose-style tool result wrapper.
- `/Users/lixiaobo/Documents/Coding/sider-agent/src/lib/ai-persistence.ts`
  - Session metadata and user-message metadata persistence.
- `/Users/lixiaobo/Documents/Coding/sider-agent/src/components/chat/ChatPanelHeader.tsx`
  - Session history dropdown UI with rename/delete.
- `/Users/lixiaobo/Documents/Coding/sider-agent/src/components/chat/ToolCallBlock.tsx`
  - `past_chats` tool-call display text and history icon mapping.

## Implementation Notes

- Keep the service pure TypeScript and main-process owned.
- Keep renderer access behind existing IPC/API patterns.
- Keep output caps strict. Historical recall should never dump a whole large
  session by accident.
- Keep indexes derived. If an index disagrees with event logs, event logs win.
- Prefer exact session/message ids from L0/L1 results. The model should not
  guess ids.
- Add a short note to the final user answer when recalled context is low
  confidence because search results were weak or ambiguous.
