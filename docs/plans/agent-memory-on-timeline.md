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
search + skills/persona. The only memory-specific runtime that survives is a thin
scheduler that fires the dream skill and advances a watermark.

## Shape

A **SET of independent, complete features**, ordered by dependency:

- **PR1 — Re-provide the `past_chats` agent tool.** Independently complete and
  valuable on its own (Neva can read/search/verify raw past conversations again).
  Foundation for everything below (A7).
- **PR2 — Node-based memory.** The atomic core flip: node structure + dream-as-skill
  + runtime trigger/watermark + pull-only recall, replacing the event-log memory
  store, the activation/decay engine, the passive briefing, and the `recall`/`dream`
  tools. Pre-release, no migration — old memory is wiped, not converted.
- **PR3 — Jump-to-source UI.** A pure addition on top of PR2: render a memory node's
  source pointer as a clickable affordance that opens the conversation transcript at
  that position.

PR1 and PR3 are each shippable and reviewable alone; PR2 is the one large,
genuinely-atomic change (memory cannot be half-migrated pre-release — either it is
nodes or it is the event-log). Within PR2 the steps below are build-order, not
separate releases.

## Background — what exists today

- **Memory store.** A separate append-only event log per principal
  (`principals/<principal>/memory/events.jsonl`), *not* in the Loro document. The
  single-agent collapse already reduced this to **one undivided pool** ("Neva's
  knowledge"); the per-principal agent-vs-user split is gone (`principal` is now a
  constant). Shapes: `AgentMemoryEntry` (semantic fact) and `AgentMemoryEpisode`
  (episodic gist), each with `sources[]` of `AgentMemorySource {stream, streamId,
  range}` pointing at conversation/run spans (`src/core/agentEventLog.ts`).
- **Dream.** Runtime code (`src/main/agentDreamExtraction.ts` +
  `src/main/agentRuntime.ts`) that reads conversation/run logs past a per-pool
  watermark, builds an extraction prompt, and applies add/update/forget actions to
  the memory log. Scheduled (~60s ticks, backoff) + manual `/dream`.
- **Recall + briefing.** `recall` is a tool doing BM25 + a three-component
  activation/decay model + source-association ranking
  (`src/core/agentMemoryRetrieval.ts`, `src/core/agentMemoryActivation.ts`).
  **Briefing** is the passive per-turn injection of activation-ranked entries
  (`src/main/agentMemoryBriefing.ts`) — the reason the agent "just knows" things.
- **`AgentPastChatsService`** (`src/main/agentPastChats.ts`) already has
  `search` / `recent` / `read` / `readMemorySourceEvidence`, but only the last is
  wired (into `recall`'s evidence expansion). A `past_chats` *tool* existed
  historically (`11a5b680`, `042ba3a4`) and was removed; the engine survives.
- **Document node model.** Date nodes are plain `ContentNode`s tagged `tag:day`
  under `daily-notes` (Year→Week→Day); `todayId` is a dynamic projection pointer.
  Nodes carry `tags`, a `capture` sidecar for provenance, `locked`, and are mutated
  by the agent through `origin:'agent'` commands. The renderer only draws **real
  Loro nodes** (the projection is built from `state.nodes`) — there is no virtual /
  projection-only node channel. A `reference` node targets a `NodeId` (in-document
  only). Search supports tag / `IS_TYPE` / `ON_DAY_NODE` queries.

## Design

### 1. Storage — memory is nodes on the timeline

```
2026-06-18  (day node, tag:day)
  ├ [the user's own notes for the day …]
  └ Neva  (per-day memory container; holds the dream watermark)
      ├ episode: "时间线做记忆的设计讨论"   (gist + source pointer)
      │   └ fact: "memory is pull-only; no passive briefing"
      ├ episode: "composer chip review 修复"
      │   └ fact: "user prefers terse reviews"
      └ episode: …
```

- **Per-day Neva container.** One container node under each day node. Keeps agent
  memory visually separate from the user's own day content, and is the home for the
  dream **watermark** (a field: "consolidated through conversation seq N").
- **Episode** = a *topical segment* of a conversation, **finer than a conversation**:
  one session that covers many topics yields many episodes. Each episode node holds a
  gist of what happened + a cross-boundary **source pointer** (§2). Episodes live
  under the day they happened — episodic memory is time-anchored, and the timeline is
  its natural index.
- **Fact** = durable knowledge, born under the episode that produced it (so
  provenance is partly structural: the parent episode is the evidence). A fact has a
  **single mutable identity**: it is **updated in place** when it changes and
  **never tombstoned**; other days/episodes that touch it again **reference** the
  same node. Facts are **timeless** — no valid-from/valid-until. The reference always
  resolves to the fact's current truth.
- **Why update-in-place is safe.** The auditability the old design protected ("what
  did Neva used to think") lives in the **immutable conversation/episode record**,
  not in fact-version-history. Clean split: **fact = current truth (mutable, single
  identity); episode/conversation = what happened then (immutable)**.
- **Why single-day anchoring is no longer an anti-pattern.** The classic objection
  (a fact stuck on one day is hard to re-find) assumed *timeline-walk* retrieval.
  Retrieval here is **content search** (§4), which ignores physical location — so a
  fact can be born where it was learned and still be found anytime.
- **Recognition + status.** Memory nodes are recognized by tag (as date nodes are by
  `tag:day`). Active-vs-superseded is a **node state** (strikethrough / archive),
  **not** a kind tag — kinds stay limited to episode/fact. Nodes are real,
  user-editable, `locked` + `origin:'agent'`.

### 2. Provenance — a cross-boundary source pointer

The single load-bearing invariant carried over from the old design: **memory is for
an unreliable rememberer, so it must be auditable — a source dereferences to the
original bytes or fails loud.**

- Conversations stay in the event-log (they are **not** nodes), so a normal
  `reference` (which targets a `NodeId`) cannot point at them. Carry the existing
  `AgentMemorySource {stream, streamId, range}` as a **structured field on the memory
  node** (sidecar style, like `capture`) — not as a `reference` child.
- **Agent follow-path (the important one):** the agent sees a memory node, wants to
  confirm it against the source → `past_chats.read(source)` returns the original
  conversation text (the same dereference as today's `readMemorySourceEvidence`).
  The node's pointer + the `past_chats` tool (§5) close the verify loop.
- **User follow-path:** the renderer draws the pointer as a clickable "↗ source"
  affordance → opens that conversation's transcript at the seq (PR3).
- **Fail-loud:** compacted / self-cleaned sources resolve to "evidence unavailable,"
  never a crash. Honest gaps *are* the auditability.
- The episode is the natural pointer carrier (it summarizes a specific span); a fact
  may inherit its parent episode's pointer or carry a finer one (open question 6).

### 3. Writing — dream as a skill + a thin runtime trigger

Split by responsibility along the line that the model cannot reliably hold:

- **Runtime trigger (the only memory runtime that survives).** Owns *when*: a
  schedule fires the dream pass, computes the "since last watermark" conversation
  range, passes it into the skill, and **advances the watermark after** the pass
  succeeds. The model never manages the cursor (no off-by-one, no forgetting).
- **Dream skill (markdown playbook).** Owns *how*:
  1. Read the given range via `past_chats`.
  2. Segment each conversation into **topical episodes**.
  3. For each episode, write an episode node under today's Neva container (gist +
     source pointer).
  4. Extract durable facts; for each, **search existing fact nodes** — update in
     place if found, else create under the episode.
  5. (Watermark advance is the runtime's job, post-pass.)
- All of step 1–4 is `past_chats` + search + `node_*` — nothing memory-specific.

### 4. Reading — pull-only, taught by persona

- **No passive briefing.** Memory enters context only when the agent fetches it
  (the user's explicit choice: memory is agent-pull, never system-push). This is
  what lets the entire activation/decay/briefing machinery be deleted.
- **Recall = search.** `node_*` / search over memory-tagged nodes, plus `past_chats`
  for raw chats. Taught by **standing persona instructions** (always loaded), not an
  invokable skill — because using memory must be *habitual and pervasive*
  ("recall relevant memory at task start"), and gating it behind a skill the agent
  must first decide to load is circular.
- **Cost accepted:** the agent only knows what it looks up; a cold conversation
  starts without memory until it recalls. Mitigations: persona habit + the fact that
  memory is now **visible on the timeline** (the user can see and point at it).

### 5. The `past_chats` tool (re-provided)

- Re-expose `AgentPastChatsService` as an agent tool: `recent` (list), `search`
  (find), `read` (full text), reusing `readMemorySourceEvidence` for the
  pointer dereference.
- Serves three consumers at once: the **dream skill** (raw material), **interactive
  recall** (Neva answering "what did we discuss last week" from raw chats, not just
  distilled facts), and **provenance verification** (§2). Independently valuable, so
  it ships first (PR1).

### 6. Removed

- The event-log memory pool (`AgentMemoryEntry` / `AgentMemoryEpisode` storage).
- `agentMemoryActivation.ts`, the ranking half of `agentMemoryRetrieval.ts`,
  `agentMemoryBriefing.ts`, access-stat tracking + the `memory.accessed` event.
- The `recall` and `dream` tools as distinct tools (recall → search; dream → skill).
- Dream-as-runtime-logic (collapses to the thin trigger of §3).

## Non-goals

- **No bi-temporal validity.** Facts are timeless and update in place; no
  valid-from / valid-until. (Considered — Graphiti-style — and deliberately dropped
  for simplicity, justified by content-search retrieval.)
- **No passive briefing, no activation/decay ranking.** Memory is pull-only.
- **No migration / back-compat.** Pre-release: wipe `~/.lin-outliner-*` dev memory;
  delete the old readers rather than convert.
- **Conversations are not moved into the document.** They stay in the event-log;
  the memory→conversation link is the cross-boundary pointer of §2.
- **No agent-private vs user pool split.** Already collapsed to one pool; not
  reintroduced. (If a single sensitive entry must be kept out of an exported
  document, that is a per-entry concern, not an architectural layer — out of scope.)
- **No new node `type` discriminant.** Memory uses tags + location, mirroring how
  date nodes work; a `type` is added later only if distinct rendering/behavior
  proves necessary.

## Open questions

1. **`past_chats` tool surface** — `recent` / `search` / `read`; does it take a
   `since: <seq | time>` parameter (used by the dream trigger to scope the range)?
2. **Write triggers** — background dream only, or *also* let the agent write memory
   on-the-fly mid-conversation via `node_*`? (Both are compatible with pull-only
   reading; not yet decided.)
3. **User-edit vs source pointer** — when the user edits a fact node, the machine
   `source` may no longer support the new text. Flag it ("user-edited"), clear the
   pointer, or leave the detectable mismatch as a feature?
4. **Recall guidance vehicle** — standing persona instructions (leaning this) vs a
   loadable "memory" skill.
5. **Literal tag scheme** — the exact tag names, and whether a base `memory`
   recognition tag is needed at all or location under the Neva container suffices.
6. **Fact source granularity** — a fact inherits its parent episode's source pointer,
   or carries its own finer span to the exact messages that asserted it.

## Build order (within PR2)

Foundation before consumers (A7):

- [ ] Define the node structure: per-day Neva container, episode/fact recognition,
      the source field, the watermark field.
- [ ] Re-point dream to write nodes (segment → episode nodes → fact nodes,
      update-in-place) via the runtime trigger + skill split of §3.
- [ ] Make recall pull-only over the nodes (persona guidance; remove briefing).
- [ ] Remove the event-log memory pool, activation/decay engine, and `recall`/`dream`
      tools.
- [ ] Fold the shipped design into `docs/spec/` (A6) — supersedes the relevant parts
      of `agent-memory-foundations.md` / `agent-data-model.md`.
