---
status: draft
priority: P1
owner: relixiaobo
created: 2026-06-04
updated: 2026-06-04
---

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

Requirements:

- **Accurate:** exact, prefix, phrase, multi-term, CJK, title, description, tag,
  field-name, and field-value matches all behave predictably. Candidate
  generation may be broad, but final matches must be verified against real
  normalized text so index artifacts never create false positives.
- **Fast:** positive text searches should not linearly score every node on every
  query. Use an inverted index, rare-term candidate selection, bounded fallback,
  and explicit benchmarks.
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
- Store each field's normalized raw text. This lets final verification check
  phrase and substring matches exactly, even when n-grams are broad.

Stop words should reduce scoring noise only when the query also has real terms.
They must not silently make a query unmatchable.

### 3. Candidate generation

For a query:

1. Normalize and split into phrase text plus query terms.
2. Use the rarest required term/posting list first.
3. For multi-term queries, prefer AND candidate intersection.
4. If the AND set is empty or too small, allow OR fallback only as a lower-ranked
   retrieval tier.
5. For CJK queries, use n-gram postings to find candidates, then verify the
   original normalized query substring against field text.
6. For very short queries, cap broad candidate sets before scoring and keep UI
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

### 6. Cache indexes at the right boundary

Do not persist a node text index in v1.

- In main process, `DocumentService` can keep a `TextSearchIndexCache` keyed by
  `Core.revision()`.
- In renderer, a future global search UI can memoize against projection identity
  or the existing render-revision machinery.
- For tests and pure core callers, building an index from a `DocumentState` or
  `DocumentProjection` remains a pure function.

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
- `src/core/searchEngine.ts` - optional text index integration for
  `STRING_MATCH`.
- `src/main/documentService.ts` - main-process index cache keyed by
  `Core.revision()` for search-node refresh and agent tool execution.
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
- Queries covering exact, prefix, phrase, AND, OR fallback, and CJK.

Targets for a local dev Mac:

- Warm text query under 20 ms for common positive `STRING_MATCH` searches.
- No all-node scoring for positive text-only or positive text `AND` searches.
- Cold index build measured and reported; if it is above an acceptable UI
  threshold, cache by `Core.revision()` before wiring renderer/global search.
- Memory usage reported for the synthetic corpus before considering persistence.

These are targets, not claims. The PR must report measured numbers.

## Review Risks

- **Ranking churn:** better relevance will change result order. Keep fixtures
  explicit and update only tests whose old order depended on substring scoring.
- **CJK overmatching:** n-grams improve speed but can overmatch. Strict normalized
  substring verification is required.
- **Complex query pruning:** candidate pruning must never drop valid results for
  `OR` or `NOT`. Keep pruning conservative and evaluator-backed.
- **Cache staleness:** main-process cache must be keyed by `Core.revision()`.
  Renderer cache must be keyed by projection identity or render-revision data.
- **Scope creep:** past chats and related-node suggestions should be follow-ups
  unless the core kernel lands cleanly.

## Collision Self-check

Checked on 2026-06-04:

- `gh pr list --state open`: no open PRs.
- `docs/TASKS.md`: only `lazy-like-global-launcher` is in progress. It may touch
  agent runtime/tool infrastructure, so this plan avoids protocol changes and
  dependency changes in v1.
- Intended v1 files avoid the infrastructure-ownership files
  `package.json`, `bun.lock`, `src/core/types.ts`, and `src/core/commands.ts`.

No active file-scope conflict found.

## Open Questions

- Should node-search v1 include past-chats ranking, or should past chats be the
  first follow-up after the kernel lands? Recommendation: follow-up.
- Should prefix matching be broad for all fields, or only title/tag/field-name?
  Recommendation: broad prefix for title/tag/field-name, exact term/phrase for
  long body-like text.
- Should recency ever boost default `node_search` relevance? Recommendation: no
  for saved search determinism; only UI pickers should use recency as a
  convenience tie-breaker.

## Implementation Checklist

- [ ] Add `textSearchIndex.ts` with normalization, tokenization, postings,
      BM25 scoring, verification, and snippets.
- [ ] Add unit tests for English, CJK, phrase, AND/OR fallback, field weights,
      exact/prefix boosts, and deterministic ties.
- [ ] Integrate optional text index into `runSearchExpr`.
- [ ] Keep all structured search tests passing unchanged except intentional
      ordering assertions.
- [ ] Add `DocumentService` cache keyed by `Core.revision()`.
- [ ] Route agent `node_search` through the cached index.
- [ ] Remove or centralize duplicated scoring in `agentNodeToolProjection.ts`.
- [ ] Add benchmark/probe results to the PR body.
- [ ] Update `docs/spec/search-query-grammar.md` or
      `docs/spec/agent-tool-design.md` only if implementation behavior changes
      the intended semantics; otherwise keep the protocol docs unchanged.
