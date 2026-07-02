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
   "who": a conversation member, a message `actor`, and the subject of a
   reflective Dream run. One type unifies member = actor = Dream subject. Members of every
   conversation are `{user, Neva}`. ✅
2. **Conversation** — the shared, objective record of a thread. Holds `members:
   Principal[]`, always `{user, Neva}`. Every conversation is a single-agent,
   inline-streaming, steerable thread. There is **no DM/Channel branching and no
   stored `kind`**; the conversation noun ("channel"/"conversation") stays, the
   multi-agent channel semantics are gone. ✅
3. **Run** — one unit of agent execution (one reply or task). Anchored to a
   conversation (the only home). Holds **all** execution detail. The presentation
   categories (turn/background/delegation/scheduled/reflective) are **derived**
   from `trigger` + lineage (`parentRunId`) + `disposition: attended | detached`
   + anchor provenance; no run stores a `kind`. The durable Run index stores
   nested `execution.status` for process state, optional `objective.{text,
   criteria, role, status, scope, budget}` for tracked work state, and
   `runProfile` for execution policy specialization. **Task is a view** (=
   detached/background or child runs). ✅
4. **Memory** — Neva's first-person knowledge, held as ordinary timeline outline
   nodes (`#d-memory`, `#d-episode`, `#d-belief`, `#d-question`, `#d-guidance`).
   Canonically framed in the standard cognitive-science vocabulary — see *The
   memory system* below. ✅
5. **Skill** — a reusable instruction, bound by name from one shared library
   (authored procedural memory — never dreamed). ✅
6. **Agent** — the single user-customizable agent, **Neva** (stable agentId
   `built-in:tenon:assistant`, handle/mention `assistant`). A built-in defined in
   code; user edits layer as a stored overlay. Persona + model/effort + skill
   bindings + tool/permission profile + timeline memory tools. ✅
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
| **Memory** | timeline outline nodes (`#d-memory`, `#d-episode`, `#d-belief`, `#d-question`, `#d-guidance`) plus Dream-channel audit/run metadata | user-editable durable memory nodes + runtime Dream progress | sub-linear |

Model-readable durable memory has no separate event-log copy. It is ordinary
outline content on the timeline; Dream-channel events and run metadata are
audit/progress, not a second memory store.

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
  spawns helper runs for a bounded objective. Delegation is **fork-only**: a fork *is* Neva
  continuing in an isolated child context (it runs AS Neva — same
  `executingAgentId`/`memoryOwnerAgentId`), never a second agent. The cross-agent
  "fresh" path (a sub-agent with its own identity + memory line) is **removed**
  (`single-agent-finish-collapse`): the `Agent` tool carries no `agent_type`, the
  registry loads only Neva, and no file-backed `.agents/agents/*` definition is
  loaded. `/research` and background self-work are forks of Neva; runtime Dream
  is a restricted top-level run in the protected Dream channel. Child runs carry
  `parentRunId`; they are **not** conversation members and **not** peers. ✅ — and
  the code honors the model (`agent-run-unification`, shipped): a delegated run is
  an ordinary Run with its OWN `runs/<runId>/` ledger (its own seq space, replayed
  alone), joined to the parent by `parentRunId`/`parentToolCallId`; its
  delegation category is derived from lineage, not stored. One `{seq, eventId}`
  evidence + watermark scheme exists everywhere; child compaction is
  event-sourced like a conversation's. The former entity-grade species
  (transcript payload snapshots, the `runId:message:N` codec, the positional Dream
  cursor) is deleted. Delegated runs surface in the global Work/Runs view
  (non-turn, non-Dream runs only).

### Verified goal runs

Long objectives use the same Run primitive, not a new Task object. There is no
user-facing goal mode, `/goal` shortcut, or composer goal button: users describe
work in ordinary prose, and the model-side `goal-launching` workflow decides when
to start a detached tracked child run with explicit criteria, bounded budget, and
`objective.status: active`. The child may decompose by calling `spawn`; every
spawned worker is a Run, every verifier is a Run with
`objective.role: verifier` and `runProfile: verify`, and every verifier is
runtime-pinned to `context: none` with read-only tools.

The parent-verifies-child rule is structural: a worker's terminal output is not
self-declared completion. The parent spawns an independent verifier Run with a
runtime-built evidence pack (node changes, direct and working-set file changes,
tool trace, result, criteria, and run ids). A pass sets the worker
`objectiveStatus` to `verified`; a verifier gap leaves that worker attempt
completed but blocked and the parent starts a fresh replacement worker Run with a
new `runId` when budget remains. Controllers/root goal runs keep their own
`runId`; worker attempts are replaceable. Repeated identical gap signatures trip
the local livelock guard and block instead of silently burning budget.

Budgets are local to each edge. A child run is admitted only if its requested
wall-clock/token slice fits under the parent slice; token slices are reserved
before sibling spawns and settled when the child terminates. Scope also narrows
downward: a child can receive only a subset of its parent's action-kind
capabilities/resources, and the visible tool catalog is derived from those action
kinds.

## User ↔ Agent (control + memory relationship)

The relationship is layered: at the conversation layer user and agent are symmetric
Principals and the members of every conversation are `{user, Neva}` (✅); at the
control layer the user is **authority** and Neva is **delegate** (✅ — the
permission gate); at the memory layer there is **one editable timeline memory
graph** — Neva's own knowledge about both the user and the work/domain, distilled
silently in the background by Dream while
**decisions stay with the user**. The implementable boundary: **epistemic
curation is autonomous** (so Dream can run), **volitional commitment escalates**
(== the existing ask-gate). The earlier two-pool `(user + self-agent)` direction
and the `<self>`/`<principal>` render zones are collapsed into ordinary tagged
outline memory.

## The memory system (canonical vocabulary; timeline memory graph)

Memory is organized as a textbook system — **ground truth below it, three
stores, one index, three processes** (the full memory vocabulary lives in
`agent-tool-design.md` § *Memory*). Durable model-readable memory is no longer
a principal event-log projection. It is ordinary user-editable outline content:
per-day `#d-memory` containers plus optional `#d-episode`, `#d-belief`,
`#d-question`, and `#d-guidance` descendants. `memoryIsolation` is removed.

- **Ground truth (below memory):** the conversation/run ledgers — the immutable
  world record. Not a memory store; every memory structure is derived over it
  and bottoms out in it through `[[chat:...]]` citations.
- **Stores:** episodic (`#d-episode` outline nodes) · semantic (`#d-belief` plus
  generated-headline `#d-memory` containers) · procedural (skills — "what I can
  do").
- **Index:** `chat-source` inline refs bind outline memory nodes to validated
  conversation source ranges. They point, never copy transcript content.
- **Processes:** consolidation (runtime-only Dream skill — scheduled
  at-most-once daily, plus user-triggered manual runs from Settings — replays
  visible conversation spans and, when a high-signal memory filter leaves durable
  memory worth writing, records it in today's generated-headline `#d-memory`
  container with optional `#d-episode` / `#d-belief` / `#d-question` /
  `#d-guidance` nodes and selective `[[chat:...]]` provenance; a run that finds
  nothing worth remembering writes nothing) · retrieval (foreground pull through
  `node_search` / `node_read`, plus `past_chats` for raw prior chat spans) ·
  forgetting/supersession as ordinary node edits.

**Belief phrasing:** `#d-belief` nodes are concise, self-contained statements
that name their subject. There is no resident `<memory>` briefing and no
cross-principal social layer.

Definitions + the memory tool surface: `agent-tool-design.md` § *Memory*.

## Dream (one consolidation process)

There is **one Dream**: the runtime-only `memory-dream` skill that reads visible
conversation spans via `past_chats`, gathers relevant outline context with
`node_search` / `node_read`, and writes timeline memory nodes. Dream runs as a
top-level unattended turn in the protected Dream channel using a Dream-only run
profile, not as a hidden delegation child. Scheduled attempts are at most once per
daily due; a user may also trigger a manual Dream from Settings, and that manual
run is not blocked by the scheduled due gate. Each run
applies the valuable-memory filter, reconciles prior `#d-*` memories as the
current belief graph, then, when it has memory worth writing, updates today's
single `#d-memory` container, whose title is a generated daily memory headline; a
run that finds nothing worth remembering writes nothing and still completes
cleanly, advancing the watermark — unless it was cut off mid-work by an
unresolved context overflow, which is flagged `incomplete` and, with zero writes,
is retried rather than
counted as a deliberate no-op. It
may write `#d-question` for
unresolved tension and `#d-guidance` for future handling, but these are optional
ordinary tags, not required children. Manual consolidate-only Dream can reconcile
prior Dream results and outline context without new chat spans, and Dream may
edit, move, merge, or delete ordinary outline nodes when consolidation warrants
it. Neva's own persona/habits are **authored**,
never dreamed; skills are **authored** procedural memory, never dreamed. The
former agent-self / run-log Dream, run-evidence harvesting, manual `/dream`, and
the foreground `dream` tool are cut.

**Dream/run surfacing is relocated.** Dream history lives in Settings → Agent
"Memory & activity" panel (alongside memory inspect/correct/forget), fetched via
`agent_list_dream_history`, and the actual run transcript lives in the protected
Dream channel. The Work/Runs view keeps Dream out and lists ordinary non-turn
runs across channels.

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
  unattended permission model; see `commands.md` § scheduled routines). The
  policy now lives in the private built-in `memory-dream` skill; runtime code
  still owns triggering, evidence batching, watermarking, restricted tool access,
  and reflective run metadata.
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
- the `ChannelConfigWindow` **member-management** plumbing (the window itself
  survives as a name-only **create / rename** dialog — see below);
- the dead message-addressing protocol fields;
- `canonicalDmAgentId`, the `lin-agent-dm-` prefix, and DM-vs-Channel branching;
- the two conversation-list sections + two "+" buttons (now one conversation
  list, no nav-lock; "General" is the default landing);
- `dmRunActive` / `channelRunsActive` (collapsed to one `runActive`).

The render projection collapsed accordingly (no channel/POV entities), and the
environment reminder is single-agent. Only the multi-*agent* semantics are gone —
**the Channel container survives as the universal conversation shape.** Every
conversation is an id-namespaced (`lin-agent-channel-…`) single-agent thread with
members `{user, Neva}`; **General** (`lin-agent-channel-general`,
`restoreOrCreateGeneralChannel`) is the default landing, sorted first in the one flat
conversation list; and the user can **create / rename** further channels from that
list's single `+` button (the surviving `ChannelConfigWindow` create/rename dialog — a
title plus an optional opening seed, no member roster). Channel configuration also
owns the per-channel **include in Dream data** setting: ordinary channels default
included, the protected Dream channel is forced excluded, and protected default
channel names stay immutable while their editable settings can still use the same
configuration surface. Protected default invariants are table-driven in the
runtime so General and Dream share the same restore/name/member/settings repair
path. The surviving seams are
`isChannelConversationId` (id-prefix test) and `usesChannelActivitySurface()`
(hardcoded `false`, so every channel-surface branch takes its single-agent inline side).
There is no agent-facing `channel_create`/`channel_update` tool — channel creation is a
user UI action only. (`AgentDebugConversationShape = 'dm' | 'channel'` is a debug-only
leftover; only the single-agent value is ever assigned.)

## Verified status

| Area | Status | Note |
|---|---|---|
| Three-ledger storage + write-time split | ✅ built | legacy flat log deleted on startup; the store stays principal-keyed internally |
| `Principal` + per-message `actor` | ✅ built | user actor = `local-user` (single-user); members are always `{user, Neva}` |
| One editable agent — Neva | ✅ built | built-in `built-in:tenon:assistant` (handle `assistant`); user edits layer as a stored overlay (`builtInAgentProfiles` in `agent-providers.json`); directly editable in Settings → Agent (model/effort/persona/tools/skills); Save persists the overlay, Delete suppressed for the built-in |
| Channels-only conversations (no DM) | ✅ built | every conversation is single-agent + inline-streaming + steerable; one conversation list (no two sections / two "+" buttons), no nav-lock, "General" and protected "Dream" default channels; `canonicalDmAgentId` / `lin-agent-dm-` prefix / DM-vs-Channel branching removed |
| Run→conversation anchor + per-conversation run index | ✅ built | `runs WHERE conversationId=X` is enumerable |
| Delegation / child-run runtime (#164) | ✅ built | helper runs spawned for a bounded objective (NOT peers/members); ordinary Runs with their own `runs/<runId>/` ledger, joined by `parentRunId`/`parentToolCallId`; surfaced in the Work/Runs view (non-turn, non-Dream runs only) |
| Timeline memory nodes | ✅ built | durable memory lives in per-day generated-headline `#d-memory` plus optional `#d-episode`, `#d-belief`, `#d-question`, and `#d-guidance` outline nodes; foreground retrieval is pull-only through `node_search` / `node_read` |
| One Dream (conversation + outline context) | ✅ built | scheduled at-most-once-daily and Settings-manual `memory-dream` Dream-channel runs read member conversations through `past_chats` when sources exist, gather relevant prior memory/workspace context through `node_search` / `node_read`, may delete obsolete nodes with `node_delete`, and update today's memory nodes through the human-dream cycle; the Dream channel retains the newest 512 run transcripts and prunes older run ledgers/anchor markers/search entries; manual consolidate-only can reconcile outline/prior Dream context without new chat spans; agent-self / run-log Dream, manual `/dream`, and foreground `dream` are cut |
| Chat source binding under compaction (#302) | ✅ built | `chat-source` inline refs encode `{stream, streamId, range}` raw sources over the ledgers; node writes validate the exact source before mutation |
| Permission gate | ✅ built | ask / allow / deny over the hard A3 floor |

## Known tensions / honest caveats

- **Heterogeneous subjects in one graph.** Timeline memory mixes facts about the
  user with facts about the work/domain; self-contained subject-naming (no
  elision) is what keeps memory nodes legible without a resident `<memory>`
  briefing.
- **Authored vs dreamed.** Neva's persona/habits and skills are authored and are
  never produced by Dream. Dream consolidates runtime-provided conversation
  evidence plus relevant user-authored outline context; prior Dream memories are
  reconciled as current beliefs, tensions, and guidance, not treated as
  independent facts.
- **Principal stays dual-use.** `principalKey` / `AgentPrincipal` remain in the
  event store for conversation MEMBERSHIP (members are still `{user, Neva}`) and
  Dream audit subjects, even though durable memory is outline content rather than
  a principal event log.
