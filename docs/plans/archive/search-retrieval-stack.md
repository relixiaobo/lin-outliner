---
status: done
priority: P1
owner: codex
created: 2026-06-04
updated: 2026-06-04
---

> **Closed 2026-06-04 (PR #111).** Phases 1–4 shipped; their design lives in
> `docs/spec/search-query-grammar.md`, `docs/spec/agent-tool-design.md`, and
> `docs/spec/agent-event-log-rendering.md`. Phase 5 is closed by PM decision:
> 5a (capture-payload search) is dropped because the `CapturePayloadRef.searchPolicy`
> contract it depended on was removed in PR #103 (capture nodes are now plain
> indexed nodes); 5b (persisted index / WAND-block-max / SQLite-FTS / embeddings)
> is **shelved**, not done — re-open only when a probe against a real workspace
> trips one of the documented triggers (see Phase 5 below).

# Search Retrieval Stack

## Goal

Define the follow-up implementation path after `text-search-relevance-layer`:
one shared, accurate, fast, clean retrieval stack for Tenon's repeated text
search and ranking scenarios.

The immediate foundation is the node text relevance implementation in PR #102.
This plan decides what should reuse that foundation, what should stay separate,
and which implementation order keeps the system simple instead of creating many
small local rankers.

Requirements:

- **Accurate:** candidate generation may be broad, but domain-specific
  verification remains the final authority. Node search must still execute the
  structured search truth table.
- **Fast:** common positive text queries should use indexed candidates instead
  of all-node scoring. Broad queries and large corpora must be measured before
  adding heavier algorithms.
- **Clean:** document state, agent event logs, filesystem, and web results keep
  their own sources of truth. Retrieval indexes are derived, disposable, and
  rebuildable.
- **Simple:** pure TypeScript primitives first. No SQLite, native dependency,
  embedding store, or model reranker until measured product usage justifies it.
- **Elegant:** one analyzer/ranking vocabulary, small domain adapters, and no
  duplicate scoring rules across core, main, renderer, launcher, and agent
  tools.

## Non-goals

- No change to `SearchQueryExpr`, saved-search outline syntax, or `node_search`
  tool parameters in this follow-up.
- No replacement of `file_grep` / `file_glob` with a Tenon text index. File
  content search should keep using ripgrep.
- No web search indexing. `web_search` remains an external/current-information
  adapter.
- No renderer-wide search rewrite in the first implementation. Small UI pickers
  can reuse tiny ranking helpers, but they should not import a heavy full-text
  index.
- No persisted index, SQLite/FTS5, WAND/block-max pruning, embeddings, or model
  reranking in the first follow-up unless probes show that the shipped TypeScript
  path misses target latency.

## Current Search Surfaces

Tenon already has several text search shapes:

| Surface | Current behavior | Retrieval decision |
|---|---|---|
| Saved search / `search_nodes` command | `src/core/searchEngine.ts` evaluates structured `SearchQueryExpr`. PR #102 adds a derived text index for `STRING_MATCH` candidate generation and indexed scoring while keeping evaluator-backed correctness. The implementer must verify the merged #102 state before claiming legacy substring scoring is gone; evaluator fallback code may still exist for non-indexed paths. | This is the primary indexed node retrieval surface. Keep it authoritative for node search semantics. |
| Agent `node_search` tool | `src/main/agentNodeToolSearch.ts` parses temporary/saved search outlines, calls `runSearchExpr`, then builds agent-visible items/snippets. `src/main/agentNodeToolProjection.ts` may still carry duplicate substring-weight scoring after #102. | Must benefit from the node retrieval index through the same `runSearchExpr` path. It should not own a separate ranker, and duplicated agent presentation scoring should be removed or routed through shared primitives in Phase 2. |
| In-app `CommandPalette` node lookup | Renderer calls `api.searchNodes(query)`, so it uses the same command surface as saved search keyword lookup. | Reuse node retrieval. UI-specific create/navigation rows can have separate ordering around the retrieved hits. |
| Lazy-like launcher node search / destination search | PR #103 adds launcher search and destination flows. Its plan explicitly references "Search notes" and "Search existing node by query". | Reuse node retrieval from main. The launcher may add surface-local command recency boosts, but node result relevance should come from the shared node path. |
| Reference, tag, field, option, slash-command pickers | Renderer helpers already include `src/renderer/ui/interactions/candidateRanking.ts`, which exports `textMatchRank` for exact, prefix, word-prefix, and contains ordering. `referenceCandidates` and `tagSelector` already reuse it; `fieldOptions`, slash commands, and filename ranking still have local simple filters. | Keep lightweight. Reuse the existing `candidateRanking.textMatchRank` where it removes duplication, but do not force the full index into these latency-sensitive menus. |
| Agent `past_chats` | `src/main/agentPastChats.ts` filters derived event-log indexes by term-AND substring and sorts mostly by recency. | Reuse analyzer/ranking primitives in a message adapter after node retrieval lands. Keep event logs as source of truth. |
| Local file mention search | Main uses Spotlight filename search on macOS, falls back to `rg --files`, then ranks filenames by exact/prefix/word-prefix/contains. | Keep OS/filesystem candidate generation. A small shared label-ranker can clean up filename ordering; the node text index should not index the user's home directory. |
| Agent `file_grep` | `src/main/agentLocalTools.ts` shells to `rg` with bounded output modes, context, glob/type filters, and pagination. | Keep ripgrep. It is already the right engine for file content search. |
| Captured launcher payloads | `lazy-like-global-launcher.md` models payload refs with `searchPolicy: metadata-only | explicit-only | full-text`; default search excludes hidden payloads. | Respect `searchPolicy`. Full payload retrieval is a later explicit adapter, not part of default node search. |
| Web search | External tool/provider. | No local index. Ranking is provider/external-result specific. |

## Design

### 1. Treat PR #102 as the node retrieval foundation

The first implementation should not redesign node search again. Once #102
lands, the node path should be:

1. Build and maintain a derived in-memory text index in `DocumentService`.
2. Use the index for positive `STRING_MATCH` candidate generation and scoring.
3. Run the existing structured evaluator before returning node hits.
4. Keep explicit saved-search sort rules primary, with relevance only as a
   tie-breaker.

This directly benefits the agent `node_search` tool because the tool already
routes through `runSearchExpr`. The benefit is better ranking, CJK recall,
strict phrase/term verification, and lower steady-state query cost without
changing the tool contract.

### 2. Extract shared primitives, not one universal index

Use one shared vocabulary for text analysis and ranking, but keep separate
domain adapters:

```ts
export interface TextAnalyzer {
  normalize(input: string): NormalizedText;
  analyzeQuery(query: string): AnalyzedTextQuery;
  analyzeField(text: string): AnalyzedTextField;
}

export interface LabelRanker {
  rankLabel(label: string, query: string): LabelRank | null;
}

export interface RankedTextIndex<RecordId extends string> {
  search(query: string, options?: TextRetrievalOptions): TextRetrievalHit<RecordId>[];
  candidateIds(query: string, options?: TextRetrievalOptions): Set<RecordId>;
  scoreRecord(id: RecordId, query: string): TextRetrievalScore | null;
}
```

The node index can stay as the first concrete `RankedTextIndex`. Past chats can
reuse the analyzer and index shape with message/session records. Renderer
pickers should usually reuse only `LabelRanker`.

Do not create a single `SearchService` that knows about nodes, files, chats,
launcher commands, and web results. That would centralize unrelated policy and
make correctness harder to review.

### 3. Keep adapters domain-specific

Recommended adapters:

- `NodeRetrievalService`: main-owned live node text index plus structured
  evaluator integration. Used by saved search refresh, `search_nodes`,
  `node_search`, command palette node lookup, and launcher node lookup.
- `NodePickerRanker`: small renderer helper for reference/tag/field/menu
  candidates. Exact/prefix/context heuristics remain local to picker UX.
- `PastChatRetrievalService`: event-log message/session adapter that filters by
  date/session/current-session constraints first, then scores visible messages
  with shared analyzer/ranking primitives.
- `LocalFileNameRetrieval`: OS/filesystem candidate generation plus shared
  label ranking for filenames. File content search remains `file_grep`.
- `LauncherRetrievalAdapter`: merges command rows, node hits, recent
  destinations, and context actions. It may apply launcher-local recency or
  command-frequency tie-breaks after node relevance has ranked node hits.
- `CapturePayloadRetrieval`: explicit-only/full-text payload adapter later,
  gated by `CapturePayloadRef.searchPolicy`.

### 4. Query semantics stay layered

Node retrieval has two layers:

1. Text index proposes candidates and text scores.
2. Structured query evaluator proves matches and applies non-text rules.

Other domains should use the same discipline:

- Past chats: session/date/current-session filters first, visible-message
  verification second, relevance sort third.
- Local files: filesystem/permission candidate set first, filename/path rank
  second, prepare/preview by cached id only.
- Launcher: command visibility/context filters first, row ranking second.
- Capture payloads: `searchPolicy` filter first, payload read/index second.

The rule is: text ranking never bypasses domain permissions, visibility, or
truth-table checks.

### 5. Defer heavier algorithms until probes demand them

PR #102's latest probe data shows that robust TypeScript indexing makes common
10k-node queries practical, while broad high-frequency queries can still cost
tens of milliseconds. That is the right point to measure, not to immediately
add complexity.

Add WAND/block-max top-k pruning, a persisted index, SQLite/FTS5, or embeddings
only after probes show a concrete miss:

- broad 10k or 50k node query latency remains unacceptable;
- cold rebuild cost hurts startup or workspace switching;
- memory grows beyond a documented budget;
- users need semantic recall that lexical search cannot satisfy.

Until then, exact candidate-set scoring plus bounded result limits is simpler
and easier to audit.

## Implementation Plan

### Phase 0: Review and dependency settlement

- Land or rebase on PR #102 before implementing code.
- Fold the shipped node retrieval behavior into `docs/spec/search-query-grammar.md`
  or a dedicated retrieval spec if #102 changes intended semantics.
- Before PR #103 merges, confirm with the launcher owner that launcher node
  search and destination search call the shared node path instead of creating a
  parallel launcher ranker. This is a time-sensitive A7 foundation constraint,
  not a later cleanup.
- Re-read the merged #102 code before implementation and verify exactly which
  legacy scoring paths remain. The follow-up should not over-claim that the
  index replaced every substring scorer until the diff proves it.

### Phase 1: Stabilize shared text primitives

- Keep `src/core/textSearchIndex.ts` as the concrete node index from #102.
- If the implementation has analyzer/ranking logic mixed into the index,
  extract only the reusable pure pieces needed by later adapters:
  normalization, query analysis, CJK term handling, label ranking, and snippet
  building.
- Add unit tests that make these primitives stable across Bun and Electron.
- Keep this PR pure and small: analyzer/index primitive cleanup plus tests only.
  Do not also rewire all node consumers in the same PR.

Expected files:

- `src/core/textSearchIndex.ts`
- optional `src/core/textSearchAnalyzer.ts`
- optional `src/core/textRetrieval.ts`
- `tests/core/textSearchIndex.test.ts`
- optional `tests/core/textSearchAnalyzer.test.ts`

### Phase 2: Make node retrieval the single node lookup path

- Expose a main-side `searchNodes`/`NodeRetrievalService` wrapper around
  `runSearchExpr` plus the live index.
- Route saved-search materialization, command palette node lookup, and agent
  `node_search` through that wrapper where practical.
- Remove or centralize duplicate node text scoring in
  `src/main/agentNodeToolProjection.ts`; on the reviewed #102 path this duplicate
  scorer is still live work.
- If the launcher branch has landed, route launcher note search and destination
  search through the same wrapper.
- Keep renderer pickers separate unless they intentionally call main for global
  node lookup.

Expected files:

- `src/core/searchEngine.ts`
- `src/main/documentService.ts`
- `src/main/agentNodeToolSearch.ts`
- `src/main/agentNodeTools.ts`
- `src/main/agentNodeToolProjection.ts`
- `src/renderer/ui/CommandPalette.tsx`
- `src/main/launcher/*` only if PR #103 has landed
- launcher renderer files only if node search result shaping changes there

### Phase 3: Adapt past chats

- Reuse analyzer/query analysis for `past_chats search`.
- Keep the event store's session/message indexes rebuildable from logs.
- Apply filters before scoring: session ids, date bounds, current-session
  exclusion, active visible branch.
- Sort by relevance first, then recency. Keep `recent` mode recency-only.
- Keep the `past_chats` tool contract unchanged.

Expected files:

- `src/main/agentPastChats.ts`
- `src/main/agentEventStore.ts` only if index projection shape needs a small
  derived-field addition
- `tests/core/agentPastChats.test.ts` or existing past-chat tests
- `docs/spec/agent-event-log-rendering.md` if intended search behavior changes

### Phase 4: Clean up lightweight UI/file label ranking

- Reuse the existing renderer helper
  `src/renderer/ui/interactions/candidateRanking.ts` and its `textMatchRank`
  export. Do not re-extract a second label ranker.
- Keep context-specific tie-breaks in their local picker modules.
- Fold `fieldOptions`, slash-command filtering, or local filename ranking into
  that helper only if doing so removes real duplication. Keep Spotlight /
  `rg --files` as local-file candidate generation.

Expected files:

- `src/renderer/ui/interactions/candidateRanking.ts`
- `src/renderer/ui/interactions/referenceCandidates.ts`
- `src/renderer/ui/interactions/tagSelector.ts`
- `src/renderer/ui/interactions/fieldOptions.ts`
- `src/main/main.ts` for filename ranking only if the shared helper can be used
  without leaking renderer code into main

### Phase 5: Capture payload and scale follow-ups — CLOSED (PM decision, 2026-06-04)

- **5a — capture-payload search: dropped.** This was specified as "explicit payload
  search honoring `CapturePayloadRef.searchPolicy`." That contract no longer exists:
  PR #103 removed the payload-to-file / deferred-enrichment mechanism, and the
  `NodeBase.capture` sidecar is now provenance-only (`CaptureNodeMetadata`,
  `src/core/types.ts`). Capture nodes are already indexed and searched as plain nodes
  by the shared layer, so there is nothing to add. Reopen only if rich-content capture
  is reintroduced, as part of that feature's own plan.

- **5b — scale machinery: shelved (A9 measurement-gated), not done.** Do **not** add a
  persisted text index, WAND/block-max top-k pruning, SQLite/FTS, or embedding/model
  reranking on speculation. The only recorded evidence is synthetic probes (50k broad
  query ~963ms, cold rebuild ~4.5s); no real workspace has shown a miss. Re-open this
  plan (or spin a focused successor) only when a probe against a **real** workspace
  trips a documented trigger:
  - broad 10k/50k node query latency is unacceptable in practice;
  - cold rebuild cost hurts startup or workspace switching;
  - index memory grows beyond a documented budget;
  - users need semantic recall that lexical search cannot satisfy.
  Embedding/model reranking, if it ever lands, is for an explicit semantic-recall
  feature only — never the default `STRING_MATCH` ranking.

### Current implementation scope

Per PM direction, this implementation lands Phases 1-4 together in one PR:
shared primitives, node retrieval unification, `past_chats` relevance, and
lightweight UI/file label ranking cleanup. Phase 5 stays deferred and requires
fresh measurement before adding heavier retrieval machinery.

### Probe results for current implementation

Local Bun probes on 2026-06-04:

- `bun scripts/probe-text-search-index.ts 10000`: cold rebuild ~0.9s;
  selective/prefix/CJK queries ~4-14ms; broad `common` query ~36ms; edit ->
  search ~5ms; 200-record tag fan-out ~16ms.
- `bun scripts/probe-text-search-index.ts 50000`: cold rebuild ~4.5s;
  selective/prefix/CJK queries ~40-293ms; broad `common` query ~963ms; edit ->
  search ~31ms; 1000-record tag fan-out ~164ms.
- `bun scripts/probe-past-chats-search.ts 200 20`: 200 sessions / 4000 messages;
  phrase search ~157ms, CJK search ~67ms, session-filtered search ~16ms,
  date-filtered search ~34ms, current-session exclusion ~15ms.

Decision: keep this PR on the pure TypeScript indexed path plus query-analysis
reuse. Do not add WAND/block-max pruning, a persisted index, SQLite/FTS, or
semantic reranking in this PR. The 50k broad-query and cold-rebuild numbers are
the measured evidence for Phase 5, where heavier top-k pruning or persistence
can be evaluated without changing the simpler default retrieval contract here.

## Acceptance Criteria

Accuracy:

- Exact title/display text matches rank above prefix, phrase, field/tag, and
  body-only matches for node retrieval.
- Multi-term node queries return verified AND matches before OR fallback
  candidates.
- CJK queries match real normalized text and do not return n-gram false
  positives.
- `NOT`, `OR`, and mixed structured node queries keep the current evaluator
  truth table.
- Past-chat search returns only visible messages from allowed sessions and does
  not silently include the current session unless requested.
- Launcher and command-palette node rows use the same node result ordering for
  the same query, before surface-specific command rows are merged.

Performance:

- Positive text-only and positive text `AND` node searches do not score every
  node in steady state.
- Single-node edit -> index update -> node search is O(changed nodes), excluding
  explicit full-rebuild cases.
- Node probes cover 10k and 50k nodes; selective, prefix, broad, phrase, and CJK
  queries; tag/field definition fan-out; memory; cold rebuild; and edit ->
  search.
- Past-chat probes cover many sessions and messages with date/session filters.
- If broad high-frequency queries miss the target, the PR documents whether to
  optimize the scorer now or defer WAND/block-max with measured evidence.

Cleanliness:

- No new dependency, `package.json`, or `bun.lock` change for the first
  follow-up.
- No protocol files (`src/core/types.ts`, `src/core/commands.ts`) unless a
  separate launcher/capture protocol PR has already established the surface.
- Core retrieval primitives do not import Electron, React, renderer state, or
  agent runtime code.
- Main adapters do not leak Node/Electron APIs into renderer.
- Spec changes land in the same PR as behavior changes.
- Phases 1-4 land together in this single PR per PM direction. Phase 5 remains
  separate follow-up work and must be measurement-gated.

## Collision Self-check

Checked on 2026-06-04 against the latest `origin/main` and open PRs:

- #102 `codex/text-search-relevance-layer-impl` is a direct dependency. It
  touches the node text index, `searchEngine`, `DocumentService`, agent
  `node_search`, tests, and search specs/plans. Follow-up implementation should
  wait for #102 to merge or explicitly rebase on it.
- #103 `cc-2/lazy-like-global-launcher` may add launcher node search and
  destination search. This plan should constrain that work to reuse shared node
  retrieval rather than implement a parallel launcher ranker.
- #105 and #106 are settings UI/CSS/spec work with no meaningful retrieval file
  overlap.
- `docs/TASKS.md` lists `text-search-relevance-layer` as P1 and notes
  coordination with `lazy-like-global-launcher`. This plan is the follow-up
  coordination document and should not edit `docs/TASKS.md`.

This plan PR itself touches only this plan file.

## Review Questions

- Is the adapter boundary right: shared analyzer/ranking primitives, but
  separate node, past-chat, launcher, file, and payload adapters?
- Should renderer pickers reuse only a tiny label ranker, or should any picker
  become main-backed after the node index lands?
- After Phase 1 and Phase 2 land, should Phase 3 prioritize past-chat relevance
  or launcher/capture payload retrieval? Launcher node search itself should
  already be constrained in Phase 0 to reuse the shared node path.
- Are WAND/block-max pruning and persisted indexes correctly deferred until
  measured broad-query or cold-start failures?
- Are the Phase 1 / Phase 2 split boundaries small enough for review, or should
  duplicate scorer removal be isolated as its own Phase 2a PR?
