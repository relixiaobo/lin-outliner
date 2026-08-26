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
      - tag:: tag:11111111-1111-4111-8111-111111111111
    - FIELD_IS
      - field:: field:22222222-2222-4222-8222-222222222222
      - value:: Open
    - LT
      - field:: field:33333333-3333-4333-8333-333333333333
      - value:: 2026-05-20
```

Rules:

- `%%search%%` marks the root node as a search node. The remaining root text is
  the search title.
- A search root has exactly one query root child.
- `AND`, `OR`, and `NOT` are group nodes and may be nested.
- QueryOp names are rule nodes.
- Rule operands use `field::`, `tag::`, `target::`, `value::`, or `operand::`.
- `field::` and `tag::` use their exact typed internal IDs and are never wrapped
  as public Node reference markers. `target::` accepts an exact Node ID or a
  canonical public `[[node://UUID]]` marker; marker display text is resolved
  separately and never serialized into the URI.
- `value::` and `operand::` bodies are literal query data. Tag-shaped text such
  as `value:: #project`, field-shaped text, checkbox markers, and search/view
  directives are not applied as document metadata or node controls.
- Date operands use the canonical date field value language:
  `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`, or `start/end` with `/`.
- JSON object DSL is allowed as an internal/debug shape only. It is not the
  canonical search outline syntax.

`IS_TYPE` lowercases its operand, trims it, and removes spaces, underscores, and
hyphens before comparison. It first compares that value with the node's exact
`NodeType`, then applies these aliases:

- `node`, `plain`, or `textnode` for plain nodes;
- `tag`, `tagdef`, or `supertag` for tag definitions;
- `field` or `fielddef` for field definitions;
- `search`, `searchnode`, or `livesearch` for search nodes;
- `calendar` or `calendarnode` for any day, week, or year node, with `day`,
  `week`, and `year` matching only their respective calendar node;
- `image` for image nodes;
- `attachment` for attachment nodes;
- `code` or `codeblock` for code-block nodes.

The evaluator only visits search candidates: plain, tag-definition,
field-definition, search, code-block, image, and attachment nodes outside trash,
system roots, and query-condition trees. Attachment display text defaults to the
original filename, so ordinary `STRING_MATCH` queries and Launcher lookup can
find files by name; `IS_TYPE attachment` matches every searchable attachment,
including PDFs. Candidacy is global rather than operator-specific: every
executable tag, timestamp, field, link, or structural rule evaluates an
attachment when that attachment carries the rule's required data.

Media rules take no operand. Image nodes always match `HAS_IMAGE` and
`HAS_MEDIA`. The attachment write boundary rejects `image/*`, so attachment
facets classify only explicit normalized `audio/*` and `video/*` MIME families;
both also match `HAS_MEDIA`. Asset ingestion recognizes common media signatures
and filename extensions before creating the node, including AAC, FLAC,
Matroska, MPEG, Ogg/Opus, AVI, WMA, and WMV. Missing/generic MIME data, duration
metadata, arbitrary text, filenames inside the search evaluator, and URLs never
override the stored family. PDFs and other files remain available through text
search and `IS_TYPE attachment`, not a media facet.

## Field Slot Semantics

Field rules read the same `nodeFieldSlots` projection as the renderer, Table,
and agent node reader. A tag-defined field therefore participates in search as
soon as the tag schema contains it, even when the node has no stored field entry.
The field name is indexed for an empty virtual slot; field values and date ranges
come only from stored value children.

The state operators distinguish definition from storage:

- `HAS_FIELD` and `FIELD_IS_DEFINED` match when the slot exists, whether it came
  from a tag chain or an own entry.
- `FIELD_IS_NOT_DEFINED` matches only when no slot for that `fieldDefId` exists.
- `FIELD_IS_SET` matches when the slot presents at least one non-empty stored or
  inherited value.
- `FIELD_IS_NOT_SET` matches when there is no non-empty presented value, including
  nodes where the field is not defined.
- `IS_EMPTY` matches only the intersection: the slot exists and presents no
  non-empty value.

`FIELD_IS`, comparison, sort, filter, date, and text operators read the slot's
stored entry first, then its inherited static default. Removing a tag does not
erase a stored value: the surviving own slot keeps answering the same value
queries. A defaulted field is therefore not empty even before it has an instance
entry; ghosts affect reads only and never provide an instance-owned write id.

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

The renderer's query-outline projection also uses a bounded iterative traversal
and carries explicit truncation metadata whenever a child, operand, node, depth,
or repeated-node limit omits stored structure. The query editor renders that
state as a warning and keeps the projected text read-only: a partial projection
must never be written back over the complete saved query.

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
without hiding a full rebuild behind `Core.revision()`. A tagged node records the
complete applied `extends` chains as dependencies, so adding a field to an
ancestor tag or changing an ancestor's own `extends` target refreshes existing
descendant-tag instances even when their node records did not change.

The text normalization, query analysis, CJK/Latin tokenization, snippet building,
and label ranking described above are one shared pure module
(`src/core/textSearchAnalyzer.ts`), consumed by the node text index and the
renderer field/slash/file pickers
so every surface agrees on whitespace, punctuation, CJK grams, and stop-word
handling. Node lookups go through a single indexed evaluator path -- document
search and agent `node_search` both call the main-side `NodeRetrievalService`
around `runSearchExpr` plus the live index, so there is no second competing node
ranker. Heavier retrieval machinery (persisted index, WAND/block-max top-k
pruning, SQLite/FTS, or embedding reranking) is intentionally absent: it is added
only when a probe against a real workspace shows a concrete miss (broad 10k/50k
query latency, cold-rebuild startup cost, a memory budget overrun, or a semantic
recall need lexical search cannot satisfy).
