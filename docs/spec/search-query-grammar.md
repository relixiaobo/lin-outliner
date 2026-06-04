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
- Date operands use the canonical date field value language:
  `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`, or `start/end` with `/`.
- JSON object DSL is allowed as an internal/debug shape only. It is not the
  canonical search outline syntax.

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
values are searchable, but they do not outrank exact primary text. If a saved
search has an explicit created/updated sort, that sort remains primary and
relevance is only a tie-breaker.

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
