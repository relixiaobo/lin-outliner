# Node Tool Context Compression

## Goal

Reduce fresh model-context cost from repetitive node tool calls without weakening
edit precision, search correctness, or runtime observability. The node tool
protocol should stop repeating information already present in annotated outlines,
stop attaching static guidance to every successful result, and support one compact
call for multiple counts that share a query condition.

The representative field-audit workflow should collapse six count calls into one
batch and reduce its combined compact JSON call/result bytes by at least 60%.

## Non-goals

- Do not replace the canonical search outline grammar with a second structured
  query DSL.
- Do not unify `%%node:id%%` edit handles with `[[node:^id]]` answer references.
- Do not change the full runtime `ToolEnvelope` stored in `details`, renderer
  transcript persistence, or debug projections.
- Do not add general batched full-result searches. This change batches count-only
  queries, where the result shape stays small and deterministic.
- Do not change time-based microcompaction or prompt-cache policy for historical
  node tool calls.
- Do not edit main-owned `docs/TASKS.md` or `CHANGELOG.md` in this development PR.

## Shape

This is shape (a): one complete feature in one PR. The compact visible protocol,
batched count execution, tool guidance cleanup, tests, and current-behavior spec
must land together.

## Design

### 1. Compact successful node results

Keep annotated outline text as the model-visible source of node titles and exact
ids. Remove `references[]` from `node_read` and `node_search`: each reference row
currently repeats the outline's id and title as `node_id`, `title`,
`display_ref`, and `edit_handle`. Final answers can use the existing id-only
reference form `[[node:^node-id]]`; the renderer resolves the current node title.

Change search metadata to carry each fact once:

```ts
interface NodeVisibleSearchResult {
  outline?: string;
  total: number;
  next_offset?: number;
}

interface NodeVisibleCountResult {
  total: number;
}
```

The count result no longer includes a nested page object. Search results no longer
echo the caller's offset and limit. `next_offset` is present only when another
page exists. `node_read` keeps its existing conditional child pagination because
it describes one root's truncated children rather than search result pages.

### 2. Dynamic-only result guidance

Move invariant rules into tool and parameter descriptions, which providers receive
with the tool schema on every model request. Successful node results should not
repeat instructions that merely restate:

- how annotated `%%node:id%%` handles work;
- how final-answer node references work;
- that count mode omits editable ids;
- that previews do not mutate;
- that delete moves nodes to Trash.

Keep result `instructions` only when the result contains non-derivable recovery or
next-action information. Errors retain actionable recovery guidance. Warnings and
informative envelope status (`partial`, `unchanged`, `denied`) remain visible.
Pagination is represented visibly by `next_offset`, so it needs no model-facing
prose instruction. Preserve the existing continuation instruction in runtime
`details` for debug and compatibility consumers.

Deduplicate the node tool schema text at the same time: operational use guidance
belongs in the tool description, while detailed input grammar belongs in the
relevant parameter description. Do not embed the same operator guide or outline
manual in both places. Every tool must still carry its own output-handle and
final-answer reference rules because strict `allowedTools` can expose one node
tool without the others.

### 3. Shared-condition batch counts

Extend `node_search` with an optional count-only batch mode:

```ts
interface NodeSearchCountQuery {
  name: string;
  query: string;
}

interface NodeSearchBatchCountParams {
  count: true;
  common_query?: string;
  queries: NodeSearchCountQuery[];
}
```

`common_query` and each item `query` use the existing canonical query-tree outline
syntax, but contain one query rule/group root rather than a `%%search%%` wrapper.
For each item, execution composes:

```text
AND(common_query, item.query)
```

When `common_query` is omitted, the item query executes directly. Nested groups
remain valid because composition happens on parsed query expressions, not through
string concatenation.

Rules:

- `queries` has 1-20 items and names must be non-empty and unique.
- Batch mode requires `count: true` and cannot be combined with `outline`,
  `search_node_id`, `limit`, or `offset`.
- Parse, resolve, and semantically validate every query before acquiring the text
  index, personal-access options, or executing any query. Semantic validation
  uses the core search engine's operand rules for regular expressions, dates,
  scalars, and context-dependent operators. Apply the existing run-scope result
  filter before counting each query. One invalid query fails the whole call; no
  partial count map is returned.
- Count mode records no personal-access signal, matching existing single-count
  behavior.
- Results preserve caller names in one compact map:

```json
{
  "ok": true,
  "data": {
    "counts": {
      "author_visible": 13,
      "author_bound": 0
    }
  }
}
```

The full runtime details retain resolved per-query totals and timing for debugging.

### 4. Compatibility and observability

Existing single-query `outline` and `search_node_id` calls continue to work. This
is a pre-release model-visible protocol cleanup, so no legacy visible-result reader
or compatibility alias is added. Runtime details remain complete for UI, telemetry,
tests, and exports.

### 5. Verification

Add focused tests that lock:

- count results contain one `total` and no page or static instructions;
- search/read results contain no `references` array;
- id-only node references render current titles through the existing renderer path;
- search results expose only `total` and optional `next_offset` metadata;
- pagination continuation guidance remains in runtime `details` while the visible
  result omits it;
- batch counts combine a shared condition with each parsed query;
- duplicate names, invalid fragments, and mixed single/batch parameters fail
  before execution; scoped batches count only readable results;
- a semantic error in the final batch item invokes no text-index or
  personal-ranking execution hook;
- batch counts do not record agent recall;
- a catalog containing only `node_create` still explains edit handles and
  final-answer node references;
- node tool descriptions and parameter descriptions no longer duplicate the full
  search/edit grammar;
- the representative six-count fixture achieves at least 60% compact JSON byte
  reduction compared with six current single calls/results.

## Files

- `src/main/agentNodeToolSchemas.ts`
- `src/main/agentNodeToolGuidance.ts`
- `src/core/searchEngine.ts`
- `src/main/agentToolEnvelope.ts`
- `src/main/agentNodeToolSearch.ts`
- `src/main/agentNodeTools.ts`
- `src/main/agentNodeToolVisibility.ts`
- `src/main/agentNodeToolTypes.ts`
- `docs/spec/agent-tool-design.md`
- `tests/core/agentNodeTools.test.ts`
- `tests/core/searchEngine.test.ts`
- Focused renderer/reference tests only if existing id-only title resolution lacks
  direct coverage.

## Risks

- Removing `references[]` could reduce citation reliability if models ignore the
  id-only reference rule. Mitigate by keeping that rule in the always-present tool
  descriptions and testing renderer title resolution for `[[node:^id]]`.
- Query-fragment parsing could drift from full search parsing. Reuse the same query
  expression resolver and validation path; add no second operator table.
- Batch execution can accidentally produce misleading partial results. Validate the
  complete batch first and fail closed on any invalid item.
- Tool-description cleanup can remove useful guidance while chasing bytes. Keep one
  authoritative copy of every operational rule and assert the important phrases in
  schema tests.

## Collision Result

The collision check found one open Draft PR, #391 (`queued-steer-consumption`),
limited to agent composer steering lifecycle, E2E coverage, and its specification.
It does not overlap this node tool protocol, tests, or spec scope. The active board
contains no node-tool compression claim.

## Open Questions

- Should a future change add general batched full-result searches? Default: no;
  first measure whether count batching plus result compaction removes the observed
  cost.
- Should old node tool results become time-microcompactable later? Default: keep
  that separate because exact historical ids can remain useful for follow-up edits
  and prompt-cache policy needs its own measurement.

## Implementation Checklist

- [ ] Compact node search/read visible results and remove static success guidance.
- [ ] Add shared-condition batch count parsing and execution.
- [ ] Deduplicate node tool schema descriptions.
- [ ] Update the current-behavior specification and focused tests.
- [ ] Run typecheck, core tests, docs check, and diff checks.
