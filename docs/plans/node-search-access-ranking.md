# Node search access ranking

## Goal

Make **frequently and recently used nodes rank higher in search** — for *all* nodes,
not just memory — by giving node search the recency/access-decay dimension it lacks
today. Concretely: a per-node **access-stats side store** + a **decay-based score
multiplier** folded into the single search-ranking chokepoint (`sortSearchHits`).

Two payoffs, either of which justifies the work:

- **Everyday outline search gets better.** "The node I keep coming back to surfaces
  first" is how people expect search to behave; pure lexical relevance doesn't do that.
- **It is the generic mechanism the node-based memory plan needs.** When memory becomes
  ordinary nodes (`agent-memory-on-timeline`), recall is `node_search`, which returns
  *relevance order only*. The memory plan's pull-only reading therefore loses the
  recency/access ranking that the (removed) memory activation engine provided. This
  plan restores it **generically**, so memory-on-nodes inherits it for free — no
  memory-specific ranking code.

The decay model is **not invented here** — it is the proven retrieval-strength shape
already shipping in `src/core/agentMemoryActivation.ts` (`computeMemoryStrength`),
ported from a memory-only engine to a general per-node one.

## Shape

**ONE complete feature in one PR.** Any "M0/M1/…" below are build-order *within* that
single PR (foundation before consumers, A7), not separate releases. It is independently
shippable and reviewable: it improves search on its own and does not depend on the
memory plan (the two are siblings; this one can land first, last, or alone).

**Lane: plan-track (significant), not fast-track.** It touches the shared ranking
chokepoint (`searchEngine.ts` — protocol-adjacent), adds a **net-new cross-process
recording lane** (IPC channel + preload + main handler + renderer emission, §5), and
spans core + main + preload + renderer. None of that is a low-blast-radius drive-by; it
goes through the full plan flow with this file as the contract.

## Non-goals

- **Not in Loro.** Access stats are per-user behavioral telemetry, not collaborative
  document content. Putting them in the CRDT would bloat it and cause churn/conflict.
  They live in a userData side store (substrate chosen in §2 — *not* the event-sourced
  shape memory uses).
- **No broad multi-signal blend in v1.** The primary signal is human **open/focus**,
  plus an optional **low-weight agent-recall** signal (see Relationship) so memory recall
  self-reinforces. Not a tuned blend of open/edit/bare-search-hit — edits and mere result
  appearance stay excluded (Design §1).
- **Not memory's source-association ranking.** That "co-cited memories boost each other"
  behavior needs the source refs from the memory plan and stays out of scope here.
- **No UI that surfaces access counts.** The stat is a ranking input, not a displayed
  number — at least in v1.
- **No change to explicit-sort behavior.** A search with an explicit
  `sys:createdAt`/`sys:updatedAt` sort rule still overrides score (and therefore the
  access multiplier), exactly as today.
- **No back-compat / migration.** Pre-release: the side store is new; a dev-data wipe
  just empties it. Stats are not exported.

## Background — what exists today

- **One ranking chokepoint.** All keyword search — the agent's `node_search`
  (`agentNodeToolSearch.ts:253` → `runSearch`) **and** the app's own saved/search nodes
  — funnels through `runSearchExpr` → `sortSearchHits` (`searchEngine.ts:254`).
  `sortSearchHits` is a **pure** function over the `SearchIndex`: default order is by
  BM25 `score` (`textSearchIndex.ts`), and an explicit `sys:createdAt/updatedAt` sort
  rule overrides. It has **no clock and no access data** — so there is no recency or
  frequency dimension anywhere in node search.
- **Nodes carry no access tracking.** `NodeBase` has `createdAt`/`updatedAt` but no
  notion of "opened N times, last at T." A repo-wide search finds per-node access state
  *only* inside the memory activation engine (`agentMemoryActivation.ts`), nowhere on
  nodes. So this is genuinely net-new, not a reuse.
- **The decay model already exists (memory-only).** `computeMemoryStrength`
  (`agentMemoryActivation.ts:127`) computes a `retrievalStrength` from
  `decay(lastAccessedAt, now, halfLife) * (base + log1p(count))`, and `recall` already
  multiplies BM25 by it (`agentMemoryRetrieval.ts:74` `lexicalScore * strengthMultiplier`).
  This plan generalizes that one channel to all nodes. (Memory's model has *two*
  channels — weak passive "briefing" + strong deliberate "recall"; general nodes have
  no briefing, so we use a single channel.)

## Design

### 1. The "use" signal — open/focus only (v1)

A node counts as **used when it is opened/focused in a view**. Rationale for the
single-signal choice:

- **Open/focus = deliberate retrieval** — the clean analogue of memory's strong "recall"
  channel. This is the signal we want.
- **Edit ≠ retrieval.** Editing is authoring; a node you're writing isn't one you're
  "finding." Excluded in v1 (it would reward churn, not relevance).
- **Search-hit-without-open is too weak/noisy** (a node merely *appearing* in results
  shouldn't inflate its own future rank — a feedback loop). Excluded in v1.

Record per `NodeId`: `{ accessCount, lastAccessedAt }`. **Open question (§ below):**
whether the agent's own `node_read` counts as a use — default v1 is **no** (bulk agent
reads would skew everyday ranking); revisit once the signal is observed.

### 2. Storage — a per-node access-stats side store (off Loro)

Keyed by `NodeId`, in userData, persisted across restarts; emptied by a dev-data wipe;
not exported. **The substrate is a real decision, and the memory analogy is misleading
about it** — `AgentMemoryAccessStats` is *not* a flat map; it is a **projection over an
`AppendOnlySeqLog`** (`agentEventStore.ts:329`, `memoryEventLog`/`memoryProjectionBy…`),
i.e. memory access is event-sourced and the `{count, lastAt}` is derived. So this plan
must **pick** (this is the heaviest single decision here):

- **(a) Reuse the `AppendOnlySeqLog` primitive** — append access *events*, project to
  `{count, lastAccessedAt}`. Pro: durable, ordered, crash-tolerant, consistent with how
  the rest of agent data persists. Con: heavier; a high-churn event for a low-stakes
  telemetry signal.
- **(b) A simple flat JSON map** `NodeId → {count, lastAccessedAt}`, debounced-written.
  Pro: trivial; matches the low stakes (a lost/garbled stat just degrades ranking,
  never correctness). Con: must handle its own atomic write / corruption tolerance.

**Recommendation: (b)** for v1 — node access ranking is best-effort telemetry that can
tolerate loss and needs no ordered history, so the seq-log's durability machinery is
overkill. (a) stays the fallback if we later want an auditable access history. Either
way it is **off Loro**.

**Dangling stats are harmless.** A deleted node's leftover stats are simply never read
(ranking only consults stats for nodes that are search hits). Optional lazy prune; no
hard coupling to deletion.

### 3. Decay model — port the single-channel strength

A pure function `computeNodeAccessStrength(stats, now)` ported from
`computeMemoryStrength`, one channel:

```
strength = decay(lastAccessedAt, now, HALF_LIFE_DAYS) * (BASE + log1p(accessCount))
```

Start from the memory **recall** channel's constants (half-life 45d) as a starting
point and tune by feel (§ Open questions). The function is pure in `(stats, now)` —
`now` is injected, never read ambiently — so it is deterministic and unit-testable, the
same discipline the memory tests use.

### 4. Integration — one multiplier at the chokepoint

Thread an **optional** `accessStats` map + `now` through `runSearchExpr`'s options into
`sortSearchHits` (`searchEngine.ts:254`). When present, multiply each hit's BM25 score:

```
rankScore = hit.score * (1 + min(CAP, computeNodeAccessStrength(stats[hit.nodeId], now)) * WEIGHT)
```

— exactly the shape `recall` already uses. Then:

- **Default sort** becomes `rankScore` desc (relevance × access strength).
- **Explicit `sys:createdAt/updatedAt` sort still overrides** — unchanged; the
  multiplier only reorders the relevance-sorted default.
- **Stats absent (`undefined`)** → behaves exactly as today (pure relevance). This keeps
  `sortSearchHits` pure and back-compatible, and lets call sites opt in.

### 5. Recording plumbing — net-new cross-process surface (not a mirror of anything)

This is the part with no existing rail to copy, and the reason this plan is plan-track
(see Shape). The renderer's open/focus signal does **not** reach main today: the only
access-recorder, `recordMemoryAccess` (`agentEventStore.ts:999`), is **main-internal**
— called by recall/briefing inside the backend, with **zero IPC/preload references**.
So routing renderer open/focus → main is a **full new lane**, built end to end:

- a new **IPC channel** (`recordNodeAccess`) + its **preload bridge** (A2: the only
  contextIsolation-safe path) + a **main handler** that writes the §2 store;
- **renderer emission** on a node open/focus, **debounced** so rapid re-focus of the
  same node coalesces to one access (idle focus churn must not inflate counts);
- the exact UI event boundary (what counts as "open/focus") settled in the PR; the
  contract is "one deliberate landing on a node = one access."

### 6. Both search surfaces benefit

Because the agent's `node_search` and the app's saved/search nodes share
`sortSearchHits`, both inherit the ranking once the call sites pass `accessStats`+`now`.
The PR wires both. (The agent path already constructs a `TextSearchIndex`; the stats map
is an additional argument alongside it.)

## Open questions

- **Does agent `node_read` count as a use?** Default v1: **no** (avoid bulk-read skew).
  Reconsider after observing real ranking behavior — agent retrieval *is* retrieval, so
  a low weight may be right later.
- **Constants** (`HALF_LIFE_DAYS`, `BASE`, `WEIGHT`, `CAP`): start from the memory recall
  channel, tune by feel. No empirical fit attempted in v1.
- **Throttle window** for repeated focus (e.g. coalesce within N seconds).
- **Decay half-life vs. an outliner's access cadence** — memory's 45-day recall half-life
  was tuned for sparse deliberate recalls; everyday node visits are more frequent, so the
  half-life may want to be shorter. Tune.

## Relationship to `agent-memory-on-timeline`

Independent and complementary. The memory plan ships pull-only recall over nodes
(relevance order only); this plan, whenever it lands, gives *all* node search — memory
nodes included — the recency/access dimension. Neither blocks the other. What this plan
does **not** restore is memory's source-association ranking (that lives in the memory
plan's source refs).

**Coupling caveat — the v1 signal does not reinforce agent recall.** The §1 signal is
**human open/focus**. But the memory plan's recall is a *pull* `node_search` (the agent
queries; it does not open/focus the node), so a belief the **agent** keeps recalling is
**not** strengthened by those recalls under the v1 signal — only beliefs the **human**
visits are. So the memory plan's "recall inherits decay for free" holds for human-touched
memory nodes, not agent-only ones. To close that gap, v1 **optionally records a
low-weight agent-recall signal**: when a node is returned-and-used in an agent
`node_search`/recall, bump its stat with a small weight (well below human open/focus, to
avoid the search-hit feedback loop §1 warns about). Recommended to include, since it is
the difference between memory recall self-reinforcing or not; `agent-memory-on-timeline`
§4 carries the matching caveat. (This subsumes the "does agent `node_read` count" open
question below for the *recall* path specifically.)

## Build order (within the one PR) — each milestone green first

- [ ] **M0:** the access-stats side store on the §2-chosen substrate (per-`NodeId`
      read/write in userData) + the pure `computeNodeAccessStrength(stats, now)` (ported
      from `agentMemoryActivation`). (Tests: decay math with injected `now`; empty-stats
      neutral; substrate round-trips + tolerates a torn/garbled record.)
- [ ] **M1 (shared-surface, interface-first):** thread optional `accessStats`+`now`
      through `runSearchExpr` → `sortSearchHits`; apply the multiplier; preserve the
      explicit-sort override and the stats-absent default. (Tests: ranking shifts with
      stats; `sys:createdAt` sort still wins; identical to today when stats absent;
      deterministic with injected `now`.)
- [ ] **M2 (net-new cross-process lane):** the `recordNodeAccess` IPC channel + preload
      bridge + main handler (§5) + debounced renderer open/focus emission. (Tests: a focus
      records one access; a burst coalesces to one; the preload surface is the only path.)
- [ ] **M3:** pass `accessStats`+`now` at both call sites — agent `node_search` and the
      app's search nodes; plus the optional **low-weight agent-recall** bump (Relationship
      caveat). (Tests: both surfaces reflect access ranking; an agent recall bumps the
      node's stat below a human open/focus.)
- [ ] **M4:** fold the behavior into the relevant `docs/spec/` search doc (A6).
