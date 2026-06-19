# Node search access ranking

## Goal

Improve node search ranking without mixing three different concepts:

- **Query rules** decide which nodes match.
- **Search-node sort modes** decide a saved search node's reproducible document order.
- **Personal access ranking** is a per-user, off-document boost for transient retrieval.

The user-facing outcome is still the same: nodes that are important in practice should
surface earlier. The cleaned-up design is narrower:

- Add a stable **document authority** signal based on inbound reference count. This is
  derived from the document, so it is safe for saved search nodes and can be exposed as a
  search-node sort mode.
- Add a per-user **access-stats side store** for recent/frequent human openings and a
  low-weight agent-recall channel. This is personal telemetry, so it is never written into
  Loro and never appears as a search-node query rule or persisted sort field.
- Fold both signals through the shared search-ranking path, with callers explicitly
  choosing whether personal access ranking is allowed.

The decay shape is not invented here. It ports the proven retrieval-strength idea already
shipping in `src/core/agentMemoryActivation.ts` (`computeMemoryStrength`) from a
memory-only engine to a general node-ranking signal.

## Shape

**ONE complete feature in one PR.** Any "M0/M1/..." below are build-order within that
single PR (foundation before consumers, A7), not separate releases. The PR is
independently shippable: reference-aware search ranking improves ordinary search on its
own, and personal access ranking improves launcher/agent retrieval without depending on
the node-memory plan.

**Lane: plan-track (significant), not fast-track.** It touches the shared ranking
chokepoint (`searchEngine.ts`), extends search-node sort semantics, adds a per-user
side store, and adds a cross-process access-recording lane across IPC, preload, main,
and renderer. That is a coordinated core/main/preload/renderer change.

## Non-goals

- **No access/frequency query rule.** Usage frequency is not a predicate and must not
  appear in `SearchQueryExpr`, search-node outline rules, or agent `node_search` query
  syntax.
- **No persisted access sort mode.** Personal access stats are not collaborative document
  content. They do not become `sortField: "sys:accessedAt"` or similar.
- **No personal ranking in materialized saved-search children.** Saved search nodes write
  reference children into Loro. Their materialized order must be reproducible from document
  state alone, not from one user's private access history.
- **No broad multi-signal blend in v1.** Edits and bare search-result appearances stay
  excluded. Search-hit-without-open is especially excluded to avoid self-reinforcing
  feedback loops.
- **Not memory's source-association ranking.** Co-cited/source-associated memory ranking
  needs source refs from `agent-memory-on-timeline` and stays out of scope here.
- **No UI that surfaces access counts.** Counts are ranking inputs, not displayed numbers.
- **No back-compat / migration.** Pre-release: the side store is new; a dev-data wipe
  just empties it. Stats are not exported.

## Background - what exists today

- **One ranking chokepoint.** Keyword search funnels through `runSearchExpr` ->
  `sortSearchHits` (`src/core/searchEngine.ts`). Default order is BM25-like score from
  the text index; explicit `sys:createdAt` / `sys:updatedAt` sort overrides relevance.
- **Search-node rules and sort are already separate.** `SearchQueryExpr` is the filter
  tree. `sortRule` nodes carry `sortField` / `sortDirection`. This plan keeps that
  separation: access is not a rule, and document-derived ranking can be a sort mode.
- **Saved search materialization writes document content.** Search node refresh turns hits
  into reference children. Therefore any ranking used there must be deterministic from
  document state.
- **Inbound references are document authority.** A node that many other nodes reference is
  often more important than one with identical lexical relevance and no references. Unlike
  personal access stats, reference count is collaborative document state and safe to use in
  saved search order.
- **Nodes carry no access tracking.** `NodeBase` has `createdAt` / `updatedAt` but no
  "opened N times, last at T." Existing access tracking only exists in the memory engine,
  and it is memory-specific.

## Design

### 1. Ranking contract - rules, modes, and personalization

Keep the layers explicit:

- Query rules answer **"does this node match?"**
- Search-node sort modes answer **"what reproducible order should this saved search use?"**
- Personal access ranking answers **"should this transient retrieval be personalized for
  this user right now?"**

The search engine exposes one ranking path, but callers pass an explicit ranking context:

```ts
interface SearchRankingOptions {
  now?: number;
  personalAccessStats?: ReadonlyMap<NodeId, NodeAccessStats>;
  personalAccess?: boolean;
}
```

`personalAccess` defaults to false. Passing stats without opting in should not silently
personalize a saved search.

### 2. Search-node sort modes

Search-node sort modes stay document-derived and reproducible:

- **Default relevance**: lexical relevance plus a mild reference-authority boost.
- **`sys:createdAt` / `sys:updatedAt`**: existing explicit time sorts. They stay primary,
  with relevance as a tie-breaker.
- **`sys:referenceCount`**: a new explicit sort mode for "most referenced" / "least
  referenced" search nodes. This is the durable counterpart to the user's intuition that
  inbound references may be more important than access frequency for saved searches.

There is deliberately no `sys:accessCount`, `sys:lastAccessedAt`, or "frequently used"
saved-search sort mode in v1.

### 3. Document authority - inbound reference count

Compute an inbound reference count per target node from the current search index:

- Count user-visible references whose target is the candidate node: tree references,
  inline node references, and reference field values.
- Ignore trashed/deleted sources and hidden/system metadata references.
- Count distinct source nodes, not repeated identical mentions in the same source node, so
  one noisy node cannot dominate authority.

Use a capped/log-shaped boost so authority improves ranking without overriding strong
lexical intent:

```ts
authorityBoost = min(REFERENCE_AUTHORITY_CAP, log1p(inboundReferenceCount)) * REFERENCE_AUTHORITY_WEIGHT
documentRankScore = lexicalScore * (1 + authorityBoost)
```

For explicit `sys:referenceCount`, the count is primary and relevance is the tie-breaker.
For default relevance, reference authority is a mild multiplier.

### 4. Personal access signals

Personal access is only for transient retrieval surfaces that explicitly opt in.

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
coalesces into one access. The exact window is a PR constant, but the contract is:
one deliberate landing on a node equals at most one human access.

Agent recall is a separate low-weight channel:

- Count only nodes actually returned to the model as `node_search` items.
- Do not count `count: true` calls.
- Do not count all candidates or all hits beyond the returned page.
- Do not count `node_read` in v1; bulk reads would skew ranking.

### 5. Storage - per-node access side store (off Loro)

Use a flat JSON side store under `userData`, persisted across restarts and emptied by a
dev-data wipe. It is best-effort telemetry: a lost/corrupt stat degrades ranking but never
document correctness.

Recommended v1 shape:

```ts
interface NodeAccessChannelStats {
  count: number;
  lastAccessedAt: number | null;
}

interface NodeAccessStats {
  human?: NodeAccessChannelStats;
  agentRecall?: NodeAccessChannelStats;
}
```

Keep human and agent channels separate. A low-weight agent recall must not refresh the
same `lastAccessedAt` used for human retrieval strength; otherwise "low weight" becomes
misleading because the recency component is still strong.

Use the existing atomic JSON helpers for writes, add debouncing in the store, and tolerate
missing/garbled files by falling back to an empty map. Dangling stats for deleted nodes are
harmless because ranking only consults stats for current hits; lazy prune is optional.

### 6. Personal decay model

Add a pure `computeNodeAccessStrength(stats, now)` with injected time:

```ts
humanStrength =
  decay(human.lastAccessedAt, now, HUMAN_HALF_LIFE_DAYS)
  * (HUMAN_BASE + log1p(human.count) * HUMAN_COUNT_WEIGHT)

agentRecallStrength =
  decay(agentRecall.lastAccessedAt, now, AGENT_RECALL_HALF_LIFE_DAYS)
  * (AGENT_RECALL_BASE + log1p(agentRecall.count) * AGENT_RECALL_COUNT_WEIGHT)

strength = humanStrength + agentRecallStrength
```

Agent recall constants must stay well below human constants. Start from the memory recall
half-life as a reference point, but tune by feel for everyday outline usage.

When personalization is enabled:

```ts
personalBoost = min(PERSONAL_ACCESS_CAP, computeNodeAccessStrength(stats, now)) * PERSONAL_ACCESS_WEIGHT
rankScore = documentRankScore * (1 + personalBoost)
```

Stats absent, `personalAccess: false`, or no stat for a hit means the hit behaves exactly
as document relevance would.

### 7. Integration - one ranking chokepoint, explicit caller policy

Thread optional ranking context through `runSearchExpr` -> `sortSearchHits`.

Behavior matrix:

| Surface | Reference authority | Personal access |
|---|---:|---:|
| Saved search node materialization | yes | no |
| App/launcher transient node search | yes | yes |
| Agent `node_search` result ordering | yes | yes |
| Explicit `sys:createdAt` / `sys:updatedAt` sort | tie-break only | no |
| Explicit `sys:referenceCount` sort | primary | no |

This keeps the core simple: one pure ranking function, with deterministic document signals
always available and personal signals included only by opt-in call sites.

### 8. Recording plumbing

The renderer's deliberate access signal does not reach main today, so this needs a new
cross-process lane:

- new IPC channel and preload bridge for `recordNodeAccess`;
- main handler validates the node still exists and writes the side store;
- renderer emits only after deliberate navigation/open boundaries, not on generic row
  focus churn;
- agent `node_search` records low-weight `agentRecall` after it knows which items were
  actually returned to the model.

The preload bridge remains the only renderer-to-main path (A2).

## Relationship to `agent-memory-on-timeline`

Independent and complementary. The memory-on-nodes plan uses `node_search` for pull-only
recall. With this plan:

- memory nodes inherit stable reference-aware relevance like every other node;
- agent-returned memory search results can self-reinforce through the low-weight
  `agentRecall` channel;
- human-opened memory nodes reinforce through the stronger `human` channel.

This still does not restore memory source-association ranking. Source association belongs
to the memory plan's source refs, not this generic search-ranking layer.

## Open questions

- Exact constants for reference authority weight/cap and personal access half-lives.
- Exact dwell/debounce window for "deliberate landing".
- Whether `sys:referenceCount` should be exposed in the search-toolbar field picker in the
  same PR or only supported by the engine/parser first. The engine behavior is in scope;
  the UI exposure should follow the existing sort-field UI surface if it already has one.
- Exact definition of user-visible reference sources if existing reference-summary helpers
  already include more than we want.

## Build order (within the one PR) - each milestone green first

- [ ] **M0:** pure ranking helpers: inbound reference count/authority scoring plus
      channel-separated `computeNodeAccessStrength(stats, now)`. Tests cover empty stats,
      human vs low-weight agent recall, cap/decay determinism, and reference-count
      tie-breaks.
- [ ] **M1:** thread ranking options through `runSearchExpr` -> `sortSearchHits`; add
      default reference-authority relevance and explicit `sys:referenceCount` sort; prove
      `sys:createdAt` / `sys:updatedAt` still override and stats-absent/personal-off
      behavior is deterministic.
- [ ] **M2:** implement the userData JSON access-stats store with debounced atomic writes,
      channel-separated records, and corrupt/missing-file fallback to empty.
- [ ] **M3:** add `recordNodeAccess` IPC + preload bridge + main handler and renderer
      deliberate-landing emission. Tests cover one access per landing and burst
      coalescing.
- [ ] **M4:** opt in transient call sites: launcher/app node search and agent
      `node_search`; keep saved-search materialization personal-access-free. Agent tests
      cover returned-page-only `agentRecall` and no bump for `count: true`.
- [ ] **M5:** fold the final behavior into `docs/spec/search-query-grammar.md`,
      `docs/spec/launcher.md`, and the agent tool spec as appropriate (A6).
