# Node search access ranking

## Goal

Make **frequently and recently used nodes rank higher in transient retrieval** by
giving node search an explicit, per-user recency/access-decay dimension. Concretely:
a per-node **access-stats side store** + a **decay-based score multiplier** folded into
the single search-ranking chokepoint (`sortSearchHits`) when a caller explicitly opts in.

Two payoffs, either of which justifies the ratified personal-access work:

- **Everyday quick retrieval gets better.** "The node I keep coming back to surfaces
  first" is how people expect quick-open / launcher / temporary search to behave; pure
  lexical relevance doesn't do that.
- **It is the generic mechanism the node-based memory plan needs.** When memory becomes
  ordinary nodes (`agent-memory-on-timeline`), recall is `node_search`, which returns
  *relevance order only*. The memory plan's pull-only reading therefore loses the
  recency/access ranking that the (removed) memory activation engine provided. This
  plan restores it **generically for transient retrieval**, so memory-on-nodes inherits
  it without memory-specific ranking code.

The decay model is **not invented here** — it is the proven retrieval-strength shape
already approximated in `src/core/agentMemoryActivation.ts` (`computeMemoryStrength`),
but represented here as a single weighted, time-decayed accumulator so weak accesses
stay weak.

## Shape

**SET of independent complete features, each its own PR.** The reviewed design now has
two independently shippable features, so it uses the repo's shape (b), not one bundled
implementation PR:

- **PR A — personal-access ranking (ratified #303 scope).** Off-Loro access telemetry,
  explicit `personalAccess` opt-in, transient-only ranking, and the cross-process
  recording lane.
- **PR B — reference-authority ranking.** A document-derived inbound-reference signal:
  a `sys:referenceCount` sort mode **and** a capped reference-authority boost folded into
  default relevance. A scope expansion beyond #303, ratified separately by the PM (both
  axes) — see the board for status.

This plan keeps both designs in one file because they touch the same search-ranking
chokepoint and the boundary between them is the point of the revision. The build units
remain separate complete PRs.

**Lane: plan-track (significant), not fast-track.** PR A touches the shared ranking
chokepoint (`searchEngine.ts`), adds a per-user side store, and adds a cross-process
recording lane (IPC channel + preload + main handler + renderer emission). PR B, if
ratified, extends search-node sort semantics and document-derived ranking. Neither is a
low-blast-radius drive-by.

## Non-goals

- **No access/frequency query rule.** Usage frequency is not a predicate and must not
  appear in `SearchQueryExpr`, search-node outline rules, or agent `node_search` query
  syntax.
- **No persisted access sort mode.** Personal access stats are per-user behavioral
  telemetry, not collaborative document content. They do not become
  `sortField: "sys:accessCount"`, `sortField: "sys:lastAccessedAt"`, or similar.
- **No personal ranking in materialized saved-search children.** Saved search nodes
  materialize hits into Loro reference children, so their order must be reproducible from
  document state alone. Personal access ranking is not allowed in that path.
- **Not in Loro.** Access stats live in a userData side store. They are not exported and
  do not participate in collaboration, undo, or document serialization.
- **No broad multi-signal blend in v1.** The primary signal is human deliberate landing,
  plus a low-weight agent-recall access so memory recall can self-reinforce. Edits and
  mere result appearance stay excluded.
- **Not memory's source-association ranking.** That "co-cited memories boost each other"
  behavior needs the source refs from the memory plan and stays out of scope here.
- **No UI that surfaces access counts.** The stat is a ranking input, not a displayed
  number.
- **No back-compat / migration.** Pre-release: the side store is new; a dev-data wipe
  just empties it.

## Background — what exists today

- **One ranking chokepoint.** Keyword search — the agent's `node_search`
  (`agentNodeToolSearch.ts:253` → `runSearch`), launcher/app node retrieval, and saved
  search-node materialization — funnels through `runSearchExpr` → `sortSearchHits`
  (`searchEngine.ts:254`).
- **Default relevance is pure document search.** `sortSearchHits` is a pure function over
  the `SearchIndex`: default order is by BM25-like `score` (`textSearchIndex.ts`), and an
  explicit `sys:createdAt` / `sys:updatedAt` sort rule overrides. It has no clock and no
  access data.
- **Saved search nodes write document content.** A saved search refresh materializes hits
  into reference children. This is the hole #303 missed: personalizing that order would
  write one user's private behavior into Loro.
- **Nodes carry no access tracking.** `NodeBase` has `createdAt` / `updatedAt` but no
  notion of "retrieved with weighted strength." Existing access state only exists inside
  the memory activation engine, nowhere on nodes.

## Design — PR A: personal-access ranking

### 1. Ranking contract — explicit opt-in only

Thread an optional ranking context through `runSearchExpr` → `sortSearchHits`:

```ts
interface SearchRankingOptions {
  now?: number;
  personalAccess?: boolean;
  personalAccessStats?: ReadonlyMap<NodeId, NodeAccessStats>;
}
```

`personalAccess` defaults to false. Passing stats without opting in must not silently
personalize a saved search. The behavior matrix for PR A:

| Surface | Personal access |
|---|---:|
| Saved search node materialization | no |
| App/launcher transient node search | yes |
| Agent `node_search` result ordering | yes |
| Explicit `sys:createdAt` / `sys:updatedAt` sort | no |

This keeps the core simple: one pure ranking function, with personal signals included
only by opt-in call sites.

### 2. The access signal — deliberate landing only

Human access counts when the user deliberately lands on a node:

- opening a launcher node result after the main renderer navigates/focuses it;
- opening or switching a panel/root to a node;
- explicit jump-to-node flows such as command palette/reference navigation.

Do **not** count:

- a node merely appearing in search results;
- hover;
- ordinary edit churn;
- rapid keyboard selection/focus churn while moving through rows.

Renderer emission must be debounced/dwell-filtered so rapid refocus of the same node
coalesces into one access. The exact window is a PR constant; the contract is "one
deliberate landing on a node = at most one human access."

Agent recall is a weak access source:

- count only nodes actually returned to the model as `node_search` items;
- do not count `count: true` calls;
- do not count all candidates or all hits beyond the returned page;
- do not count `node_read` in v1, because bulk reads would skew ranking.

### 3. Storage — weighted accumulator side store (off Loro)

Use a flat JSON side store under `userData`, persisted across restarts and emptied by a
dev-data wipe. It is best-effort telemetry: a lost/corrupt stat degrades ranking but never
document correctness.

Use one weighted, time-decayed accumulator per node:

```ts
interface NodeAccessStats {
  s: number;
  tUpdate: number | null;
}
```

On access:

```ts
s = s * 2 ** (-(now - tUpdate) / HALF_LIFE_MS) + ACCESS_WEIGHT[source];
tUpdate = now;
```

Current strength:

```ts
strength = s * 2 ** (-(now - tUpdate) / HALF_LIFE_MS);
```

Initial source weights:

```ts
ACCESS_WEIGHT = {
  human: 1,
  agentRecall: 0.15,
};
```

This fixes the root issue with `{count, lastAccessedAt}`: a weak agent recall only nudges
the accumulator weakly; it does not overwrite recency with a full-strength last-touch.
The persisted schema also generalizes to future access sources by adding a weight-table
entry, not a new stored bucket.

Use the existing atomic JSON helpers for writes, add debouncing in the store, and tolerate
missing/garbled files by falling back to an empty map. Dangling stats for deleted nodes
are harmless because ranking only consults stats for current hits; lazy prune is optional.

### 4. Decay model and multiplier

Add a pure `computeNodeAccessStrength(stats, now)` with injected time. It uses one
half-life and the accumulator above:

```ts
strength = decayed(stats.s, stats.tUpdate, now, HALF_LIFE_MS);
personalBoost = min(PERSONAL_ACCESS_CAP, strength) * PERSONAL_ACCESS_WEIGHT;
rankScore = hit.score * (1 + personalBoost);
```

Start from the memory recall half-life as a reference point, but tune for everyday
outline access cadence. In PR A, source types differ by weight, not by half-life; there
is no current product reason for agent recall to decay faster or slower than a human open.

Stats absent, `personalAccess: false`, or no stat for a hit means the hit behaves exactly
as today's relevance sort. Explicit `sys:createdAt` / `sys:updatedAt` sort remains primary
and does not use personal access.

### 5. Recording plumbing

The renderer's deliberate access signal does not reach main today, so PR A needs a new
cross-process lane:

- a new IPC channel (`recordNodeAccess`) + preload bridge + main handler;
- the main handler validates that the node still exists and writes the side store;
- renderer emission on deliberate navigation/open boundaries, not generic row focus churn;
- agent `node_search` records low-weight `agentRecall` after it knows which items were
  actually returned to the model.

The preload bridge remains the only renderer-to-main path (A2).

## Design — PR B: reference-authority ranking

A scope expansion beyond #303, ratified separately by the PM. It answers the same design
question — "what ranking signals are clean?" — but is a distinct, independently shippable
feature from PR A.

### 1. Motivation

Inbound reference count is a document-derived authority signal. A node that many other
nodes reference is often more important than one with identical lexical relevance and no
references. Unlike personal access stats, reference count is collaborative document state
and can safely affect saved search ordering.

### 2. Behavior

PR B adds **both** axes:

- **`sys:referenceCount`** as an explicit search-node sort mode for "most referenced" /
  "least referenced" saved searches.
- A conservative, **capped** reference-authority boost folded into default relevance
  (changes default order for all users — verify light+dark/behavior).

Possible scoring shape:

```ts
authorityBoost = min(REFERENCE_AUTHORITY_CAP, log1p(inboundReferenceCount)) * REFERENCE_AUTHORITY_WEIGHT;
documentRankScore = lexicalScore * (1 + authorityBoost);
```

For explicit `sys:referenceCount`, the count is primary and relevance is the tie-breaker.

### 3. Reference counting boundary

Compute inbound reference count from current document state:

- count user-visible references whose target is the candidate node: tree references,
  inline node references, and reference field values;
- ignore trashed/deleted sources and hidden/system metadata references;
- count distinct source nodes, not repeated identical mentions in the same source node.

The exact definition of "user-visible reference source" should use existing
reference-summary helpers where possible, but the PR must verify the helper does not count
metadata references that should stay out of authority.

## Relationship to `agent-memory-on-timeline`

Independent and complementary. The memory-on-nodes plan uses `node_search` for pull-only
recall. With PR A:

- agent-returned memory search results can self-reinforce through weak `agentRecall`
  accesses;
- human-opened memory nodes reinforce through stronger human accesses;
- saved search materialization stays document-deterministic and does not leak personal
  access into Loro.

PR B, if ratified, would additionally let memory nodes benefit from document-derived
reference authority like every other node. Neither PR restores memory source-association
ranking; source association belongs to the memory plan's source refs.

## Open questions

- PR A constants: `HALF_LIFE_MS`, `PERSONAL_ACCESS_WEIGHT`, `PERSONAL_ACCESS_CAP`, and
  initial `agentRecall` weight.
- PR A dwell/debounce window for "deliberate landing."
- PR B constants: `REFERENCE_AUTHORITY_CAP` / `REFERENCE_AUTHORITY_WEIGHT` (kept
  conservative so default order shifts mildly, never overriding strong lexical intent).
- PR B UI exposure: whether `sys:referenceCount` should appear in the search-toolbar
  field picker in the same PR, or only be supported by engine/parser first.

## Build order — independent complete PRs

### PR A — personal-access ranking (ratified #303 scope)

- [ ] **A0:** implement weighted accumulator helpers and pure
      `computeNodeAccessStrength(stats, now)`. Tests cover empty stats, weak
      `agentRecall`, decay determinism, cap/weight behavior, and injected `now`.
- [ ] **A1:** thread optional ranking context through `runSearchExpr` → `sortSearchHits`;
      apply the personal multiplier only when `personalAccess: true`; preserve
      stats-absent behavior and explicit `sys:createdAt` / `sys:updatedAt` sort.
- [ ] **A2:** implement the userData JSON access-stats store with debounced atomic writes
      and corrupt/missing-file fallback to empty.
- [ ] **A3:** add `recordNodeAccess` IPC + preload bridge + main handler and renderer
      deliberate-landing emission. Tests cover one access per landing and burst
      coalescing.
- [ ] **A4:** opt in transient call sites: launcher/app node search and agent
      `node_search`; keep saved-search materialization personal-access-free. Agent tests
      cover returned-page-only `agentRecall` and no bump for `count: true`.
- [ ] **A5:** fold PR A behavior into `docs/spec/search-query-grammar.md`,
      `docs/spec/launcher.md`, and the agent tool spec as appropriate (A6).

### PR B — reference-authority ranking

- [ ] **B0:** define inbound reference-count helpers and tests for source boundaries
      (distinct sources, ignore trashed/metadata refs).
- [ ] **B1:** add the explicit `sys:referenceCount` sort mode; preserve existing
      created/updated sort behavior.
- [ ] **B2:** add the capped default reference-authority boost; tests must prove it is
      capped and does not override strong lexical relevance.
- [ ] **B3:** update specs and the UI/parser surfaces for the new sort field (A6).
