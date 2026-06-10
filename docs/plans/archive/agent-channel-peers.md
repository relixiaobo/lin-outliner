---
status: done
priority: P1
owner: cc
phase: M3-A
created: 2026-06-10
updated: 2026-06-10
---

# M3-A: working multi-agent Channel (membership + routing + peer reply)

**Shape: (a) ONE complete feature in one PR (#179).** First implementation
shipped to the branch and was gate-reviewed by main (7 finders / 6 verifiers);
the review surfaced 10 confirmed/notable findings plus an A8 completeness gap
(no user-reachable Channel entry). During the fix round the PM **redirected the
Channel semantics to an IM group-chat model** (ratified 2026-06-10, below) —
the fix round = semantics rework + review fixes + the creation entry, all on
the same branch, still one complete feature.

## Ratified semantics (PM, 2026-06-10 — supersedes the relay-budget model)

1. **Visibility (independence rule):** an addressed run's context = the log up
   to and including **the message that @-ed it**. Same-round co-addressees are
   mutually invisible (independent answers); a hand-off target sees the reply
   that addressed it; `@` order has no semantics.
2. **Delivery:** Channel agent replies are **not streamed** — a typing
   indicator while the run is active, the whole message delivered into the
   thread on completion (IM model).
3. **Presentation:** the thread shows **utterances only** (user messages +
   final agent reply text; no inline process blocks, even after completion).
   Process is reachable by clicking the typing indicator → the run's
   working-state panel (the subagent-details pattern over the run ledger).
   Final results must land in the group as messages, never panel-only.
4. **Routing:** explicit user `@`s all run, uncounted; no `@` → the
   coordinator (Q1, pinned); an agent reply `@`-ing members hands off —
   **unbounded** (PM explicitly chose no relay budget; user `stop` is the only
   circuit breaker).
5. **Queueing:** while a round is active, new user messages **queue** (no
   steer in a Channel at all); routed normally when the round ends.
6. **stop:** kills the round's active run + clears unstarted routing, leaving
   a visible trace in the thread.
7. **DM is completely unchanged** (streaming, steer, inline process blocks,
   find-or-create).

Three-layer consistency argument (why this shape): the conversation ledger
(final replies only), the peer POV flatten (other principals' utterances only),
and the Channel UI (utterances only) all show the same projection of the same
record. Independence + whole-message delivery also make the semantics
**parallel-ready** (same-round runs have no data dependency) while execution
stays sequential — the ratified no-concurrent-turns boundary is untouched.

## Standing ratified design this builds on (unchanged)

- **Canonical DM + user-creatable Channels.** DMs are find-or-create-unique and
  never convert in place; adding a second agent **spawns a new seeded Channel**
  (goal + existing agent as member); the conversation list is the Channel list.
- **Coordinator = a member role flag**, not a router subsystem; a Channel's
  default coordinator = the main agent; DMs have none. Coordinator is the
  default `addressedTo` when the user `@`s no one (Q1, pinned).
- **`@` candidate set = the conversation's agent members**; a DM has no `@`.
- **Capability binds to the agent, not the conversation** (model/effort/tools/
  skills travel with the agent profile); a Channel adds a goal overlay only.
- **POV flatten at assembly (agent-data-model §8):** the running agent's own
  prior turns → `assistant` (verbatim); everyone else coalesces into `user`
  content with identity preambles. Now composed with the independence cut (the
  flatten is applied to the log **truncated at the addressing message**), and
  applied whenever the transcript contains foreign-actor records — not keyed
  on the live roster.
- **New-member onboarding floor:** shared substrates only (ambient outline +
  optional seed text at creation); briefing/forwarding tools are follow-ups.

## Fix-round scope (main's gate review, 2026-06-10)

Review fixes (all on this branch before re-ready):

1. e2e mock lacks `members` → AgentChatPanel crashes the React tree; mock-side
   members + defensive `?? []` in the runtime store view.
2. No per-conversation send serialization → concurrent `sendMessage` overwrites
   `activeRun`, mis-stamping durable events. **Resolved structurally by the
   turn queue (semantics #5).**
3. Reactive-compaction `buildPreservedMessageEvents` stamps the main agent's
   actor + unregistered runId on preserved peer messages → use the original
   record's actor.
4. Steer swallows explicit `@` in a Channel. **Resolved structurally: no steer
   in Channels (semantics #5).**
5. `regenerate`/`retry`/`edit` (also drops `addressedTo` on the replacement)/
   reactive-retry/follow-up-drain never pass `executingAgentId` → coordinator
   runs under the wrong persona; derive identity from the regenerated record's
   actor / preserved addressing.
6. `foldMembers` meta fold re-merges a removed member from its in-flight
   events' principals → fold only membership events + head; never derive
   members from ordinary event actors.
7. `queueFollowUp` builds the main agent's private memory briefing into the
   SHARED log unconditionally → reader-neutral in multi-agent conversations.
8. `removeConversationMember` mid-run / roster-keyed POV selection → block
   removal while a round is active; POV path chosen by transcript content (any
   foreign-actor records), not live roster size.
9. Actor badge derived from current roster erases attribution of departed
   members' historical turns → derive from the message's `actor` vs the
   coordinator, with mention-token fallback for departed members.
10. `agentMentionToken` collision (two members with the same trailing name) →
    reject at member-add/create time; key member UI rows by principal, not
    mention.

Plus: A8 gap — a user-reachable Channel entry (header member strip "+" popover:
add agent → `agent_add_conversation_member`, DM spawns the seeded Channel and
the renderer switches to it; remove member, coordinator/DM disabled).
Incidental cleanup: dedupe helper copies (mergePrincipals/persistedText/
escapeRegExp/displayName fallback), centralize the coordinator comparison,
stamp hand-off `addressedTo` on the handing-off assistant message record
(routing visible in the log), stable `members` reference through projection
updates.

## Non-goals (boundary — 钉死)

- **NOT cross-agent memory** — a peer reads its own pool + the user pool;
  reading *agent* co-member pools is **M3-B**.
- **NOT a POV inspector UI** — post-hoc process inspection of a *delivered*
  message is M3-C; this PR ships only the live drill-in from the typing
  indicator.
- **NOT concurrent execution** — sequential execution; the semantics are
  parallel-ready but true parallelism is a follow-up.
- **NOT coordinator reassignment UI**; **NOT briefing/forwarding onboarding
  tools**; **NOT who-configures-whom**; **NOT doc snapshot+delta** (all
  unchanged from the original boundary).

## Decisions (PM gates — closed)

- **Q1 — group default-`addressedTo`: RATIFIED → the coordinator.** Pinned.
- **Q2 — relay loop budget: SUPERSEDED 2026-06-10 → unbounded.** PM explicitly
  chose no budget; `stop` is the circuit breaker (and is blind, since Channel
  has no streaming — accepted).
- **Q3 — multi-`@` semantics: RATIFIED → independent answers** (visibility
  rule #1), not sequential shared-context.
- **Q4 — Channel delivery: RATIFIED → typing + whole-message** (IM model);
  thread = utterances only; process via typing-indicator drill-in.
- **Q5 — steer in Channel: RATIFIED → none**; queue-all while a round is
  active. DM steer unchanged.

## Acceptance (fix round)

- [x] `@a @b` produces two runs whose contexts both cut at the user message
      (mutually invisible — transcript-derivation test); a hand-off target's
      context includes the addressing reply. (`cutChannelPathForRun` unit tests
      + the multi-`@` runtime integration test.)
- [x] Explicit `@`s are uncounted; a hand-off chain is unbounded (4-run chain
      past the old budget of 3); `stop` ends the round, clears unstarted
      routing, and leaves a trace; one addressee's failure leaves a trace and
      does not skip siblings.
- [x] User message during an active round queues and routes at round end
      (no steer path in Channels). The integration test surfaced a real bug —
      persisting the queued message at send time re-pointed the leaf and
      orphaned the in-flight reply — fixed by persisting at routing time
      (DM-follow-up model) with the projection's `queuedMessages` keeping it
      visible meanwhile.
- [x] Channel thread renders utterances only; typing indicator per active run
      opens the run working-state panel; delivered messages carry correct
      actor attribution that survives member removal.
- [x] Review findings 1/3/5/6/7/8/9/10 each covered by a test or verified fix;
      e2e suite green on the PR head (294 passed).
- [x] A user can create a Channel / add a member from the UI (header "+" member
      menu; DM spawn path switches to the new Channel); mention-token
      collisions are rejected (runtime test at create + add).
- [x] DM behavior byte-identical (streaming, steer, inline process) — DM
      runtime test unchanged and green.
- [x] `bun run typecheck` + `test:core` + `test:renderer` + `test:e2e` green;
      spec re-synced honestly (A6, no over-claim); PR #179 re-marked ready.

## Collision self-check (2026-06-10, fix round)

Same branch, same files as the shipped round; re-check `gh pr list` before
re-ready. The `agentEventLog.ts` surface gains no new event types in the fix
round (typing/queue/independence are runtime+renderer concerns; membership
events already landed).
