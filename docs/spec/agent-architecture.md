# Agent Architecture — the map

The one-page map of the agent subsystem: the small set of primitives everything
else is a view/rule/metadata of, what's actually built today, and where multi-agent
plugs in. Detailed designs live in the member plans (`docs/plans/agent-program.md`
is the sequencing authority; `agent-data-model.md` owns the stored shapes;
`agent-skills.md` owns skills). This file is the index you read first.

> Status convention below: **✅ built** · **⚠ scaffolded (type exists, not exercised)** ·
> **◻ planned (M3)**. Verified by a read-only code audit on 2026-06-10.

## The 7 primitives

Everything in the subsystem reduces to seven concepts. The rest — Task, run `kind`,
DM/Channel, coordinator, fingerprint, distillation nodes — are **views, rules, or
metadata** of these, not separate primitives.

1. **Principal** — `{type:'user',userId} | {type:'agent',agentId}`. The unit of
   "who": a conversation member, a message `actor`, an addressee. One type unifies
   member = actor = addressee. ✅
2. **Conversation** — the shared, objective record of a thread. Holds `members:
   Principal[]`. **DM/Channel is a derived view** of the member set (canonical
   `{user, oneAgent}` = DM; multi-member = Channel), never a stored `kind`. ✅ (DM) /
   ◻ (Channel routing)
3. **Run** — one unit of agent execution (one reply or task). Anchored to a
   conversation (the only home). Holds **all** execution detail. The 4 "kinds"
   (turn/background/subagent/scheduled) are **derived** from `trigger` + `parentRunId`
   + foreground-ness; **Task is a view** (= background runs, grouped by `agentId`). ✅
4. **Memory** — a Principal's subjective self-model. Follows the *principal*, not
   the conversation. Canonically framed (PM-ratified 2026-06-10) in the standard
   cognitive-science vocabulary — see *The memory system* below. ✅ (per-principal) /
   ◻ (transactive sharing, M3-B)
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
  conversation members. ✅ — with one honest caveat: the *code* still implements
  "subagent" as an entity-grade species (transcript = payload snapshot in parent state,
  own coordinate codec + watermark shape) rather than the pure Run relationship the
  model claims. **Dissolution PM-ratified 2026-06-10:** `agent-run-unification` (after
  M3-A, before M3-B) makes child runs ordinary run ledgers and deletes the species.
- **Peer agent (a Channel member)** — multiple agent Principals share one conversation
  with the user; routed by `addressedTo` (a run is produced iff a principal is addressed;
  coordinator = the default addressee). ⚠/◻ — `members`/`actor` are real; `addressedTo`,
  `member.added/removed`, and >1-agent conversations are scaffolded/missing (see below).

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
- **Stores:** episodic (episodes + memory-owned gist, constructed over the
  ledgers — realignment PR-2; today the acknowledged gap) · semantic
  (`MemoryEntry` pools per Principal — a pool is one principal's self-model,
  keyed by owner/believer) · procedural (skills — "what I can do").
- **Index:** the hippocampal-style **pure pointer** layer binding semantic
  facts to episodic evidence, bidirectionally (`sources[]` forward today;
  reverse lookup PR-2). It points, never copies, never holds content — gist is
  episodic content, not index.
- **Processes:** consolidation (Dream — offline replay distilling into the
  semantic store; evidence-preserving under compaction; ONE phrasing rule:
  third-person-singular subject-elided facts in every pool) · retrieval (three
  modes: chronic activation = the resident briefing · deliberate cued
  retrieval = `recall` + provenance zoom down the ladder schema → fact →
  episode gist → raw span · automatic association = deferred on a data gate) ·
  forgetting (two-strength target: storage strength never decays, retrieval
  strength governs injection — never deletion; PR-3).
- **Social layer:** transactive memory — co-members subscribe to each other's
  *semantic* stores by conversation membership; raw evidence never crosses
  principals (user pool shipped #173; agent pools = M3-B, gated on realignment
  PR-1 + PR-2).

Definitions + binding authoring rules: `agent-memory-foundations.md` (meta).
Work on this frame: `agent-memory-academic-alignment` (#181, language
surfaces; subsumed D2) → the **`agent-memory-realignment`** program (PR-1
person rule + read surfaces, shipped; PR-2 episodic layer; PR-3 forgetting;
PR-5 schema overview; PR-4 retrieval engine; association deferred).

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
| `members[]` populated + used for memory scope | ✅ built | every conversation = `[user, mainAgent]` |
| Run→conversation anchor + per-conversation run index | ✅ built | `runs WHERE conversationId=X` is enumerable |
| Typed sub-agent identity + per-agent memory line (#164) | ✅ built | the groundwork multi-agent builds on |
| `addressedTo`, `member.added/removed`, `<principal>` render hook | ⚠ scaffolded | types exist, never written/read — **connect, don't remove** |
| Create a >1-agent conversation (Channel) | ◻ missing | `defaultConversationMembers` is always `[user, mainAgent]` |
| Routing / coordinator / peer-agent reply | ◻ missing | single main agent always replies |
| Cross-agent memory sharing + isolation gate | ◻ missing | the one new primitive (M3) |
| Per-agent POV projection | ◻ missing | transcript views are global today |
| Memory source binding under compaction (#164) | ✅ built | `sources[]` were already ID-pinned + fail-loud; PR #178 closed the two residual holes: the Dream renderers now surface a compaction summary as evidence (after compaction it is the only surviving carrier of the compacted content), and the fork-prefix boundary is read in the live payload's own coordinates (envelope-first; a stale boundary beyond the payload means "Dream from 0", never a permanent skip). Invariant pinned: `agent-data-model` §13.17, *compaction is evidence-preserving*. |

Forward sequencing for the gaps above lives in `agent-program.md` § *M3 sequencing &
readiness* (debt-first: settle the map → fix #164 → then three independent complete
features: **M3-A** working multi-agent Channel (membership + routing + peer reply, one
PR) → **M3-B** cross-agent memory + isolation gate → **M3-C** per-agent POV).

## Known tensions / honest caveats

- **Elegance was partly on paper; the storage foundation is now verified clean** — but
  the multi-agent membership/routing/sharing layer is scaffold/missing, so the
  Principal symmetry is real yet largely unexercised until M3.
- **"user = agent" oversells**; the honest model is `(user + self-agent) = one agent`,
  symmetric only in the memory/identity layer.
- **The cross-principal isolation gate is load-bearing** — unifying "self" and "other"
  memory under one mechanism also unifies the failure mode; it must be a hard
  architectural boundary, not a recall-path convention, before sharing ships.
