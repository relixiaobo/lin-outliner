---
status: draft
priority: P2
owner: main
created: 2026-06-11
updated: 2026-06-11
---

# Channel Parallel Runtime: Execute the Committed Semantics

**Shape: (a) ONE complete feature in one PR.** Internal stages below are build
order within that PR, not separate releases.

## Goal

Channel co-addressees run **concurrently** and their replies land in
**completion order** — repaying the M3-A execution debt. The semantics are
already ratified and shipped (PM-confirmed 2026-06-11): each turn's context
cuts at the message that addressed it, co-addressees never see each other, and
a reply is delivered whole on completion. M3-A serialized execution as a
deliberate simplification; because of the context cut, parallelizing changes
**no agent's words — only when work starts and when replies land**. This is an
execution-layer upgrade, not a product change; no further ratification of the
conversation model is needed.

User-visible outcome: `@A @B` costs ~max(A, B) instead of A + B; a message
sent while agents are working routes immediately instead of waiting out the
whole round; the faster agent's answer arrives first.

## Non-goals

- No change to addressing/routing rules (mentions scoped to roster, no-mention
  → coordinator), hand-off semantics, or the context-cut derivation.
- No streaming of Channel replies into the transcript (completion delivery
  stays, per `agent-architecture.md`).
- No UI work: `agent-conversation-entry-identity-ux` Feature D ships the
  activity area + reply anchors built to the parallel model **first**; this
  plan changes which states the UI observes, not the UI.
- No DM behavior change (single-agent conversations keep the streaming path).

## Design

Everything below replaces one assumption: **one run slot per conversation**
(`activeRunId` / `isStreaming` / `channelRound` as single values, the
queue-all gate in `prompt`, and `assertNoActiveChannelRound`).

1. **Per-run active state.** A conversation tracks a SET of in-flight Channel
   runs (agentId, runId, addressedByMessageId, startedAt). Projection exposes
   it so the activity area can show each agent's own state. `isStreaming` and
   single-slot guards are re-derived from the set where they still apply
   (DM path unchanged).
2. **Immediate dispatch, completion-order append.** A persisted user message
   dispatches one turn per addressed agent member immediately —
   `pendingChannelMessages` queue-all dies; a message sent mid-flight persists
   and dispatches right away. Each turn's reply appends to the conversation
   log when it completes (the event path is already append-on-completion;
   ordering simply becomes completion order). The reply anchor
   (`addressedByMessageId`, already persisted) carries readability.
3. **Hand-off joins the pool.** A completed reply's `addressedTo` targets
   dispatch as new concurrent turns (excluding self, as today). The chain is
   unbounded; stop remains the circuit breaker.
4. **Stop, scoped.** Per-run cancel (one agent) and conversation-wide stop
   (cancel all in-flight runs + discard undispatched hand-off targets, with
   the existing discarded-turns system-line trace). The current
   `round.stopRequested` single flag becomes per-run cancellation + a
   conversation-level stop that fans out.
5. **Transcript mutation gates.** Edit/regenerate/retry currently assert "no
   active Channel round"; the gate becomes "no in-flight run in this
   conversation" (same user-facing rule, set-based check). Regenerate/retry of
   a settled turn still runs as a single non-concurrent turn.
6. **Failure isolation.** Unchanged rule, now trivially structural: one run's
   failure leaves its failed-run trace and never affects sibling runs.
7. **Concurrency cap.** A small per-conversation cap (e.g. 3–4 concurrent
   runs, constant) bounds provider pressure; excess dispatches queue FIFO.
   The cap is an execution detail — capped-waiting agents still show their
   true `received` state in the activity area.

### Risk notes

- **Event-log append contention**: replies append on completion (atomic,
  per-message), and run logs are per-run files — the seq-log primitive needs
  review for concurrent appenders to one conversation log, but there is no
  streaming interleave problem.
- **Shared mutable conversation state** (`conversation.agent.state`,
  context derivation): each turn already derives its own cut messages; audit
  for incidental shared-state writes between concurrent turns (the likely
  bulk of the work, and where the tests live).
- **Memory/Dream extraction** triggers per completed turn; existing
  concurrent-Dream guards (`dreamingPools`) should hold — verify under
  concurrent turn completion.

## Dependencies / ordering

- After `agent-conversation-entry-identity-ux` Feature D (activity area +
  reply anchors) — the UI that makes parallel delivery legible must exist
  before replies actually interleave.
- Independent of M3-B/M3-C.

## Acceptance

- `@A @B` starts both runs concurrently; transcript shows replies in
  completion order, each with a correct reply anchor when out of order.
- A message sent while runs are in flight dispatches immediately; its
  addressees' context cuts at that message (existing derivation tests extended
  to concurrent interleavings — the independence cut is the invariant).
- Per-agent stop cancels exactly one run; global stop cancels all and leaves
  the discarded-turns trace.
- Hand-off targets dispatch on the handing-off reply's completion without
  waiting for unrelated in-flight runs.
- One run's failure never affects siblings.
- `tests/core/agentChannelRuntime.test.ts` covers: concurrent dispatch,
  completion-order append, mid-flight message, concurrent hand-off, scoped
  stop, failure isolation, cap behavior; full `bun run test:core` clean.
