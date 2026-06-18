# Agent memory on the timeline

## Goal

Replace the agent's separate event-log memory subsystem with **memory as ordinary
outliner nodes on the daily timeline**, written and read through the existing
`node_*` tools and a re-provided `past_chats` tool, with consolidation ("dream")
expressed as an **editable skill** instead of hardcoded runtime logic.

Memory becomes legible and correctable in two senses:

- **Content** — you can see and edit *what* Neva remembers, in your own timeline,
  where you already look. Editing a memory node *is* correcting the memory.
- **Policy** — *how* Neva remembers (the consolidation playbook) is a skill
  document, not code; you (or Neva) tune it by editing markdown.

The end state has **no special memory subsystem**: memory is nodes + `node_*` +
search + skills/persona. The only memory-specific runtime is a thin trigger — and
even that is a special case of the already-shipped scheduled-routines (§ Writing).

## Scope — this is a reversal, not a "supersede"

State the magnitude honestly (it sets the A6 fold-into-spec budget): this does **not**
"supersede the relevant parts" of the memory docs — it **reverses a shipped,
PM-ratified subsystem and the data-model's founding axiom**.

- It **reverses `agent-data-model.md` §0–§2**: the hard axiom *"agent data … never
  touches Loro"* and the *"one log engine, three instances, memory = single writer
  per stream"* model. Moving the memory line into Loro **deliberately abandons
  memory's single-writer invariant** (Loro has two writers: user + agent) — which is
  exactly what makes memory user-editable, and is a conscious PM-owned reversal.
- It **retires most of `agent-memory-foundations.md`'s working-memory / activation /
  retrieval-mode content** (the passive-briefing/chronic-activation machinery).
- It **keeps the spine**: auditability (a source dereferences to original bytes or
  fails loud) and the episodic→semantic consolidation ladder.

The A6 step is therefore a **rewrite** of those spec sections, not a patch — budget it.

## Shape

A **SET of independent, complete features**, ordered by dependency:

- **PR1 — Re-provide the `past_chats` agent tool.** Independently complete and
  valuable (Neva can read/search/verify raw past conversations again). Foundation
  for everything below (A7).
- **PR2 — Node-based memory.** The atomic core flip: node structure + dream-as-skill
  + the scheduled-routines trigger + pull-only recall, replacing the event-log memory
  store, the activation/decay engine, the passive briefing, and the `recall`/`dream`
  tools. Pre-release, no migration — old memory is wiped, not converted.
- **PR3 — Jump-to-source UI.** A pure addition on top of PR2: render a memory node's
  source pointer as a clickable affordance that opens the conversation transcript at
  that position.

PR1 and PR3 are each shippable and reviewable alone; PR2 is the one large,
genuinely-atomic change (memory cannot be half-migrated pre-release — read and write
must flip together; the obvious "land node structure first, fill later" split is the
forbidden scaffold-then-fill).

**Ordering dependency:** PR2 presupposes `single-agent-finish-collapse` has landed —
that plan makes `principal` constant (one pool) and removes the cross-principal
redaction surface, both of which PR2 builds on, and the two touch the same files.
**Sequence: `single-agent-finish-collapse` merges first, then PR2.**

## Background — what exists today (verified against `main`)

- **Memory store.** A separate append-only event log per principal
  (`principals/<principal>/memory/events.jsonl`), **not** in the Loro document.
  `principal` is **still a variable parameter** on the memory APIs
  (`addMemoryEntry(principal, …)`); it becomes a constant only once
  `single-agent-finish-collapse` lands (currently P0 draft, not shipped). Shapes:
  `AgentMemoryEntry` (semantic) + `AgentMemoryEpisode` (episodic), each with
  `sources[]` of `AgentMemorySource {stream, streamId, range}` pointing at
  conversation/run spans (`src/core/agentEventLog.ts`).
- **Dream.** Runtime code (`src/main/agentDreamExtraction.ts` + `agentRuntime.ts`)
  reads conversation/run logs past a per-pool `AgentDreamWatermark {conversations,
  runs}`, builds an extraction prompt, and applies add/update/forget actions. Fired
  by the `dream` self-maintenance tool (`agentSelfMaintenanceTools.ts`) + an
  autonomous daily-cadence scheduler + backoff (`dreamBackoff.ts`, #189). There is no
  `/dream` slash command.
- **Recall + briefing.** `recall` is a tool doing BM25 + a three-component
  activation/decay model + source-association ranking (`agentMemoryRetrieval.ts`,
  `agentMemoryActivation.ts`). **Briefing is LIVE**, not dead code: per-turn injection
  via `buildMemoryReminder` → `withMemoryReminder` (`agentDelegation.ts:1063-1069`).
  Deleting it removes a running capability (see Reading).
- **`AgentPastChatsService`** (`src/main/agentPastChats.ts`) already has
  `search` / `recent` / `read` / `readMemorySourceEvidence`, but only the last is
  wired (into `recall`'s evidence expansion). A `past_chats` *tool* existed
  historically (`11a5b680`), removed in `1a04f6ce`; the engine survives.
- **Node search exposes ranked text (feasibility premise — verified).** `node_search`
  passes `host.getTextSearchIndex()` into `runSearch` (`agentNodeTools.ts:968`) and
  accepts a `STRING_MATCH` text rule backed by the BM25 index (`textSearchIndex.ts`,
  `this.bm25(...)`). So "recall = content search" is **not** a downgrade — the old
  recall's BM25 capability exists on the node side. (PR2 detail: confirm results come
  back BM25-*ranked*, not just as a membership set.)
- **Document node model.** Date nodes are plain `ContentNode`s tagged `tag:day` under
  `daily-notes`; `todayId` is dynamic. Nodes carry `tags`, a `capture` sidecar for
  provenance, `locked`, and are mutated by the agent via `origin:'agent'` commands.
  The renderer only draws **real Loro nodes** (the projection is built from
  `state.nodes`) — there is no virtual node channel. A `reference` node targets a
  `NodeId` (in-document only).

## Design

### 1. Storage — memory is nodes on the timeline

```
2026-06-18  (day node, tag:day)
  ├ [the user's own notes for the day …]
  └ d-memory  (per-day memory container; holds the dream watermark)
      ├ d-episode: "时间线做记忆的设计讨论"   (gist + source pointer)
      │   └ d-belief: "memory is pull-only; no passive briefing"
      ├ d-episode: "composer chip review 修复"
      │   └ d-belief: "the user prefers terse reviews"
      └ d-episode: …
```

**Naming.** Tags are named for *what a node is*, not who made it or how, and are
honest about epistemics. The `d-` prefix namespaces the family (collision-avoidance
+ a visible group marker):

| tag | what it is |
|---|---|
| **`d-memory`** | the per-day memory container: the day's memory home, the recognition marker, and the carrier of the dream **watermark** field. |
| **`d-episode`** | an episodic unit — a *topical segment* of a conversation (one session that covers many topics yields many episodes); holds a gist + a source pointer. |
| **`d-belief`** | a semantic unit — durable knowledge. Named `belief` (not `fact`) on purpose: it is what Neva holds true and **may be wrong**; calling it a "fact" would overclaim truth and fight the auditable-but-fallible ethos. |

(`dream` names the *process / skill*, never a node. "Who made it" is provenance —
`origin:'agent'` — not the tag.)

- **Episodes** live under the day they happened; episodic memory is time-anchored and
  the timeline is its natural index.
- **Beliefs** are born under the episode that produced them (provenance is partly
  structural: the parent episode is the evidence). A belief has a **single mutable
  identity**: it is **updated in place**, never tombstoned; other days/episodes that
  touch it again **reference** the same node. Beliefs are **timeless** — no
  valid-from/valid-until. A reference always resolves to the belief's current state.
- **Belief change-history.** Each meaningful change to a belief **appends a
  change-history entry** (a body annotation or child node) recording *what changed and
  why* — and, for dream-driven changes, the new source pointer (§2). This both keeps
  the node a single evolving identity *and* preserves fact-level history on the node
  (you can see "Neva learned X from conversation A, then the user corrected it to Y"
  without replaying the conversation). Lightweight: an unchanged belief has no history.
- **Why single-day anchoring is no longer an anti-pattern.** The classic objection (a
  belief stuck on one day is hard to re-find) assumed *timeline-walk* retrieval.
  Retrieval here is content search (§4), which ignores physical location.
- **Recognition + status.** Memory nodes are recognized by the `d-` family (as date
  nodes are by `tag:day`). Active-vs-superseded is a **node state** (strikethrough /
  archive), not a kind tag. Nodes are real, user-editable, `locked` + `origin:'agent'`.

### 2. Provenance — an accumulating cross-boundary source pointer

The one invariant carried over: **memory is for an unreliable rememberer, so it must
be auditable — a source dereferences to the original bytes or fails loud.**

- Conversations stay in the event-log (they are **not** nodes), so a normal
  `reference` (which targets a `NodeId`) cannot point at them. Carry the existing
  `AgentMemorySource {stream, streamId, range}` as a **structured field on the node**
  (sidecar style, like `capture`) — not as a `reference` child.
- **Accumulate, never clear.** When a belief is reinforced or changed, the new source
  is **appended** (a belief may cite several sources across the times it was asserted);
  old pointers are kept, bound to their change-history entry (§1). A pointer therefore
  always describes *what it supported at that time*, never claims to support the
  current text — which dissolves the "resolves-but-no-longer-matches" hazard. A **user
  hand-edit** appends a change entry too (reason: `user-edited`, no machine source), so
  the trail stays honest and append-only.
- **Agent follow-path (the important one):** the agent sees a memory node and confirms
  it against the source → `past_chats.read(source)` returns the original text (the same
  dereference as today's `readMemorySourceEvidence`). The pointer + the `past_chats`
  tool (§5) close the verify loop.
- **User follow-path:** the renderer draws the pointer as a clickable "↗ source"
  affordance → opens that conversation's transcript at the seq (PR3).
- **Fail-loud:** compacted / self-cleaned sources resolve to "evidence unavailable,"
  never a crash. A user can also delete a pointer (it is their document); fail-loud
  covers that too.
- The episode is the natural pointer carrier; a belief **inherits its parent episode's
  pointer** at birth, and accumulates its own as it changes. Finer per-message spans
  are a later refinement.

### 3. Writing — dream as a skill, fired by the shipped scheduled-routines

A "runtime fires a smart thing on a trigger" decomposes into three layers; only the
bottom one is skill-able:

| layer | what | home |
|---|---|---|
| **Trigger (when)** | schedule + durable cursor (watermark), at-most-once, backoff, the bright line (an agent can't forge a fire) | **runtime** |
| **Mechanism (how it moves)** | windowing, the persistent format contract, transaction, abort/retry | **runtime** |
| **Policy (the judgment)** | what to extract / keep / how to phrase | **skill** |

- **Trigger + mechanism = the already-shipped scheduled-routines** (`docs/plans/
  archive/agent-scheduled-routines.md`: timeline command nodes + `{type:'schedule'}`
  triggers + anacron scheduler + at-most-once crash recovery + backoff + forward-only,
  agent-barred watermark + unattended permission + "runs are subagents"). **Dream is a
  command node that fires the dream skill + advances one watermark** — *not* a second
  memory-specific scheduler. This makes "no special memory subsystem" more true and
  inherits the shipped isolation/crash-recovery model for free.
- **Dream skill (markdown playbook).** Owns *how*: read the runtime-supplied
  `since:{seq}` range via `past_chats` → segment each conversation into topical
  episodes → write `d-episode` nodes (gist + source) → extract beliefs; **search
  existing `d-belief` nodes first** and update in place, else create under the episode.
  The model never manages the cursor — the routine supplies the range and advances the
  watermark after a successful pass.

### 4. Reading — pull-only (a PM-owned experience trade), taught by persona

- **No passive briefing.** Memory enters context only when the agent fetches it. This
  is what lets the entire activation/decay/briefing machinery be deleted — but it is a
  **deliberate, PM-owned experience regression, not a free simplification**: a fresh
  conversation opens **cold** (knowing nothing about the user until the agent searches),
  trading a deterministic system injection for a behavioral bet + a tool round-trip at
  task start. Accepted; no recent-episodes backstop in this version.
- **Recall = search.** `node_*` / search over the `d-` family (BM25-ranked text;
  feasibility verified above), plus `past_chats` for raw chats. Taught by **standing
  persona instructions** (always loaded) — not an invokable skill, because using memory
  must be habitual ("recall relevant memory at task start"), and gating it behind a
  skill the agent must first decide to load is circular.
- **Compensation:** memory is now visible on the timeline, so the user can see and
  point at it even when the agent does not auto-recall.

### 5. The `past_chats` tool (re-provided)

- Re-expose `AgentPastChatsService` as an agent tool: `recent` (list), `search`,
  `read` (full text), with a `since:{seq}` parameter, reusing
  `readMemorySourceEvidence` for the pointer dereference.
- Serves three consumers: the **dream skill** (raw material), **interactive recall**
  (Neva answering "what did we discuss last week" from raw chats, not just distilled
  beliefs), and **provenance verification** (§2). Independently valuable → ships first.

### 6. Dedup — tag enumeration + agent judgment, not a fixed key

No fixed identity key. A content-hash key cannot dedup rewordings ("prefers terse
reviews" vs "likes concise reviews" → different hash, same belief), and semantic dedup
is inherently model judgment — so a "key" does not escape it. Instead: the `d-belief`
tag **enumerates** all beliefs (node id is the identity), and the dream skill **decides
update-vs-create** by judgment. The backstop against proliferation is **not** a key but
(a) good retrieval (the BM25 `node_search` lets the skill reliably *find* the matching
belief to update) + (b) a "search-before-create" discipline in the skill. Residual drift
(occasional duplicate / missed update) is an accepted, watched cost.

### 7. Protocol surface touched (honest framing)

"Mostly reuses `node_*`" is true, but **a few memory-specific fields land in
`src/core/types.ts`** (protocol / infrastructure-ownership surface): the
`AgentMemorySource` sidecar field on the node and the watermark field on the
`d-memory` container, plus the `d-` recognition tag scheme. These are **interface-first
coordination** (land the field definitions ahead of consumers), not a zero-protocol
change.

## The seam test (so we don't over-generalize "make X a skill")

The criterion for "can this become a skill" is **not** "does it have a trigger"
(everything does) — it is: *is this handler a judgment the user would want to read and
edit, AND can it tolerate being one forked agent run (offline, recoverable on failure,
not bootstrapping the substrate it runs on)?*

- **Skill-able:** dream, periodic review, triage, import, research → they produce an
  artifact and run offline.
- **Kernel (never a skill):** compaction, tool-result trimming, context budgeting, the
  scheduler itself, single-writer, the permission floor. Compaction in particular is
  *substrate the agent runs on* (a skill is itself an agent run — you cannot implement
  the floor with something that runs on the floor), is hot-path, and carries a strict
  persistent format contract.
- **Hybrid:** compaction's *retention policy* is already a prompt (`/compact` takes
  custom instructions) — making the policy editable is fine; making the *operation* a
  skill is not.

## Non-goals

- **No bi-temporal validity.** Beliefs are timeless and update in place.
- **No passive briefing / activation-decay ranking.** Memory is pull-only.
- **No migration / back-compat.** Pre-release: wipe `~/.lin-outliner-*` dev memory;
  delete the old readers.
- **Conversations are not moved into the document.** They stay in the event-log; the
  memory→conversation link is the cross-boundary pointer of §2.
- **No agent-private vs user pool split.** Collapsed to one pool; not reintroduced.
- **No new node `type` discriminant.** Memory uses the `d-` tags + location.

## PM-owned postures (ratified)

- **Pull-only is an intentional experience regression** (cold-start), accepted (§4).
- **Memory now lives in the exportable user document** — it is no longer an isolated
  substrate; it rides along on any export / backup / future sync. Accepted as the
  posture for a local single-user app; stated plainly rather than buried.

## Deferred to PR2 (implementation details, design is settled)

- Recognition query: a `d-` prefix/namespace query vs a shared base tag.
- The exact shape of belief change-history entries (body annotation vs child nodes).
- Confirming `node_search` returns BM25-*ranked* order to the agent.
- `AgentMemorySource` field representation on the node.

## Build order (within PR2) — independently-verifiable milestones, each green first

Foundation before consumers (A7); each milestone ships with tests and is green before
the next; the `src/core/types.ts` field definitions land **interface-first**.

- [ ] **M0 (interface-first):** define the protocol-surface fields in
      `src/core/types.ts` — the `d-memory` watermark field and the `AgentMemorySource`
      sidecar field — coordinated ahead of consumers.
- [ ] **M1:** the node structure — `d-memory` container, `d-episode` / `d-belief`
      recognition, the source field, change-history entries. (Tests: shape + recognition.)
- [ ] **M2:** dream writes nodes (segment → `d-episode` → `d-belief`, update-in-place
      with search-before-create) via the scheduled-routines trigger + skill split (§3).
      (Tests: a dream pass produces the expected tree + advances the watermark.)
- [ ] **M3:** recall is pull-only over the nodes (persona guidance; remove briefing).
      (Tests: recall returns BM25-ranked beliefs; no passive injection occurs.)
- [ ] **M4:** remove the event-log memory pool, activation/decay engine, and
      `recall`/`dream` tools. (Tests: old paths gone; no dangling references.)
- [ ] **M5:** fold the shipped design into `docs/spec/` (A6) — a rewrite of the
      reversed sections of `agent-memory-foundations.md` / `agent-data-model.md`.
