# Search Query Grammar

Search nodes use one canonical query representation:

```ts
type SearchQueryExpr =
  | { kind: "group"; logic: "AND" | "OR" | "NOT"; children: SearchQueryExpr[] }
  | {
      kind: "rule";
      op: QueryOp;
      fieldDefId?: string;
      tagDefId?: string;
      targetId?: string;
      text?: string;
      operands?: Array<{ text?: string; targetId?: string }>;
    };
```

The model-facing outline is a serialization of this tree:

```text
- %%search%% Open work
  - AND
    - HAS_TAG
      - tag:: [[node:#task^node_task_tag]]
    - FIELD_IS
      - field:: [[node:Status^node_status_field]]
      - value:: Open
    - LT
      - field:: [[node:Due^node_due_field]]
      - value:: 2026-05-20
```

Rules:

- `%%search%%` marks the root node as a search node. The remaining root text is
  the search title.
- A search root has exactly one query root child.
- `AND`, `OR`, and `NOT` are group nodes and may be nested.
- QueryOp names are rule nodes.
- Rule operands use `field::`, `tag::`, `target::`, `value::`, or `operand::`.
- `field::`, `tag::`, and `target::` must be exact node references or node ids.
- `value::` and `operand::` bodies are literal query data. Tag-shaped text such
  as `value:: #project`, field-shaped text, checkbox markers, and search/view
  directives are not applied as document metadata or node controls.
- Date operands use the canonical date field value language:
  `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`, or `start/end` with `/`.
- JSON object DSL is allowed as an internal/debug shape only. It is not the
  canonical search outline syntax.

## Complexity Budget

Search query handling is admitted through a shared iterative compiler before
validation or execution. The compiler is the single budget authority for
canonical `SearchQueryExpr` input and protects Core, main/agent tools, and
renderer summaries from stack overflows or frame-length recursive walks.

Current limits:

- maximum query depth: 1,024,
- maximum query nodes: 10,000,
- maximum operands per rule: 256,
- maximum children per group: 1,024.

Over-budget canonical queries fail fast with `invalid_search_condition` (or the
existing unsupported logic/rule issue where applicable) before candidate
evaluation starts. Saved-search condition nodes are converted to canonical
queries with the same budget and cycle checks; an empty saved-search group is
treated as no executable query so saved-search titles are never interpreted as an
implicit text condition. Temporary agent search outlines use the same limits
while parsing, validating, and serializing query trees.

Renderer search query summaries and outline text are also built with bounded
iterative traversals. If the visible summary must omit over-budget branches, it
sets truncation metadata and renders a neutral "More rules omitted" chip instead
of walking the full tree.

## Execution And Relevance

The query protocol is stable: `SearchQueryExpr`, `QueryOp`, saved-search outline
syntax, and `node_search` parameters do not change for text relevance.

`STRING_MATCH` is executed through a derived in-memory text index when a caller
provides one. The index is advisory for candidate generation and scoring; the
structured evaluator still checks the final query truth table before a hit is
returned.

Indexed node text includes:

- title/display text,
- description,
- tag labels,
- field names,
- field values,
- code-block/body text where applicable.

Text normalization uses Unicode NFKC, locale-insensitive lowercase, whitespace
collapse, runtime word segmentation where available, and deterministic fallback
tokenization. Short Latin queries match exact terms and token prefixes; mid-word
Latin substring recall starts at three characters through character trigrams.
Latin-like prefix lookup scans a sorted range of indexed terms rather than every
posting or per-prefix doc-id copies. CJK text also emits n-gram candidates. Final
matching verifies the normalized source text so index artifacts do not create
false positives.

Ranking for `STRING_MATCH` prefers exact title matches, then title prefixes,
phrases, all-term matches, and lower-ranked loose term matches. Tags and field
values are searchable, but they do not outrank exact primary text. Default
relevance also applies a conservative, capped reference-authority boost from the
document's distinct linked inbound source nodes (tree references, inline node
references, and reference-valued field children; trashed/internal metadata references do
not count). Search nodes and their query internals also stay out of this graph:
search result references, search titles, and query operand references are
executable/view state, not authority signals. Because this signal is derived from document state, it is safe for
saved search materialization. If a saved search has an explicit sort, that sort
remains primary and relevance is only a tie-breaker; `sys:refCount` sorts by the
same linked reference count displayed by the References system field.

Transient node lookup surfaces can opt into personal access ranking on top of
the default relevance order. Personal access is stored outside the Loro document
in per-user `userData` (`node-access-stats.json`) as one time-decayed accumulator
per node, updated by deliberate human landings and weak agent recall from
returned `node_search` pages. It is never encoded as a search-node rule, never
written into saved search results, and never participates in saved-search
materialization unless a caller explicitly opts into ranking. Explicit
sorts remain authoritative and do not use personal access.

Candidate pruning is conservative:

- positive text-only and positive text `AND` branches may use index candidate
  intersections;
- `OR` uses candidate unions only when every branch can provide bounded
  candidates;
- `NOT` never prunes solely from the negative text branch;
- every returned hit still passes the existing structured evaluator.

The main process keeps the node text index derived and disposable. It is built
once on workspace load, updated incrementally from Core changed-node deltas, and
rebuilt after undo/redo or other whole-tree rewrites. Tag and field definition
changes fan out through dependency maps so dependent node records are refreshed
without hiding a full rebuild behind `Core.revision()`.

The text normalization, query analysis, CJK/Latin tokenization, snippet building,
and label ranking described above are one shared pure module
(`src/core/textSearchAnalyzer.ts`), consumed by the node text index, the agent
internal conversation-history lookup, and the renderer field/slash/file pickers
so every surface agrees on whitespace, punctuation, CJK grams, and stop-word
handling. Node lookups go through a single indexed evaluator path -- document
search and agent `node_search` both call the main-side `NodeRetrievalService`
around `runSearchExpr` plus the live index, so there is no second competing node
ranker. Heavier retrieval machinery (persisted index, WAND/block-max top-k
pruning, SQLite/FTS, or embedding reranking) is intentionally absent: it is added
only when a probe against a real workspace shows a concrete miss (broad 10k/50k
query latency, cold-rebuild startup cost, a memory budget overrun, or a semantic
recall need lexical search cannot satisfy).
