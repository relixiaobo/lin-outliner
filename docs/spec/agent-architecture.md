# Agent Architecture — the map

The one-page map of the agent subsystem: the small set of primitives everything
else is a view/rule/metadata of, and what's actually built today. The subsystem
is **single-agent** — exactly one user-customizable agent, **Neva** — and every
conversation is a single-agent, inline-streaming, steerable thread. Detailed
designs live in the deeper specs (`agent-event-log-rendering.md` owns the
event-sourced data model + storage layout; `agent-tool-design.md` owns the agent
tool protocol + memory vocabulary; `agent-skills.md` owns skills). This file is
the index you read first.

> Status convention below: **✅ built** · **⚠ scaffolded (type exists, not exercised)**.
> Verified by a read-only code audit; reflects the single-agent collapse.

## The 7 primitives

Everything in the subsystem reduces to seven concepts. The rest — Task, run `kind` —
are **views, rules, or metadata** of these, not separate primitives.

1. **Principal** — `{type:'user',userId} | {type:'agent',agentId}`. The unit of
   "who": a conversation member, a message `actor`, the believer a memory pool is
   keyed to. One type unifies member = actor = believer. Members of every
   conversation are `{user, Neva}`. ✅
2. **Conversation** — the shared, objective record of a thread. Holds `members:
   Principal[]`, always `{user, Neva}`. Every conversation is a single-agent,
   inline-streaming, steerable thread. There is **no DM/Channel branching and no
   stored `kind`**; the conversation noun ("channel"/"conversation") stays, the
   multi-agent channel semantics are gone. ✅
3. **Run** — one unit of agent execution (one reply or task). Anchored to a
   conversation (the only home). Holds **all** execution detail. The "kinds"
   (turn/background/delegation/scheduled) are **derived** from `trigger` +
   `parentRunId` + foreground-ness; **Task is a view** (= background/child runs). ✅
4. **Memory** — Neva's first-person knowledge, held in **one believer-keyed pool**
   keyed to the single believer principal (`agent:built-in:tenon:assistant`).
   Canonically framed in the standard cognitive-science vocabulary — see *The
   memory system* below. ✅
5. **Skill** — a reusable instruction, bound by name from one shared library
   (authored procedural memory — never dreamed). ✅
6. **Agent** — the single user-customizable agent, **Neva** (stable agentId
   `built-in:tenon:assistant`, handle/mention `assistant`). A built-in defined in
   code; user edits layer as a stored overlay. Persona + model/effort + skill
   bindings + tool/permission profile + its believer memory pool. ✅
7. **Permission gate** — ask / allow / deny, over a hard A3 floor (catastrophic
   hard-blocks + a "can-never-be-globally-allowed" set). ✅

### The one agent — Neva

There is exactly ONE user-customizable agent, **Neva**: stable agentId
`built-in:tenon:assistant`, handle/mention `assistant`. No multi-agent rosters,
no peer agents, no `@`-mention routing/typeahead/handoff, no member add/remove.
Neva is a built-in defined in code; user edits layer as a stored **overlay**
(`builtInAgentProfiles` in `agent-providers.json`). The name `assistant` is
**never stored** — it is the stable agentId and the memory anchor; the editor
edits `displayName`. Neva is directly editable in Settings → Agent (writable:
model / effort / persona / tools / skills); Save persists the overlay, and Delete
is suppressed for the built-in.

## The three ledgers (one engine, three instances)

A conversation owns the **record**; Neva owns the **memory**; a run owns the
**execution**. One shared `AppendOnlySeqLog` primitive backs all three; they differ
only in id scheme, writer, retention, and vocabulary.

| Ledger | Keyed by | Holds | Volume |
|---|---|---|---|
| **Conversation** | `conversationId` | communication: user message + final assistant reply + membership | ~2 events/turn |
| **Run** | `runId` (anchored to a conversation) | all execution: assistant deltas, `tool_call ↔ tool_result`, thinking, permission, ask/widget | 10–50+/turn, self-cleans |
| **Memory** | the single believer principal (`agent:built-in:tenon:assistant`, under `principals/`) | memory-mutation + dream events | sub-linear |

The event store stays principal-keyed internally (the storage API is unchanged),
but every MEMORY read/write is pinned to the single believer.

Write-time split routes run-execution events to the run log and only communication
to the conversation log (`agentEventStore.ts` `appendSplitEvents` / `isRunLogEvent`),
which is what keeps the conversation log at ~2 events/turn. Storage and code speak one
vocabulary end to end (`conversation.*` event types, `conversationId` on every event);
on startup any old-format artifact hard-deletes the agent data root (pre-release
clean-cut, no migration).

## Agent-to-agent relationship: delegation only

The only agent-to-agent relationship is **delegation** (a child run). Peer agents
(Channel members sharing a conversation) are **gone** — there is one agent, Neva,
and every conversation's members are `{user, Neva}`.

- **Delegation (a child run — NOT a separate kind of agent / NOT a member)** — Neva
  spawns helper runs for a TASK. Delegation is **fork-only**: a fork *is* Neva
  continuing in an isolated child context (it runs AS Neva — same
  `executingAgentId`/`memoryOwnerAgentId`), never a second agent. The cross-agent
  "fresh" path (a sub-agent with its own identity + memory line) is **removed**
  (`single-agent-finish-collapse`): the `Agent` tool carries no `agent_type`, the
  registry loads only Neva, and no file-backed `.agents/agents/*` definition is
  loaded. `/research`, dream, and background self-work are all forks of Neva. Child
  runs carry `parentRunId`; they are **not** conversation members and **not** peers. ✅ — and
  the code honors the model (`agent-run-unification`, shipped): a delegated run is
  an ordinary Run with its OWN `runs/<runId>/` ledger (its own seq space, replayed
  alone), kind `delegation`, joined to the parent by
  `parentRunId`/`parentToolCallId`; one `{seq, eventId}` evidence + watermark
  scheme everywhere; child compaction is event-sourced like a conversation's. The
  former entity-grade species (transcript payload snapshots, the `runId:message:N`
  codec, the positional Dream cursor) is deleted. Delegation tasks surface in the
  in-conversation task panel (child-run/delegation tasks only).

## User ↔ Agent (control + memory relationship)

The relationship is layered: at the conversation layer user and agent are symmetric
Principals and the members of every conversation are `{user, Neva}` (✅); at the
control layer the user is **authority** and Neva is **delegate** (✅ — the
permission gate); at the memory layer there is **one believer-keyed first-person
pool** — Neva's own knowledge about both the user and the work/domain, distilled
silently in the background (Dream-distilling, compaction, indexing) while
**decisions stay with the user**. The implementable boundary: **epistemic
curation is autonomous** (so Dream can run), **volitional commitment escalates**
(== the existing ask-gate). The earlier two-pool `(user + self-agent)` direction
and the `<self>`/`<principal>` render zones are collapsed into this single
believer pool.

## The memory system (canonical vocabulary; one believer-keyed pool)

Memory is organized as a textbook system — **ground truth below it, three
stores, one index, three processes** (the full memory vocabulary lives in
`agent-tool-design.md` § *Memory*). Memory has collapsed from
a per-principal multi-pool model (agent self-model + user profile) to **ONE
believer-keyed pool** = Neva's first-person knowledge, keyed to the single
believer principal (`agent:built-in:tenon:assistant`). `memoryIsolation` is
removed — memory is always one writable pool.

- **Ground truth (below memory):** the conversation/run ledgers — the immutable
  world record. Not a memory store; every memory structure is derived over it
  and bottoms out in it via down-pointers.
- **Stores:** episodic (`memory.episode_recorded` episodes + memory-owned gist,
  constructed over the ledgers) · semantic (the single believer's `MemoryEntry`
  pool — Neva's first-person knowledge) · procedural (skills — "what I can do").
- **Index:** the hippocampal-style **pure pointer** layer binding semantic
  facts to episodic evidence, bidirectionally (`MemoryEntry.sources[]` fact →
  episode, plus the episode→facts reverse lookup). It points, never copies,
  never holds content — gist is episodic content, not index.
- **Processes:** consolidation (Dream — offline replay distilling into the
  semantic store; evidence-preserving under compaction) · retrieval (three
  modes: chronic activation = the resident briefing's full-read-set schema
  overview + strength-selected fact budget, with co-cited facts lightly boosted
  from `sources[]` · deliberate cued retrieval = `recall` ranked by BM25-class
  lexical relevance + retrieval strength + query-time `sources[]` co-citation
  association, with provenance zoom down the ladder schema → fact → episode
  gist → raw span · automatic association = deferred on a data gate) · forgetting
  (two-strength projection: storage strength never decays, retrieval strength
  governs injection — never deletion).

**Fact phrasing:** facts are self-contained **third-person sentences that NAME
their subject** (`"the user prefers terse code reviews"`, `"the auth module
verifies JWTs before authorizing"`) — heterogeneous subjects, both the user and
the work/domain. There is **no subject-elision**. The briefing renders a **flat
`<memory>` bullet list** — no `<self>`/`<principal>` zones. The transactive /
cross-principal social layer is gone: there is one writable pool, so no co-member
subscription and no cross-principal isolation gate on the memory read path.

Definitions + the memory tool surface: `agent-tool-design.md` § *Memory*.

## Dream (one consolidation process)

There is **one Dream**: the conversation-evidence consolidation that distills the
user's member CONVERSATIONS (episodic) into Neva's believer pool (semantic),
single first-person framing (subject-named facts). Neva's own persona/habits are
**authored**, never dreamed; skills are **authored** procedural memory, never
dreamed. The former agent-self / run-log Dream (a per-agent self-model built from
run evidence) is **cut**, along with run-evidence harvesting. Manual `/dream`
fires the believer pool's conversation Dream.

**Dream/run surfacing is relocated.** Dream history lives in Settings → Agent
"Memory & activity" panel (alongside memory inspect/correct/forget), fetched via
`agent_list_dream_history` — it is no longer in the in-conversation task panel.
The conversation task panel keeps only child-run (delegation) tasks.

## The runtime/policy seam (trigger · mechanism · policy)

A standing architectural rule for every handler shaped *"the runtime fires a smart
thing on a trigger"* (Dream, compaction, scheduled routines, tool-result trim,
context-budget management). Each such handler decomposes into **three layers, and
only the bottom one may leave the runtime**:

| Layer | What it owns | Home |
|---|---|---|
| **Trigger** (*when*) | schedule / threshold / event, plus the durable cursor (watermark, `dueAt`, budget), at-most-once + crash recovery, backoff, and the **bright line** — an agent can't forge or suppress a fire | **always runtime** |
| **Mechanism** (*how it moves*) | the deterministic, invariant-bearing pipe: windowing, splicing, the **persistent format contract**, transactions, abort/retry | **always runtime** |
| **Policy** (*the judgment*) | what to extract / keep / how to phrase | **outsourceable** — an editable prompt or a skill |

**The seam test.** Before moving any handler (or part of one) into userland, ask:
*is this a judgment the user would want to read and edit, AND can it tolerate
existing as one forked, offline agent run — failure-recoverable, and **not
bootstrapping the substrate it runs on**?* Policy that passes is liftable;
trigger and mechanism never are.

Worked classification:

- **Dream — policy is liftable.** Dream is a *faculty Neva owns* (it produces an
  artifact: memory), so its judgment (segment → distill) can become an editable
  skill, leaving only trigger + mechanism in the runtime. The trigger is **not a
  Dream-specific scheduler**: it is a special case of the shipped scheduled-routines
  machinery (timeline command nodes + `{type:'schedule'}` + anacron scheduler +
  at-most-once recovery + backoff + forward-only, **agent-barred** watermark +
  unattended permission model; see `commands.md` § scheduled routines). *Lifting
  Dream's policy into a skill is a direction under review (#302), not current state
  — Dream today is runtime code (`agentDreamExtraction.ts`).*
- **Compaction — the boundary marker; NOT skill-able.** Compaction is *substrate
  Neva runs on* (context management that lets a long run continue), not a faculty
  it owns. A skill is itself an agent run, so implementing compaction as a skill
  bootstraps the floor with something that runs on the floor. It is also hot-path
  (stalls the live turn) and carries a strict persistent format contract (changing
  the summary wording silently breaks extraction of on-disk summaries —
  `agentCompaction.ts`). Its *policy* is already an editable prompt
  (`FULL_COMPACT_PROMPT_BODY`; `/compact` takes custom instructions), so the
  retention judgment is tunable — but the **operation** stays in the kernel.
  Mechanism stays in; policy can move out; never move both.

By this test: Dream / periodic review / triage / import / research → policy is
skill-able; compaction / tool-result trim / context-budget / the scheduler itself /
single-writer + transactions / the permission floor → kernel.

## Removed multi-agent apparatus

The single-agent collapse removed the whole multi-agent layer. There is no longer
a Channel-vs-DM distinction, no peer agents, and no `@`-routing. Removed:

- channel-org tools (`channel_create` / `channel_update`, `channelOrg`);
- member roster + `@`-mention routing + typeahead/handoff;
- POV / independence cut + the per-agent POV inspector;
- the channel activity surface and channel permission gates;
- multi-agent channel-turn execution + the parallel-channel runtime;
- the `ChannelConfigWindow` configure plumbing;
- the dead message-addressing protocol fields;
- `canonicalDmAgentId`, the `lin-agent-dm-` prefix, and DM-vs-Channel branching;
- the two conversation-list sections + two "+" buttons (now one conversation
  list, no nav-lock; "General" is the default landing);
- `dmRunActive` / `channelRunsActive` (collapsed to one `runActive`).

The render projection collapsed accordingly (no channel/POV entities), and the
environment reminder is single-agent. The conversation noun
("channel"/"conversation") stays; only the multi-agent semantics are gone.

## Verified status

| Area | Status | Note |
|---|---|---|
| Three-ledger storage + write-time split | ✅ built | legacy flat log deleted on startup; the store stays principal-keyed internally |
| `Principal` + per-message `actor` | ✅ built | user actor = `local-user` (single-user); members are always `{user, Neva}` |
| One editable agent — Neva | ✅ built | built-in `built-in:tenon:assistant` (handle `assistant`); user edits layer as a stored overlay (`builtInAgentProfiles` in `agent-providers.json`); directly editable in Settings → Agent (model/effort/persona/tools/skills); Save persists the overlay, Delete suppressed for the built-in |
| Channels-only conversations (no DM) | ✅ built | every conversation is single-agent + inline-streaming + steerable; one conversation list (no two sections / two "+" buttons), no nav-lock, "General" default landing; `canonicalDmAgentId` / `lin-agent-dm-` prefix / DM-vs-Channel branching removed |
| Run→conversation anchor + per-conversation run index | ✅ built | `runs WHERE conversationId=X` is enumerable |
| Delegation / child-run runtime (#164) | ✅ built | sub-agents spawned for a TASK (NOT peers/members); ordinary Runs with their own `runs/<runId>/` ledger, joined by `parentRunId`/`parentToolCallId`; surfaced in the conversation task panel (child-run tasks only) |
| One believer-keyed first-person memory pool | ✅ built | all MEMORY read/write pinned to `agent:built-in:tenon:assistant`; flat `<memory>` briefing of subject-named third-person facts; `memoryIsolation` removed; no transactive / cross-principal sharing |
| One Dream (conversation-evidence) | ✅ built | distills member conversations (episodic) into the believer pool (semantic); agent-self / run-log Dream + run-evidence harvesting cut; manual `/dream` fires it; Dream history relocated to Settings → Agent "Memory & activity" (`agent_list_dream_history`) |
| Memory source binding under compaction (#164) | ✅ built | fact sources recorded as `{episodeId}` and episodes as `{stream, streamId, range}` raw sources over the ledgers; `recall include_evidence` zooms fact → episode gist → raw span; the compaction evidence invariant is described in `agent-event-log-rendering.md` |
| Permission gate | ✅ built | ask / allow / deny over the hard A3 floor |

## Known tensions / honest caveats

- **Heterogeneous subjects in one pool.** The single believer pool mixes facts
  about the user with facts about the work/domain; self-contained subject-naming
  (no elision) is what keeps a flat `<memory>` list legible.
- **Authored vs dreamed.** Neva's persona/habits and skills are authored and are
  never produced by Dream; only conversation evidence is consolidated.
- **Principal stays dual-use.** `principalKey` / `AgentPrincipal` remain in the
  event store for conversation MEMBERSHIP (members are still `{user, Neva}`), even
  though MEMORY is now a single believer pool.
