# Agent Tool-Call Path

**Shape:** (b) a SET of three independent complete features, each its own PR:
PR-1 (memory projection filter cost + read-model re-enablement) → PR-2
(per-model-call context costs) → PR-3 (small tails). Ordered by payoff; no hard
dependency.

## Goal

An agent Turn's latency should be dominated by the model, not by the host.
Today every node tool call and every model call pays main-process work
proportional to the whole document, the whole thread history, or all persisted
tool output. Verified costs:

Per node tool call:

- `MemoryExtension.filterProjection` wraps every `getProjection()` a node tool
  makes (1–3 per call). Each invocation: `explicitNodeReferences` →
  `readThread({ includeTurns: true })` — a paged SQLite read of the **entire
  thread history** with `JSON.parse` + `decodeThreadItem` per item, decoded a
  second time inside `decodeThread`, then deep-frozen; plus `timeline.graph()`
  (full O(document) index + traversal) **twice** (once more via
  `visibleNodes`/`visibilityView`); plus `generatedNodes()` (SQLite `SELECT *`)
  and `generatedNodeIdsWithoutCurrentSupport` (N+1 SQLite queries).
- The mere presence of `filterProjection` disables the maintained read model
  and text-search index for **all** agent tools: `ToolRuntime` wires
  `getDocumentReadModel`/`getTextSearchIndex` only when no filter exists. So
  `node_search` runs a linear scan instead of the BM25 index, and `node_edit`
  takes the full-diff path — `changedNodeIds` with a `JSON.stringify` **per
  node** over before/after projections. The perf program's read-model work is
  effectively switched off on the agent path.
- `ThreadDocumentBeliefs.observe` builds `indexProjection(projection)` (full
  `new Map` over all nodes) for **every** tool result — including `bash`,
  `file_read`, `web_fetch` — because the `BELIEF_BEARING_TOOLS` filter lives
  inside the callee.

Per model call (×N steps per Turn):

- The whole-history context is re-projected from scratch each step:
  `freezePendingToolOutputProjections` iterates every item of every turn, and a
  fresh `CanonicalContextProjector` (empty caches) re-runs
  `projectTurnsWithBoundaries` over the full history.
- `ContextBudgetPlanner` re-tokenizes every message and re-stringifies every
  tool call's arguments and every tool's parameter schema each step.
- Every historical tool output with a `full` projection is **re-read from disk
  and re-SHA-256-verified** each step: `withTurnScopedContextReads` memoizes
  `readContext` but not `readOutput`.
- `TurnDiagnosticsCollector.captureProviderRequest` deep-clones the full
  request and every context message (`jsonValue(…, true)`), runs
  `stableJson` + SHA-256 fingerprints per message and for the whole request —
  always on, no setting gate; canonical copies are retained for the Turn.

Other:

- `redactSecretLikeJsonAsync` (tool arguments and results in `ToolRuntime`)
  scans with a **null budget** — unbounded, unlike the diagnostics variant —
  and yields only *between* rules, so one regex pass over a multi-megabyte
  `file_read` result is uninterruptible on the main thread.
- Turn boundaries perform 5–7 independent `allTurns` full-history decodes
  (`TurnLifecycle` and the two payload prune sweeps in `ThreadResourceOps`).
- `SubagentCollaboration.collaborationView` decodes a child's **entire
  history** (`allTurns(threadId).at(-1)`) just to read the last Turn's status,
  per child, on every `list_agents`/`wait_agent` call; its filter chain also
  repeats `requireThread` per edge.

## Non-goals

- **No tool semantics change**; memory visibility rules unchanged — the
  filtered projection stays byte-identical, only its computation is cached.
- **Secret-redaction coverage unchanged** — only scheduling/budgeting moves;
  the fail-open contract in `docs/spec/agent-core.md` stays as specified.
- Turn Diagnostics stays able to capture full requests; only its per-step
  redundancy is removed (see Open questions for the gating decision).
- The streaming delta pipeline (PR #525) and its follow-ups are separate.

## Design

### PR-1 — memory filter cost + read-model re-enablement

- **Cache `filterProjection` inputs.** Explicit node references resolve once
  per (threadId, turnId) and update on item append — the active Turn's
  `ItemRecorder` already holds the items; never re-read the whole thread via
  `readThread({ includeTurns: true })` per projection access. The memory graph,
  generated-node set, and visibility view compute once per projection revision
  and invalidate on `MemoryControlStore` writes.
  `generatedNodeIdsWithoutCurrentSupport` collapses its N+1 queries into one
  join, cached the same way.
- **Filtered read model instead of no read model.** `ToolRuntime` provides
  `getDocumentReadModel`/`getTextSearchIndex` even when a projection filter is
  wired, wrapped with the filter's exclusion set: the read model exposes the
  filtered view (hidden subtrees excluded from lookups and search results
  post-filtered). `node_search` regains the BM25 index; `node_edit` regains
  sparse mutation facts instead of per-node `JSON.stringify` diffs.

### PR-2 — per-model-call context costs

- **Turn-scoped `readOutput` memoization**, mirroring the existing
  `readContext` memo in `withTurnScopedContextReads`: each payload is read and
  hash-verified once per Turn, not once per step.
- **Projector reuse across steps.** Carry the `CanonicalContextProjector`'s
  payload/projection caches across model calls within a Turn (history prefix is
  frozen; invalidate only for items appended since the last step), or
  equivalently cache `projectTurnsWithBoundaries` for the frozen prefix.
- **Token-count caching.** `ContextBudgetPlanner` keys per-message token counts
  by message identity so a stable prefix is never re-tokenized.
- **Diagnostics incrementality.** `TurnDiagnosticsCollector` reuses message
  fingerprints across steps for the stable prefix instead of re-cloning and
  re-`stableJson`-ing the entire context each step, and caps retained canonical
  copies per Turn.

### PR-3 — small tails

- Hoist the `BELIEF_BEARING_TOOLS` check in front of `indexProjection` in
  `ThreadDocumentBeliefs.observe`.
- Give the `ToolRuntime` secret scan a budget (as the diagnostics variant has)
  or chunk long strings so a single rule pass cannot monopolize the event loop;
  behavior on budget exhaustion follows the existing fail-open contract.
- `SubagentCollaboration`: read a child's latest-Turn status from Turn metadata
  (a `lastTurn(threadId)` projection query) instead of decoding the entire
  history; hoist the repeated `requireThread` calls out of the per-edge filter
  chain.
- Turn completion computes `allTurns` once and passes the result to both prune
  sweeps (and any other same-boundary consumer in `TurnLifecycle`).

## Verification

- Unit (`tests/core`, alongside existing memory/tool tests): instrumentation
  counters — one graph build per projection revision, one full-history read per
  Turn (not per projection access), one payload read+hash per Turn per output;
  filtered read-model equivalence (same visible results as the wholesale-
  disabled path today, including hidden-subtree exclusion in `node_search`).
- Existing agent tool and memory extension suites stay green unchanged — the
  contract is pure cost.
- **A9 manual:** a multi-tool research Turn (10+ tool calls) on the large test
  document — wall-clock and main-process CPU before/after each PR, recorded in
  the PR body.

## Open questions

- Diagnostics gating: keep always-on capture with the incremental fingerprint
  reuse (recommended, preserves the debugging contract), or add a settings
  gate/sampling? Default is the former; a gate is a PM product call.
- The filtered read-model wrapper's exact shape (exclusion-set push-down vs
  post-filter) is the dev's call; the acceptance bound is index-backed
  `node_search` and sparse `node_edit` facts with the filter active.
