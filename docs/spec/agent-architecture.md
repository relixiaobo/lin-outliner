# Agent Architecture — the map

The one-page map of the agent subsystem: the small set of primitives everything
else is a view/rule/metadata of, what's actually built today, and where multi-agent
plugs in. Detailed designs live in the member plans (`docs/plans/agent-program.md`
is the sequencing authority; `agent-data-model.md` owns the stored shapes;
`agent-skills.md` owns skills). This file is the index you read first.

> Status convention below: **✅ built** · **⚠ scaffolded (type exists, not exercised)** ·
> **◻ planned (M3)**. Verified by a read-only code audit on 2026-06-11.

## The 7 primitives

Everything in the subsystem reduces to seven concepts. The rest — Task, run `kind`,
DM/Channel, coordinator, fingerprint, distillation nodes — are **views, rules, or
metadata** of these, not separate primitives.

1. **Principal** — `{type:'user',userId} | {type:'agent',agentId}`. The unit of
   "who": a conversation member, a message `actor`, an addressee. One type unifies
   member = actor = addressee. ✅
2. **Conversation** — the shared, objective record of a thread. Holds `members:
   Principal[]`. **DM/Channel is a derived view** of the member set (canonical
   `{user, oneAgent}` = DM; ≥2 agent members = Channel), never a stored `kind`. ✅
   (DM + Channel, M3-A #179)
3. **Run** — one unit of agent execution (one reply or task). Anchored to a
   conversation (the only home). Holds **all** execution detail. The 4 "kinds"
   (turn/background/delegation/scheduled) are **derived** from `trigger` + `parentRunId`
   + foreground-ness; **Task is a view** (= background runs, grouped by `agentId`). ✅
4. **Memory** — a Principal's subjective self-model. Follows the *principal*, not
   the conversation. Canonically framed (PM-ratified 2026-06-10) in the standard
   cognitive-science vocabulary — see *The memory system* below. ✅
   (per-principal + transactive sharing)
5. **Skill** — a reusable instruction, bound by name from one shared library. ✅
6. **Agent** — an authorable Principal: persona (`AGENT.md` body → system prompt) +
   model/effort + skill bindings + tool/permission profile + its own memory line. ✅
7. **Permission gate** — ask / allow / deny, over a hard A3 floor (catastrophic
   hard-blocks + a "can-never-be-globally-allowed" set). ✅

## The three ledgers (one engine, three instances)

A conversation owns the **record**; an agent owns the **memory**; a run owns the
**execution**. One shared `AppendOnlySeqLog` primitive backs all three; they differ
only in id scheme, writer, retention, and vocabulary.

| Ledger | Keyed by | Holds | Volume |
|---|---|---|---|
| **Conversation** | `conversationId` | communication: user message + final assistant reply + membership | ~2 events/turn |
| **Run** | `runId` (anchored to a conversation) | all execution: assistant deltas, `tool_call ↔ tool_result`, thinking, permission, ask/widget | 10–50+/turn, self-cleans |
| **Memory** | principal (`agent-<agentId>` / `user-<userId>` pool under `principals/`) | memory-mutation + dream events | sub-linear |

Write-time split routes run-execution events to the run log and only communication
to the conversation log (`agentEventStore.ts` `appendSplitEvents` / `isRunLogEvent`),
which is what keeps the conversation log at ~2 events/turn. Storage and code speak one
vocabulary end to end (`conversation.*` event types, `conversationId` on every event);
on startup any old-format artifact hard-deletes the agent data root (pre-release
clean-cut, no migration).

## Two kinds of agent-to-agent relationship

- **Delegation (a child run — NOT a separate kind of agent)** — an agent spawns helper
  runs (fork = the same agent continuing in a child run; fresh = an ordinary typed agent
  with its own identity + memory line, #164). Child runs carry `parentRunId`; not
  conversation members. ✅ — and the code now honors the model
  (`agent-run-unification`, shipped): a delegated run is an ordinary Run with its
  OWN `runs/<runId>/` ledger (its own seq space, replayed alone), kind
  `delegation`, joined to the parent by `parentRunId`/`parentToolCallId`; one
  `{seq, eventId}` evidence + watermark scheme everywhere; child compaction is
  event-sourced like a conversation's. The former entity-grade species
  (transcript payload snapshots, the `runId:message:N` codec, the positional
  Dream cursor) is deleted. **Consultation** — an agent privately asking a
  colleague for help — is this delegation primitive used as a *colleague call*:
  contact is an ungated team-level baseline, capability stays per-agent (the
  consultee runs under its own authority), and the consultee is a sidechain,
  never a conversation member. See `agent-conversation-model` §"Cross-agent help
  — consultation is a colleague call, not a privilege".
- **Peer agent (a Channel member)** — multiple agent Principals share one conversation
  with the user; routed by `addressedTo` (a run is produced iff a principal is addressed;
  coordinator = the default addressee, PM-ratified 2026-06-10). ✅ (M3-A #179,
  IM group-chat semantics ratified 2026-06-10) — a Channel behaves like an IM
  group, not a streaming DM:
  - **Default `#General` Channel:** the runtime reserves
    `lin-agent-channel-general` as a normal named Channel (`title/goal = General`,
    no stored `kind`). `#General` is ensured on runtime ready, restore, list, and
    agent-registry reload. It contains the user, the coordinator, and every current
    durable peer agent; future durable peers auto-join when they appear. Fork,
    child/delegation, headless, and transient helper agents are not members. The
    invariant is idempotent and protected: `#General` cannot be renamed, deleted,
    or manually membership-edited through ordinary conversation commands. It does
    not change routing: an unaddressed `#General` turn still routes only to the
    coordinator, while `@agent` routes only to named peers.
  - **Channel organization:** users create/edit Channels through the native
    Channel config window: create with a required name, optional invited agents,
    and optional opening message; configure later to rename, add members, or
    remove invited members while preserving the coordinator. The user-facing
    coordinator also has `channel_create` / `channel_update` tools for explicit
    chat requests to organize or adjust a working group. Those tools reuse the
    same runtime `createConversation` / rename / member add-remove path, are
    not wired into delegated child runs, and mutate only local conversation
    metadata/membership.
  - **Routing:** explicit user `@`s all run, uncounted; no `@` → the
    coordinator; an agent reply `@`-ing members hands off (the addressing is
    persisted on the reply's `assistant_message.completed.addressedTo` and the
    round loop routes from the record). The hand-off chain is **unbounded** —
    user `stop` is the only circuit breaker (kills the active run, discards
    unstarted routing with a visible thread trace).
  - **Independence cut:** an addressed run's context = the log up to and
    including the message that addressed it, plus its own later records
    (`agentChannel.ts` `cutChannelPathForRun`; fails open if compaction removed
    the boundary). Same-round co-addressees are mutually invisible; a hand-off
    target sees the reply that addressed it.
  - **Run spine parentage:** `assistant_message.started.addressedByMessageId`
    stores the message that addressed the run. The first segment of a run parents
    to that addressed message, so concurrent peers fan out as siblings. Tool
    results and later assistant continuations parent to the run's own tail
    (`lastMessageId`), never to the conversation's shared `selectedLeafMessageId`;
    `parentMessageId` remains the regenerate/branch anchor. Hand-off routing is
    persisted on `assistant_message.completed.addressedTo`.
  - **Delivery (typing model, PM-ratified 2026-06-13):** the Channel **message
    stream is whole-utterance only** — replies are never token-streamed into the
    transcript; the whole reply lands in the thread on completion. The running
    agent's live assistant content is **retained for the per-run detail view** (the
    activity drill-in — "watch a Channel agent compose"), never discarded and never
    in the message flow. It is exposed as
    `channelActivityEntries[].streamingContent` (with `streamingText` as the
    text-only fallback/summary), not rendered into the shared transcript, so
    concurrent runs never collide and the transcript stays whole-utterance.
  - **Rendering (result-first turn fold, PM-ratified 2026-06-14):** once a turn
    lands it renders **result-first** — the final answer as prose, with thinking,
    tools, and interim narration folded behind a collapsed "Worked for {duration}"
    disclosure — the **same fold DM uses**. This reverses the earlier
    "process via live drill-in only" rule in favour of an inline persisted fold
    (it delivers the deferred M3-C post-hoc process inspection); whole-utterance
    *delivery* above is preserved. DM and Channel differ only in delivery (DM
    streams the process live while running then collapses; Channel is atomic with
    a "working…" activity indicator in-flight), not in resting shape.
  - **Parallel runtime (shipped in #202; async view/command layer 2026-06-13):**
    Channel execution tracks a set of in-flight runs per conversation, capped by a
    small per-conversation execution limit. Co-addressees dispatch immediately and
    independently; excess addressed turns wait FIFO behind the cap, not behind a
    serialized round. **A Channel send/edit/retry returns on acceptance** — it
    persists the user message and enqueues the addressed turns, then returns
    without awaiting the runs; the runs drain asynchronously and a single detached
    watcher (`scheduleChannelIdleEmit`) emits the final idle projection when the
    Channel goes idle. The watcher is ownership-token-guarded: a conversation
    reset/close/delete tears it down (`teardownChannelDraining` resolves its parked
    waiter and bumps the token) instead of leaking it or emitting on a dead
    conversation. (Tests that need a settled Channel call `drainChannelTurnsForTest`.) A user message sent while Channel runs are active
    is persisted and routed immediately, with that message as each addressed run's
    context cut. Replies append when they complete, so transcript order is
    completion order. The independence cut remains the invariant: a run sees only
    the log through the message that addressed it, plus its own later records;
    same-wave co-addressees remain mutually invisible even when another run
    completes first. DM behavior is untouched (streaming, steer, inline process).
  - **Projection mode split (2026-06-13):** the renderer-facing projection
    exposes mode-specific run state instead of one overloaded `isStreaming`:
    `dmRunActive` + `dmStreaming` drive the DM composer's stop/steer;
    `channelRunsActive` + `channelActivityEntries` drive the Channel activity
    surface. Every Channel keeps `dmRunActive` false, so its work never turns the
    composer into Stop/Steer (the composer stays a pure message composer — empty
    + active shows a disabled Send, never Stop). Conversation `kind` is never
    stored; the split is derived from Channel identity with a multi-agent roster
    fallback for older fixtures.
    Navigation and unread continue while Channel runs work: switching away from an
    active Channel is allowed (only a busy DM blocks it), and a completed peer reply
    bumps unread for a **backgrounded** Channel through the existing
    `notification.created` / `conversation_attention` fold (a `channel_reply`
    notification, raised only when the conversation is not the one being viewed).
    It is **badge-only**: no OS notification is delivered for in-Channel chatter
    (a count, not a ding) — unlike off-floor task notifications.
  - **Stop scope:** Channel stop has two scopes. A per-run stop cancels exactly
    that run and leaves siblings in flight; a conversation stop cancels every
    active run, drops undispatched pending Channel turns, and preserves the
    visible discarded-turns system trace. A send that arrives while a stopped round
    is still draining resumes the Channel: the stop flag clears once the stopped
    runs drain (it is *not* gated on pending being empty), so the new turn pumps
    rather than deadlocking behind a flag that pending-emptiness would never clear.
    Only per-run stop is exposed in the Channel UI today; a conversation-level
    Channel "stop all" is deferred (the composer never becomes Stop in a Channel),
    so a conversation stop in a Channel is reachable only programmatically.
    Edit/regenerate/retry gates are set-based: transcript rewrites are blocked
    while any Channel run is active in the conversation.
  - Each peer turn runs as that agent (own definition/model/skills/memory line,
    `actor` stamped on its messages) and reads the thread through the per-POV
    derivation (`agentChannel.ts` `deriveAgentPovProjection`, composed with the
    independence cut: own turns verbatim, other principals coalesced into
    identity-preambled user-role blocks; assembled transiently in
    `deriveRuntimePiMessages` — never persisted, the shared log stays
    reader-neutral). POV applies whenever the transcript contains another
    agent's records — keyed on content, not the live roster — and mention
    tokens are collision-checked at create/add time.
  - **Per-agent POV inspector (M3-C):** the Channel member menu can open a
    read-only inspector for any agent member. It renders the same derived POV
    steps used by runtime assembly plus that member's read-only memory briefing
    (`<self>` + co-member `<principal>` zones). The inspector stores nothing,
    emits no events, and never records memory access; it is a renderer projection
    over the current conversation only.
  - **Renderer identity/metadata:** speaker attribution is a projection of the
    persisted message `actor` plus member/definition metadata. Channel assistant
    rows name every speaker, including the coordinator. Time separators and the
    right-click Details popover expose timestamp, model/provider, and usage on
    demand; they do not add stored conversation primitives.

## User ↔ Agent (concept direction, not yet built)

The relationship is layered: at the conversation layer user and agent are symmetric
Principals (✅); at the control layer the user is **authority** and the agent is
**delegate** (✅ — the permission gate); at the memory/identity layer the design
direction is **`(user + self-agent) = one complete agent`** — the self-agent silently
does the background dirty work (Dream-distilling, compaction, indexing, maintaining the
user's self-model) while **decisions stay with the user**. The real symmetry is
"**will + digestion**", not "agent": a normal agent is will(LLM)+digestion(LLM); the
user-composite is will(human)+digestion(self-agent-LLM). The implementable boundary:
**epistemic curation is autonomous** (so Dream can run), **volitional commitment
escalates** (== the existing ask-gate). This is an exploratory, **not-yet-ratified**
direction (target M3); only the `<self>`/`<principal>` render scaffold exists today.

## The memory system (canonical vocabulary, PM-ratified 2026-06-10; realigned per `agent-memory-realignment`)

Memory is organized as a textbook system — **ground truth below it, three
stores, one index, three processes, one social layer** (the full mapping table
is `agent-data-model.md` § *Canonical memory vocabulary*):

- **Ground truth (below memory):** the conversation/run ledgers — the immutable
  world record. Not a memory store; every memory structure is derived over it
  and bottoms out in it via down-pointers.
- **Stores:** episodic (`memory.episode_recorded` episodes + memory-owned gist,
  constructed over the ledgers) · semantic (`MemoryEntry` pools per Principal —
  a pool is one principal's self-model, keyed by owner/believer) · procedural
  (skills — "what I can do").
- **Index:** the hippocampal-style **pure pointer** layer binding semantic
  facts to episodic evidence, bidirectionally (`MemoryEntry.sources[]` fact →
  episode, plus the episode→facts reverse lookup). It points, never copies,
  never holds content — gist is episodic content, not index.
- **Processes:** consolidation (Dream — offline replay distilling into the
  semantic store; evidence-preserving under compaction; ONE phrasing rule:
  third-person-singular subject-elided facts in every pool) · retrieval (three
  modes: chronic activation = the resident briefing's full-read-set schema
  overview + strength-selected fact budget, with co-cited facts lightly boosted
  from `sources[]` · deliberate cued retrieval = `recall` ranked by BM25-class
  lexical relevance + retrieval strength + query-time `sources[]` co-citation
  association, with provenance zoom down the ladder schema → fact → episode
  gist → raw span · automatic association =
  deferred on a data gate) · forgetting (two-strength projection:
  storage strength never decays, retrieval strength governs injection — never
  deletion).
- **Social layer:** transactive memory — co-members subscribe to each other's
  *semantic* stores by conversation membership; raw evidence never crosses
  principals (user pool shipped #173; agent co-member pools shipped in M3-B,
  gated on realignment PR-1 + PR-2).

Definitions + binding authoring rules: `agent-memory-foundations.md` (meta).
Work on this frame: `agent-memory-academic-alignment` (#181, language
surfaces; subsumed D2) → the **`agent-memory-realignment`** program (PR-1
person rule + read surfaces, shipped; PR-2 episodic layer, shipped; PR-3
forgetting + PR-5 schema overview, built here; PR-4 retrieval engine;
association deferred).

## Multi-agent = rules + views + one new primitive

Multi-agent does **not** re-inflate the concept count. Built on the 7 primitives it is:

| Capability | Lands on | As |
|---|---|---|
| Channel (>1 agent member) | Conversation | more `members` — same container |
| Routing (who replies) | — | one rule: a run iff a principal is in `addressedTo` |
| Coordinator | Agent | the default-addressed agent (not a new type) |
| Per-agent POV | Conversation | a derived projection (not stored) |
| **Cross-agent memory sharing** | Memory | **★ the one genuinely new primitive**: membership-scoped reads over distilled pools (no publish ACL — visibility = conversation membership) + a hard cross-principal isolation gate (distilled-only, never raw evidence) |

## Verified status & known scaffolding (2026-06-10 audit)

| Area | Status | Note |
|---|---|---|
| Three-ledger storage + write-time split | ✅ built | migration complete; legacy flat log deleted on startup |
| `Principal` + per-message `actor` | ✅ built | user actor = `local-user` (single-user) |
| `members[]` populated + used for memory scope | ✅ built | canonical DM = `[user, one agent]`; Channel = named room with `[user, coordinator]` by default and optional invited agents |
| Run→conversation anchor + per-conversation run index | ✅ built | `runs WHERE conversationId=X` is enumerable |
| Typed sub-agent identity + per-agent memory line (#164) | ✅ built | the groundwork multi-agent builds on |
| `addressedTo`, `member.added/removed`, `<principal>` render hook | ✅ built | connected in M3-A (#179): `addressedTo` written on user messages + read by routing; membership events applied on replay + folded into the conversation index |
| Create/edit a named Channel | ✅ built | `agent_create_conversation` takes `{title, agentIds?, seedText?}` and requires only a Channel name; member management lives in the Channel config window (rename/add/remove invited members, coordinator preserved); the Channels-first conversation menu opens New Channel above Direct Messages, while DMs never convert or share history; mention-token collisions rejected at create/add; coordinator-only `channel_create` / `channel_update` tools reuse the same local runtime path for explicit chat-driven working-group organization |
| Routing / coordinator / peer-agent reply | ✅ built | IM semantics (above): `@`-mention routing, coordinator default, unbounded hand-off from the persisted reply record, independence cut, typing-model delivery, per-run Channel concurrency + completion-order append; UI: composer member typeahead, header/list member display, actor badges/avatars, typing indicator + run drill-in |
| Conversation metadata UX | ✅ built | single-line DM/Channel header identity; timestamp gap separators; native message context menu with Details for speaker, timestamp, model/provider, and token usage |
| Cross-agent memory sharing + isolation gate | ✅ built | M3-B: Channel co-members read each other's distilled pools by membership; raw evidence dereference is gated in the evidence service and returns typed refusal on cross-principal access |
| Per-agent POV projection | ✅ built | M3-C: one shared derivation (`deriveAgentPovProjection`) feeds both runtime assembly and the read-only Channel member inspector; inspector memory zones are rendered from a read-only briefing cache and are not stored |
| Memory source binding under compaction (#164) | ✅ built | Realignment PR-2 records fact sources as `{episodeId}` and episodes as `{stream, streamId, range}` raw sources over conversation/run ledgers. `recall include_evidence` zooms fact → episode gist → raw span; PR #178's compaction evidence invariant remains pinned in `agent-data-model` §13.18. |

Forward sequencing for the remaining gap lives in `agent-program.md` § *M3 sequencing &
readiness* (debt-first: settle the map → fix #164 → then three independent complete
features: **M3-A** working multi-agent Channel — shipped (#179, membership + routing +
peer reply in one PR) → **M3-B** cross-agent memory + isolation gate — shipped →
**M3-C** per-agent POV inspector — built here.

## Known tensions / honest caveats

- **Principal symmetry is now exercised on the memory layer and in POV
  inspection** — membership + routing shipped in M3-A, M3-B extends the same
  membership rule to co-member agent memory reads, and M3-C exposes each member's
  derived POV without adding storage.
- **"user = agent" oversells**; the honest model is `(user + self-agent) = one agent`,
  symmetric only in the memory/identity layer.
- **The cross-principal isolation gate is load-bearing** — unifying "self" and
  "other" memory under one mechanism also unifies the failure mode; the gate now
  lives in the evidence service, not in recall-path convention.
