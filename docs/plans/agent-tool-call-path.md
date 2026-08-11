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
- **Secret-redaction coverage unchanged** — only scheduling moves (the durable
  path never gains a budget); the error-only fail-open contract in
  `docs/spec/agent-core.md` stays as specified.
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
  wired, wrapped with the filter's exclusion set. Two constraints the wrapper
  must honor: (1) hidden ids are excluded **before** candidate generation,
  scoring, and limit — never post-filtered, or hidden content would consume
  result slots and skew ranking; (2) switching `node_search` from today's
  filtered-linear path to the index changes result semantics — the indexed
  scorer (`scoreTextSearchRecord`) and the fallback scorer (`scoreTerm`)
  rank differently — so the target semantics is a PM ratification point (the
  recommendation: indexed scoring everywhere, consistent with unfiltered
  threads). `node_edit` regains sparse mutation facts instead of per-node
  `JSON.stringify` diffs.

### PR-2 — per-model-call context costs

The governing contract (`docs/spec/agent-model-runtime.md`): **fresh projection
reducers are constructed at every provider boundary** so environment, view, and
additional-context deltas replay from canonical state; the only sanctioned
cross-step cache is the Turn-scoped **immutable context-payload read cache**.
`CanonicalContextProjector` carries mutable delta state
(`previousEnvironment`/`previousUserView`/`previousAdditionalContext`), so
reusing a projector across steps would violate that contract — it is
explicitly NOT part of this plan.

- **Turn-scoped `readOutput` memoization**, extending the already-sanctioned
  Turn-scoped immutable read cache (the `readContext` memo in
  `withTurnScopedContextReads`) to output payloads: each content-addressed
  payload is read and hash-verified once per Turn, not once per step. This is
  the contract-compatible bulk of the win.
- **Token-count caching by a RAW-content key — not the diagnostics
  fingerprint.** Message object identity is unstable (each projection builds
  fresh messages), so `ContextBudgetPlanner` keys per-message token counts by a
  stable hash of the **raw** message. The diagnostics fingerprint cannot be
  reused for this: `rememberMessage` content-addresses the **redacted**
  diagnostic copy, and redaction collapses distinct secrets of different
  lengths into one placeholder — same fingerprint, different real token counts,
  wrong budget. The two keys stay independent by design; the extra
  stableJson+hash per distinct raw message is still far cheaper than
  re-tokenizing every message every step.
- **Diagnostics: no contract cuts.** `TurnDiagnosticsCollector` already
  deduplicates canonical fragments via its fingerprint map, and the audit
  contract requires the complete reconstructable set — retained copies are NOT
  capped. The remaining cost item is narrow: reuse fingerprints for content the
  fingerprint pass has already seen this Turn (shared with the token cache
  above) and avoid the second deep clone where the normalized value is provably
  the same object graph. Measure-first; if the win is marginal, drop it.

### PR-3 — small tails

- Hoist the `BELIEF_BEARING_TOOLS` check in front of `indexProjection` in
  `ThreadDocumentBeliefs.observe`.
- **Durable secret scan: full coverage, finer yielding — never a budget.** The
  durable path's null budget is deliberate (`redactSecretLikeJsonAsync` scans
  completely; only the diagnostics copy is budget-bounded) — bounding it would
  let a large crafted output bypass redaction into durable storage
  deterministically. The fix is scheduling only: chunk long strings so the
  scanner yields *within* a rule pass (rule × chunk granularity, with overlap
  windows so patterns spanning chunk boundaries still match), or run the
  complete scan on a worker thread. Coverage and redaction outcomes stay
  byte-identical; the existing fail-open applies only to scanner *errors*, as
  today.
- `SubagentCollaboration`: read a child's latest-Turn status from Turn metadata
  (a `lastTurn(threadId)` projection query) instead of decoding the entire
  history; hoist the repeated `requireThread` calls out of the per-edge filter
  chain.
- Turn completion computes `allTurns` once and passes the result to both prune
  sweeps (and any other same-boundary consumer in `TurnLifecycle`).

## Verification

- Unit (`tests/core`, alongside existing memory/tool tests): instrumentation
  counters — one graph build per projection revision, one full-history read per
  Turn (not per projection access), one payload read+hash per Turn per output.
- PR-1 search acceptance fixes the **ratified** semantics, not today's: with no
  hidden nodes, filtered `node_search` returns results identical to ordinary
  indexed search; with hidden nodes, results equal indexed search over the
  visible subset — hidden ids consume no candidate, score, or limit slot at any
  stage. (No equivalence claim against the current filtered-linear path: its
  fallback-scorer ranking is exactly what the PM decision replaces.)
- Existing agent tool and memory extension suites stay green, with one scoped
  exception: `node_search` ranking fixtures under a filter update once to the
  ratified indexed semantics. Everything else in PR-1/2/3 is pure cost.
- **A9 manual:** a multi-tool research Turn (10+ tool calls) on the large test
  document — wall-clock and main-process CPU before/after each PR, recorded in
  the PR body.

## Open questions

- **PM ratification required for PR-1's search semantics:** re-enabling the
  index under the filter moves `node_search` from the fallback scorer to the
  indexed scorer — ranking changes. Recommendation: indexed everywhere.
- Diagnostics capture stays always-on and contract-complete; a settings gate
  would be a separate PM product call, not part of this plan.
- The filtered read-model wrapper's internal shape is the dev's call within
  the stated bound: exclusion BEFORE candidate/score/limit, never post-filter.
