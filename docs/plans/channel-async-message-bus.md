---
status: draft
priority: P1
owner: relixiaobo
created: 2026-06-13
updated: 2026-06-13
---

# Channel Async Message Bus

Make Channels behave like an IM group with independent addressed agent work, not
like a special case of the single-run DM composer. This plan is a future
implementation unit; the current UI-polish PR only records the design so the main
agent can review the behavioral change before code lands.

Shape: **one complete feature in one PR**. The PR must update the runtime,
projection, renderer state, tests, and spec together so Channel semantics are
coherent end to end.

## Goal

- A user can send a new Channel message while any Channel agent run is active.
- Explicit `@agent` mentions dispatch independent per-agent runs. Co-addressees
  do not share a turn group, do not wait for each other, and append replies in
  completion order.
- Channel agent replies are delivered as whole utterances on completion, never as
  token-streamed transcript rows.
- Composer state remains message-entry state in Channels: send stays send; stop
  and steer belong to DM only.
- Channel work state is shown through per-run activity entries with per-run stop.
- Conversation switching and unread accounting continue while Channel agents work.

## Non-goals

- No change to DM behavior: DMs remain serial, streaming, steerable, and
  composer-stoppable.
- No new proactive agent behavior. Agents still run only when addressed by the
  user or by another persisted agent reply.
- No redesign of Channel membership or agent configuration windows.
- No migration or compatibility layer for pre-release dev data; if a projection
  shape changes, wipe isolated dev userData as usual.

## Current Mismatch

The runtime already contains most of the Channel execution model:

- Channel sends resolve `@` mentions into independent `ChannelTurnRequest`
  records.
- Channel turns use concurrent active runs with `allowConcurrent: true`.
- Channel `message_start` / `message_update` assistant events are ignored, and
  the final assistant message is appended on `message_end`.
- Per-run activity entries exist and can carry a run id for scoped stop.

The remaining mismatch is the view and command boundary:

- `agent_send_message` waits for `waitForChannelIdle`, so the renderer submit
  promise spans all addressed agent work instead of only the accepted user
  message.
- The render projection exposes a global `isStreaming = hasActiveRuns`, so
  Channel activity is interpreted as the DM composer run state.
- `AgentComposer` still receives that global streaming flag and can show Stop or
  Steer labels in Channels.
- Conversation switching is blocked by global `isStreaming`, which conflicts
  with Slack-like unread behavior.
- Some runtime helpers still choose a single arbitrary `activeRunId` for a
  conversation with multiple active Channel runs.

## Design

### 1. Split conversation execution state at the projection boundary

Expose separate concepts instead of one overloaded `isStreaming`:

```ts
interface AgentRuntimeView {
  dmRunActive: boolean;
  dmStreaming: AgentStreamingRenderState | null;
  channelActivityEntries: AgentRenderActivityEntry[];
  channelRunsActive: boolean;
}
```

Names can change during implementation, but the invariant must not: DM composer
state is not derived from Channel active runs.

Remove the overloaded projection-level `isStreaming` field rather than keeping a
compatibility alias. This is a derived renderer-facing view, not a persistent
storage format, and pre-release dev data does not need legacy readers. Every
consumer must move to mode-specific fields in the same PR.

### 2. Return from Channel send when the message is accepted

For a Channel, `agent_send_message` should:

1. append the user message with `addressedTo`;
2. enqueue addressed agent turns;
3. emit/persist the accepted state;
4. return to the renderer immediately.

It must not wait for active or pending Channel turns to drain. Tests that need a
settled Channel continue to use `drainChannelTurnsForTest`.

Messages without explicit `@agent` mentions still route to the Channel
coordinator first. Coordinator hand-off remains the same durable mechanism:
completion of one agent reply can address another member and enqueue that
member's independent run without waiting for unrelated in-flight runs.

DM sends keep the current serial command lifecycle.

### 3. Make Channel composer a pure message composer

In Channel mode:

- empty composer + active agents shows a disabled send button, not Stop;
- non-empty composer sends a new message, never steer;
- pending Channel activity does not set `sending`;
- global stop is not exposed through the primary composer action.

Per-run stop remains in the floating Channel activity overlay. A future
conversation-level "stop all" affordance may exist, but it must be explicit and
separate from the composer send slot.

### 4. Treat Channel active work as activity, not transcript

The Channel transcript renders final utterances only:

- in-flight assistant placeholders are filtered from the thread;
- completed assistant messages show the recorded speaking agent;
- adjacent assistant messages from different agents remain separate rows;
- same-wave co-addressees remain mutually invisible through the independence cut.

The implementation must migrate both existing placeholder producers:

- `src/renderer/agent/runtime.ts` `shouldAppendAssistantPlaceholder`, which
  currently derives a transcript placeholder from the single active projection;
- `src/core/agentRenderProjection.ts` activity construction, which still derives
  pending Channel activity from one arbitrary active run in a multi-run
  conversation.

The activity model is flat per active or pending addressed run:

- `agentId`, `runId`, `addressedByMessageId`, `state`, and `updatedAt` are
  per-run;
- tool-state labels come from that run's agent state, not a global
  `pendingToolCallIds` list;
- hover/focus on the activity overlay freezes the visible working set until the
  overlay is dismissed.

### 5. Allow navigation and unread while Channel runs continue

Switching away from a Channel must not stop or block active Channel runs. When a
reply lands while the conversation is not actively viewed, unread count increments
by reusing the existing attention path: the `conversation_attention` event in
`src/core/agentTypes.ts` and `unreadByConversationId` in
`src/renderer/agent/runtime.ts`. Do not introduce a second unread mechanism.

Transcript rewrites still stay guarded while any Channel run is active:
edit/regenerate/retry/switch-branch are destructive relative to the shared log,
so they remain blocked until the Channel has no active or pending addressed runs.

### 6. Keep user input requests deterministic under concurrency

Approval and `ask_user_question` requests are run-scoped correctness surfaces,
not generic Channel status. The first implementation PR does not need a full
multi-request UX, but it must make conflicts deterministic:

- pending approval and question state is keyed by `runId` / request id and must
  never overwrite another active run's request;
- if the UI only presents one request at a time, it presents the oldest pending
  request and preserves the rest of the queue until the visible request resolves;
- stopping a run clears only that run's pending requests;
- if a request cannot be displayed because another modal/surface is active, the
  runtime records it as pending instead of dropping it.

This matches the existing renderer store shape (`pendingUserQuestions` and
`pendingApprovals` maps with stable order) and prevents concurrent Channel runs
from stealing each other's user input.

## Risks

- Returning early from Channel send changes command timing; tests that currently
  rely on `sendMessage` as a drain must be updated to call the explicit test
  drain helper.
- Projection field renaming has a broad renderer blast radius. The implementation
  should migrate consumers mechanically and keep mode-specific names readable.
- Approval and `ask_user_question` UI can stay visually simple in the first PR,
  but run-scoped queuing and non-overwrite behavior are in scope because they are
  correctness requirements for concurrent Channels.

## Collision Result

Checked 2026-06-13:

- `gh pr list` returned no open PR claims.
- Intended future touch points: `src/main/agentRuntime.ts`,
  `src/core/agentRenderProjection.ts`, `src/core/agentTypes.ts`,
  `src/renderer/agent/runtime.ts`, `src/renderer/ui/agent/AgentChatPanel.tsx`,
  `src/renderer/ui/agent/AgentComposer.tsx`,
  `src/renderer/ui/agent/AgentComposerControls.tsx`, Channel/agent specs, and
  focused core/renderer/e2e tests.
- Spec sync target: fold the shipped runtime behavior into
  `docs/spec/agent-architecture.md` (Channel runtime section) in the same PR.
- Main-agent merge gate should place this P1 item in `docs/TASKS.md`; dev agents
  do not edit that file directly.

## Verification

- Core runtime test: a Channel send resolves before addressed agent runs finish.
- Core runtime test: two co-addressed agents append replies in completion order
  and never see each other's same-wave answer.
- Core runtime test: a user message sent while Channel runs are active is
  persisted immediately and dispatches its own addressed runs.
- Renderer test: active Channel work never changes the composer primary action
  into Stop or Steer.
- Renderer/E2E test: switching away from an active Channel is allowed, and a
  completed reply increments unread for that conversation.
- E2E visual check: Channel activity floats above the composer, contains only
  working avatars when collapsed, and exposes stable rows with per-run stop when
  expanded.
