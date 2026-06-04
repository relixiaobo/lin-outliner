---
status: done
priority: P1
owner: relixiaobo
created: 2026-06-04
updated: 2026-06-04
---

> **Shipped** in PR #102 (kernel implemented in #102; plan ratified as #99).
> Design folded into `docs/spec/search-query-grammar.md`; this plan is kept as
> history.

# Text Search Relevance Layer

## Goal

Build one accurate, fast, clean text relevance foundation for Tenon's larger
text-search surfaces:

- `node_search` / saved search `STRING_MATCH`.
- Future global node search.
- `past_chats search` ranking.
- Future "related nodes" and duplicate-candidate suggestions.

The immediate target is a better `STRING_MATCH` path that keeps Tenon's
canonical search-node syntax and structured query semantics, but replaces the
current all-node substring scoring with a small derived text index and
field-aware relevance scoring.

PM decision: v1 is one integrated implementation, not a split kernel-only PR
followed by a separate `node_search` wiring PR. The design must therefore make
the edit -> search loop fast enough in the same release.

Requirements:

- **Accurate:** exact, prefix, phrase, multi-term, CJK, title, description, tag,
  field-name, and field-value matches all behave predictably. Candidate
  generation may be broad, but final matches must be verified against real
  normalized text so index artifacts never create false positives.
- **Fast:** positive text searches should not linearly score every node on every
  query. Use an inverted index, sorted-term prefix range lookup, rare-term
  candidate selection, bounded top-k result selection, bounded fallback, and explicit
  benchmarks.
- **Simple:** pure TypeScript first. No SQLite, native module, or dependency
  change in v1.
- **Clean:** document state and agent event logs remain the source of truth.
  Search indexes are derived, disposable, and rebuildable.
- **Elegant:** one reusable relevance kernel, small integration points, no
  duplicated scoring rules across main, core, and renderer.

## Non-goals

- No embeddings or model reranking in v1.
- No change to `SearchQueryExpr`, `QueryOp`, `node_search` parameters, or saved
  search outline syntax.
- No SQLite/FTS5 dependency in v1. That remains a measured fallback if the pure
  TypeScript index is not enough.
- No rewrite of small UI pickers (`@`, `#`, field reuse, slash commands). Their
  exact/prefix/context heuristics are interaction-specific and should stay light.
- No local file content search. File attachment search currently uses file names
  and Spotlight/fallback path search.
- No split between the core relevance kernel and `node_search` integration in
  v1. Reviewability is handled by a small kernel API, focused tests, and a
  narrow integration surface, not by staging the feature across PRs.

## Current State

Tenon's text search is split across several local heuristics:

- `src/core/searchEngine.ts` executes structured search queries over an in-memory
  document projection. `STRING_MATCH` scores a node by substring checks: exact
  title 100, title prefix 60, title contains 30, description 15, tag 15, field
  name 8, field value 10. Search results sort by score unless a saved search
  has an explicit created/updated sort rule.
- `src/main/agentNodeToolProjection.ts` duplicates the same scoring shape for
  agent-visible snippets and result presentation.
- `@` references, `#` tags, field reuse, options, and slash commands use
  lightweight exact/prefix/contains filtering. These are appropriate for small
  interactive menus.
- `src/main/agentPastChats.ts` has a derived message index, but search requires
  every normalized query term to be a substring and sorts by recency, not
  relevance.

This is simple and deterministic, but it has weak multi-term ranking, no IDF or
corpus-level relevance, duplicated scoring, linear scans for text-heavy queries,
and only substring-level CJK handling.

## Lens Reference

Lens is useful as a reference, not as code to copy directly:

- Lens keeps source-of-truth files and a rebuildable SQLite index.
- Latin search uses FTS5 + BM25 with strong title weighting and phrase -> AND ->
  OR fallback.
- CJK search does not trust SQLite `unicode61`; it uses a separate fallback and
  verifies against stored text.
- Similar/duplicate discovery uses `Intl.Segmenter` + TF-IDF cosine, without
  embeddings or API keys.
- Resolution is conservative: exact matches first, ambiguous matches return
  candidates instead of guessing.

Tenon should borrow the relevance model and rebuildable-index discipline, but
not Lens's storage shape. Tenon's source of truth is the document state and
agent event log, not Markdown files.

## Local Research Findings

Codex ran two local spikes on 2026-06-04. The scripts live under
`tmp/research/` and are intentionally not part of this plan PR.

### Tokenizer parity

`Intl.Segmenter(undefined, { granularity: "word" })` was tested under:

- Bun 1.3.12,
- Node 24.4.1,
- Electron 42.0.1 (`Chrome 148.0.7778.97`, Node 24.15.0).

Findings:

- CJK examples (`成都天气`, `今日开放任务`, Japanese, Korean) segmented
  consistently across all three runtimes in this sample.
- Mixed Latin/CJK (`AI-agent 搜索性能`) segmented consistently.
- Punctuation-heavy Latin diverged: Bun/Node treated `baz.qux` as one token in
  `foo_bar-baz.qux`, while Electron split it into `baz` and `qux`.

Conclusion: `Intl.Segmenter` is suitable as a helper, but the product index
must own normalization and fallback tokenization. Tests must assert the final
indexed tokens, not merely the raw `Intl.Segmenter` output.

### Performance spike

A throwaway pure-JS inverted index was tested against synthetic records with
title, description, tag, field name, field value, and body text. It maintained
postings and corpus stats incrementally (`upsert` / `remove`) and compared
against a naive all-record substring scan.

Median timings:

| Corpus | Runtime | Cold rebuild | Indexed query | Naive query | Single-node upsert | Edit -> query | Tag rename fan-out |
|---|---:|---:|---:|---:|---:|---:|---:|
| 10k | Bun | ~225 ms | ~0.3-3.9 ms | ~20-25 ms | ~0.016 ms | ~0.29 ms | 200 nodes ~5.4 ms |
| 10k | Node | ~211 ms | ~0.3-2.1 ms | ~25-28 ms | ~0.020 ms | ~0.28 ms | 200 nodes ~4.8 ms |
| 50k | Bun | ~1.5 s | ~6-37 ms | ~96-163 ms | ~0.039 ms | ~6.9 ms | 1000 nodes ~33 ms |
| 50k | Node | ~1.2 s | ~4.7-16 ms | ~108-163 ms | ~0.024 ms | ~4.7 ms | 1000 nodes ~35 ms |

Conclusion:

- Rebuilding on every `Core.revision()` change is not viable. It is already
  hundreds of milliseconds at 10k and over a second at 50k.
- Incremental maintenance is viable. Single-node edits are effectively free
  relative to search latency, and edit -> search stays well under the 10k target.
- Definition fan-out is the real steady-state expensive case. Tag/field renames
  need explicit dependency maps and measurement, not hidden full rebuilds.
- Very broad high-frequency queries can still be expensive at larger corpus
  sizes. v1 should score exact candidate sets for correctness, but the benchmark
  must include broad-query cases so future WAND/top-k optimization can be
  justified with data rather than guessed.

## Design

### 1. Add a pure text relevance kernel

Create `src/core/textSearchIndex.ts` as a dependency-free module with pure data
structures:

```ts
export interface TextSearchRecord {
  id: string;
  kind: string;
  fields: TextSearchField[];
  updatedAt?: number;
}

export interface TextSearchField {
  key: "title" | "description" | "tag" | "fieldName" | "fieldValue" | "body";
  text: string;
  weight: number;
}

export interface TextSearchIndex {
  search(query: string, options?: TextSearchOptions): TextSearchResult[];
  candidateIds(query: string, options?: TextSearchOptions): Set<string>;
  scoreRecord(id: string, query: string): TextSearchScore | null;
}
```

The module owns:

- normalization,
- tokenization,
- postings,
- BM25-style scoring,
- exact/prefix/phrase boosts,
- CJK n-gram candidate generation,
- strict match verification,
- snippet extraction.

It does not import Electron, React, `Core`, renderer state, or agent-tool code.

The index supports both full rebuild and incremental maintenance:

```ts
export interface MutableTextSearchIndex extends TextSearchIndex {
  upsert(record: TextSearchRecord): void;
  remove(id: string): void;
  rebuild(records: Iterable<TextSearchRecord>): void;
}
```

`upsert` removes the old postings for one record, re-tokenizes that record, and
updates document-frequency counters and field-length totals by delta. Corpus
statistics (`recordCount`, per-token `df`, per-field average length) are running
counters, not recomputed from all records after every edit.

### 2. Tokenization and normalization

Normalize every indexed field with:

- Unicode NFKC.
- Locale-insensitive lowercasing.
- Whitespace collapse.
- Punctuation boundaries preserved enough for phrase verification.

Tokenization:

- Use `Intl.Segmenter(undefined, { granularity: "word" })` when available.
- Fall back to a Unicode letter/number regex for Latin-like text.
- For CJK script runs, emit character bigrams for candidate generation, plus a
  one-character fallback only for one-character queries.
- For Latin-like tokens, keep sorted searchable terms for short prefix range
  lookup. Prefix matching scans only the matching term range, not every posting.
- Short Latin queries are exact/prefix-oriented; mid-word Latin substring recall
  starts at three characters through trigram candidates.
- Store each field's normalized raw text. This lets final verification check
  phrase and substring matches exactly, even when n-grams are broad.

Stop words should reduce scoring noise only when the query also has real terms.
They must not silently make a query unmatchable.

### 3. Candidate generation

For a query:

1. Normalize and split into phrase text plus query terms.
2. Use the rarest required term/posting list first.
3. Use exact postings, prefix range lookup, and trigram substring candidates for
   candidate recall. Final scoring still verifies the normalized source text.
4. For multi-term queries, prefer AND candidate intersection.
5. If the AND set is empty or too small, allow OR fallback only as a lower-ranked
   retrieval tier.
6. For CJK queries, use n-gram postings to find candidates, then verify the
   original normalized query substring against field text.
7. For very short queries, cap broad candidate sets before scoring and keep UI
   picker heuristics separate.

This keeps recall high while preserving correctness: the index proposes, the
normalized fields verify.

### 4. Scoring

Score verified candidates with a small field-aware BM25 variant:

- Title/body text: highest core relevance.
- Description: medium.
- Tags: high but not above exact title.
- Field names and field values: useful but lower than primary text.

Boosts:

- Exact title/display text match.
- Title/display text prefix.
- Exact phrase match.
- All query terms present.
- Adjacent term phrase match before loose AND match.

Tie breaks:

- `node_search` default: score descending, then stable `nodeId`.
- Saved search explicit sort: created/updated sort remains primary, score is
  only the tie-breaker, matching the current search-node contract.
- UI pickers: keep their current context/updated/length sorting unless a future
  dedicated picker plan changes them.

### 5. Integrate with `node_search` without changing the protocol

Add an optional text index to the search execution path:

```ts
runSearchExpr(document, query, { searchNodeId, limit, textIndex })
```

Execution model:

- If the query has positive `STRING_MATCH` rules, use the text index to compute
  candidate IDs first.
- For `AND`, intersect candidate sets from positive text children, then run the
  existing full structured evaluator on that smaller set.
- For `OR`, use a union only when all branches can provide bounded candidates;
  otherwise fall back to the existing all-node evaluator.
- For `NOT`, never prune solely from the negative text rule.
- Always call the existing structured evaluator before returning a hit. The text
  index improves candidate order and score; it does not replace structural
  correctness.

This gives performance wins for the common text-dominant case while keeping
complex search semantics correct and easy to review.

### 6. Maintain indexes incrementally at the right boundary

Do not persist a node text index in v1, but also do not rebuild it solely
because `Core.revision()` changed. `revision()` bumps after every applied
mutation, which is exactly the path users hit before searching. A cache keyed
only by `revision()` would be cold in the normal edit -> search loop.

Use a long-lived mutable index plus revision deltas:

- On workspace load, build the index once from the current projection.
- After ordinary mutations and transactions, consume the changed node ids that
  `Core` already computes as `affectedNodeIds` for commit/projection-cache
  patching. For each changed id:
  - if the node still exists and is searchable, `upsert(record)`;
  - if the node was deleted, trashed, became non-searchable, or moved under
    Trash, `remove(id)`;
  - if a changed node is a tag/field definition, also update dependent records
    whose indexed tag names, field names, or option labels changed.
- After undo/redo or any whole-tree rewrite that invalidates the projection
  cache, rebuild the index once from projection.
- Keep `Core.revision()` as a staleness assertion and debug guard, not as the
  primary cache key.
- For tests and pure core callers, full rebuild from `DocumentState` or
  `DocumentProjection` remains a pure function.

Maintain dependency maps next to the live index:

- `tagDefId -> nodeIds` for nodes whose indexed tag labels depend on that tag.
- `fieldDefId -> nodeIds` for nodes whose indexed field names/values depend on
  that field definition.
- `nodeId -> dependency ids` so `upsert` can remove old dependency edges before
  adding new ones.

When a changed id is a tag or field definition, fan out through those maps and
`upsert` each dependent record. This keeps the common case O(changed nodes) and
makes schema-rename costs explicit and measurable.

Implementation shape:

- Add a small non-protocol Core surface such as `lastChangedNodeIds()` /
  `lastChangeRequiresFullSearchRebuild()` or a returned mutation metadata object.
  This does not touch `src/core/types.ts`, `src/core/commands.ts`, or IPC
  contracts.
- `DocumentService` owns the live mutable index. It updates the index inside the
  mutation queue after a successful mutation, before emitting projection-change
  events.
- The kernel stays pure and rebuildable; the service layer owns lifecycle and
  cache invalidation.

Recommended v1 scheme:

1. Full rebuild on workspace load and undo/redo/full-rewrite invalidations.
2. Incremental `upsert`/`remove` for ordinary node mutations.
3. Dependency-map fan-out for tag/field definition changes.
4. Exact candidate-set scoring for correctness, with a bounded top-k heap for
   limited searches so broad queries do not sort every scored candidate.

If measurement later shows cold builds are too slow, add a rebuildable persisted
index as a separate infrastructure plan.

### 7. Apply the same kernel to past chats in a follow-up

`past_chats search` already has rebuildable message indexes. After node search
lands, adapt the same kernel to message records:

- fields: session title, role, user/assistant text, tool summaries;
- filter first by session/date/current-session constraints;
- score filtered candidate messages by text relevance;
- keep recency as a tie-breaker, not the primary rank for text search.

This should be a separate follow-up PR unless the node-search implementation is
small after review.

### 8. Related and duplicate suggestions are separate

For "related nodes" or duplicate detection, use Lens's `Intl.Segmenter` +
TF-IDF cosine idea as a separate non-hot-path feature:

- explicit command or background suggestion,
- bounded candidate set,
- no embeddings in v1,
- no automatic graph mutation.

Do not mix similarity search into normal `STRING_MATCH` ranking.

## File Scope

Expected v1 implementation files:

- `src/core/textSearchIndex.ts` - new relevance kernel.
- `src/core/core.ts` - expose a small read-only revision-delta signal for the
  service layer, reusing the existing `affectedNodeIds` path.
- `src/core/searchEngine.ts` - optional text index integration for
  `STRING_MATCH`.
- `src/main/documentService.ts` - main-process index cache keyed by
  incremental Core deltas for search-node refresh and agent tool execution.
- `src/main/agentNodeTools.ts` / `src/main/agentNodeToolSearch.ts` - pass the
  cached text index into `runSearchExpr` without changing tool contracts.
- `src/main/agentNodeToolProjection.ts` - remove duplicated text scoring or
  route snippet scoring through the shared kernel.
- `tests/core/textSearchIndex.test.ts` - tokenization, ranking, CJK, snippets.
- `tests/core/searchEngine.test.ts` - integration with structured queries and
  explicit sort.
- `tests/core/agentNodeTools.test.ts` or existing agent-tool tests - output
  ordering and snippets.

Avoid in v1:

- `package.json` and `bun.lock`.
- `src/core/types.ts` and `src/core/commands.ts`.
- renderer UI unless a global search UI is explicitly added later.

## Accuracy Acceptance Criteria

- Exact title/display-text match ranks above prefix, phrase, and loose contains.
- Title/display-text prefix ranks above body-only contains.
- Phrase match ranks above loose AND.
- Multi-term queries return candidates containing all real query terms before OR
  fallback candidates.
- CJK queries match Chinese/Japanese/Korean substrings without false positives
  from n-grams.
- Tags and field values are searchable, but do not outrank an exact primary-text
  match.
- Explicit saved-search created/updated sorting remains primary.
- `NOT` and mixed structured conditions keep the same truth table as the current
  evaluator.
- Ambiguous high-level resolution features, if added later, return candidates
  rather than guessing a single node.

## Performance Acceptance Criteria

Add a benchmark-style core test or script with synthetic nodes:

- 10k nodes with title, description, tags, and fields.
- Mixed English and CJK data.
- Queries covering exact, prefix range lookup, phrase, AND, OR fallback, and CJK.
- Representative edits: one title edit, one body/description edit, one tag-name
  edit affecting tagged nodes, one field-name edit affecting field-bearing
  nodes, one delete/trash, and one undo/redo full-rebuild case.

Targets for a local dev Mac:

- Warm text query under 20 ms for common positive `STRING_MATCH` searches after
  a representative single-node edit.
- The edit -> index-update -> search path for a single changed node should be
  O(changed nodes), not O(total nodes), excluding the explicit undo/redo
  full-rebuild case.
- No all-node scoring for positive text-only or positive text `AND` searches.
- Cold full-index build measured and reported separately from the steady-state
  edit -> search path.
- Tag/field definition edits report dependent-record update cost separately, so
  broad schema renames are visible rather than hidden in average latency.
- Broad high-frequency queries are measured separately from selective queries.
  The v1 bounded top-k path avoids full-result sorting; later WAND/block-max
  pruning remains a separate scale optimization if scoring every broad candidate
  is still too expensive.
- Memory usage reported for the synthetic corpus before considering persistence.
- `Intl.Segmenter` tokenization behavior verified under both `bun test` and the
  Electron runtime. If they diverge, the regex/n-gram fallback must produce the
  same indexed terms for the covered CJK and Latin fixtures.

These are targets, not claims. The PR must report measured numbers.

## Review Risks

- **Ranking churn:** better relevance will change result order. Keep fixtures
  explicit and update only tests whose old order depended on substring scoring.
- **CJK overmatching:** n-grams improve speed but can overmatch. Strict normalized
  substring verification is required.
- **Complex query pruning:** candidate pruning must never drop valid results for
  `OR` or `NOT`. Keep pruning conservative and evaluator-backed.
- **Cache staleness:** `Core.revision()` must be used only as a
  staleness/debug guard; steady-state updates must consume changed-node deltas.
  Renderer cache must be keyed by projection identity or render-revision data.
- **Delta completeness:** tag and field definition edits can change the indexed
  text of many dependent records. The dependency map must make those fan-outs
  explicit instead of silently leaving stale postings.
- **Runtime tokenizer drift:** `Intl.Segmenter` is not used elsewhere in the repo
  today. Tests must cover Bun and Electron behavior before relying on it for CJK
  correctness.
- **Scope creep:** past chats and related-node suggestions should be follow-ups
  unless the core kernel lands cleanly.

## Collision Self-check

Checked on 2026-06-04 after the review-comment update:

- `gh pr list --state open`: #98 (`plan/agent-import-skill`) touches only
  `docs/plans/agent-import-skill.md`; #99 is this plan. No file overlap.
- `docs/TASKS.md`: only `lazy-like-global-launcher` is in progress. It may touch
  agent runtime/tool infrastructure. This plan avoids protocol/dependency
  changes in v1 and must coordinate with that work so this kernel is the shared
  search foundation for launcher search surfaces, not a parallel ranking system.
- Intended v1 files avoid the infrastructure-ownership files
  `package.json`, `bun.lock`, `src/core/types.ts`, and `src/core/commands.ts`.

No active file-scope conflict found.

## Open Questions

- Should node-search v1 include past-chats ranking, or should past chats be the
  first follow-up after the integrated kernel + `node_search` v1 lands?
  Recommendation: follow-up.
- Should prefix matching be broad for all fields, or only title/tag/field-name?
  Decision for v1: prefix lookup covers every indexed Latin token through a
  sorted term range scan. It preserves recall without storing per-prefix doc-id
  copies.
- Should recency ever boost default `node_search` relevance? Recommendation: no
  for saved search determinism; only UI pickers should use recency as a
  convenience tie-breaker.

## Implementation Checklist

- [ ] Add `textSearchIndex.ts` with normalization, tokenization, postings,
      BM25 scoring, incremental `upsert`/`remove`, verification, and snippets.
- [ ] Add unit tests for English, CJK, phrase, AND/OR fallback, field weights,
      exact/prefix boosts, and deterministic ties.
- [ ] Add Bun and Electron tokenizer parity coverage for `Intl.Segmenter` and
      fallback tokenization.
- [ ] Expose Core changed-node/full-rebuild deltas without changing protocol
      files.
- [ ] Add `DocumentService` live-index maintenance: cold rebuild on load/full
      rewrite, incremental updates on ordinary mutations.
- [ ] Integrate optional text index into `runSearchExpr`.
- [ ] Keep all structured search tests passing unchanged except intentional
      ordering assertions.
- [ ] Route agent `node_search` through the cached index.
- [ ] Remove or centralize duplicated scoring in `agentNodeToolProjection.ts`.
- [ ] Add benchmark/probe results to the PR body, including edit -> search.
- [ ] Confirm with the `lazy-like-global-launcher` owner that launcher search
      will reuse this kernel rather than building a parallel search ranking.
- [ ] Update `docs/spec/search-query-grammar.md` or
      `docs/spec/agent-tool-design.md` only if implementation behavior changes
      the intended semantics; otherwise keep the protocol docs unchanged.
