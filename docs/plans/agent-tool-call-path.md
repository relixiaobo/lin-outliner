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
  makes (1–3 per call). A later targeted-read fix removed the original
  whole-thread decode, but each invocation still re-reads and decodes the same
  Turn for `explicitNodeReferences`; calls `timeline.graph()` (full O(document)
  index + traversal) **twice** (once more via
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

## Non-goals

- **No tool semantics change, with ONE ratified exception:** `node_search`
  ranking under a memory filter moves to indexed scoring (PM-ratified
  2026-08-11 — see PR-1). Memory visibility rules are unchanged — the filtered
  projection stays byte-identical, only its computation is cached.
- **Secret-redaction coverage unchanged** — only scheduling moves (the durable
  path never gains a budget); the error-only fail-open contract in
  `docs/spec/agent-core.md` stays as specified.
- Turn Diagnostics stays able to capture full requests; only its per-step
  redundancy is removed (see Open questions for the gating decision).
- The streaming delta pipeline (PR #525) and its follow-ups are separate.

## Design

### PR-1 — memory filter cost + read-model re-enablement

- **Cache `filterProjection` inputs.** Explicit node references resolve once
  per (threadId, turnId) and update from recorded Item appends. When the
  extension did not observe Turn start, recovery uses a targeted Turn read;
  transient misses remain unresolved and retry until the first successful read.
  Item notifications do not create cache state: their canonical persistence
  precedes observer delivery, so later recovery includes any pre-state append
  without retaining orphan Turn IDs.
  Canonical membership and explicit ancestor/descendant expansion reuse the
  already-maintained `MemoryMutationIndex`; no parallel full-graph cache is
  introduced. Hidden IDs and filtered views compute once per mutation-index,
  control-store, and Turn-reference revision.
  `generatedNodeIdsWithoutCurrentSupport` collapses its N+1 queries into one
  grouped join, cached behind a process-local control-store filtering revision.
- **Filtered read model instead of no read model.** `ToolRuntime` provides
  `getDocumentReadModel`/`getTextSearchIndex` even when a projection filter is
  wired, wrapped with the filter's exclusion set. Two constraints the wrapper
  must honor: (1) hidden ids are excluded **before** candidate generation,
  scoring, and limit — never post-filtered, or hidden content would consume
  result slots and skew ranking; (2) switching `node_search` from today's
  filtered-linear path to the index changes result semantics — the indexed
  scorer (`scoreTextSearchRecord`) and the fallback scorer (`scoreTerm`)
  rank differently. **PM-ratified 2026-08-11: indexed scoring everywhere**,
  consistent with unfiltered threads — this is the plan's single deliberate
  semantics change. `node_edit` regains sparse mutation facts instead of
  per-node `JSON.stringify` diffs.

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
- **Token-count caching: dropped.** `estimateProviderMessageTokens` is a
  length-based estimator (no real tokenizer), so any cache keyed by a
  stableJson+hash of the raw message costs MORE per lookup than the estimate it
  saves — and message objects are rebuilt every projection, so there is no
  serialization-free identity to key on short of new projector contract
  surface (a stamped message-identity sidecar), which is out of this plan's
  scope. (The diagnostics fingerprint is not a substitute: it content-addresses
  the REDACTED copy, which collapses distinct secrets into one placeholder —
  same key, different real token counts.) If the A9 measurement shows budget
  estimation itself is material, a follow-up plan can introduce the sidecar
  identity deliberately.
- **Diagnostics fingerprint reuse: dropped after measurement.**
  `TurnDiagnosticsCollector` already deduplicates canonical fragments, and the
  audit contract requires the complete reconstructable set. Profiling after the
  output-read fix attributed about 73% of the remaining provider-boundary cost
  to the bounded Secretlint scan and about 1% to SHA fingerprinting, so another
  fingerprint/deep-copy cache would optimize the wrong operation.

### PR-3 — small tails

- Hoist the `BELIEF_BEARING_TOOLS` check in front of `indexProjection` in
  `ThreadDocumentBeliefs.observe`.
- **Shared secret-scan scheduling, distinct budgets.** Profiling measured the
  64,000-character diagnostics copy, while the durable path deliberately has a
  null budget and must scan completely; bounding durable work would let a large
  crafted output bypass redaction into storage deterministically. Both paths
  stage their ordered strings into one batch and use the same pure scanner.
  Sufficiently large batches run on one lazy, unreferenced Node worker; small
  batches run directly to avoid IPC overhead, and worker failure retries the
  same complete scanner directly before the existing fail-open boundary.
  Diagnostics spends its global budget before worker dispatch and preserves its
  omission markers. The worker scans whole strings rather than chunks, so
  arbitrary-span credentials such as private keys require no overlap heuristic
  and redaction outcomes remain byte-identical.
- At every provider freeze, evict successful Turn-scoped `readOutput` entries
  whose complete typed keys are absent from the effective context's existing
  frozen-projection set. Compacted-away output stays recoverable from storage
  but no longer stays resident for the rest of the Turn.
- Turn completion computes `allTurns` once and passes the result to both prune
  sweeps and the created-resource retention check, so all three derive from one
  canonical snapshot.

## Verification

- Unit (`tests/core`, alongside existing memory/tool tests): instrumentation
  counters — one mutation-index build at initialization or a full projection
  replacement and no repeated graph build per filter access; no repeated Turn
  read after a successful targeted recovery (unavailable recovery state retries
  rather than caching an empty result); and one payload read+hash per Turn per
  output.
- PR-1 search acceptance fixes the **ratified** semantics, not today's: with no
  hidden nodes, filtered `node_search` returns results identical to ordinary
  indexed search; with hidden nodes, results equal indexed search over the
  visible subset — hidden ids consume no candidate, score, or limit slot at any
  stage. (No equivalence claim against the current filtered-linear path: its
  fallback-scorer ranking is exactly what the PM decision replaces.)
- Existing agent tool and memory extension suites stay green, with one scoped
  exception: `node_search` ranking fixtures under a filter update once to the
  ratified indexed semantics. Everything else in PR-1/2/3 is pure cost.
- PR-3 additionally proves that non-belief tools never index a projection, a
  compacted-away output is re-read if it later re-enters effective context,
  terminal cleanup performs one canonical Turn decode, the diagnostics budget
  remains ordered across a batch, and long cross-boundary credential fixtures
  produce the same bytes through direct and worker scans.
- **A9 manual:** a multi-tool research Turn (10+ tool calls) on the large test
  document — wall-clock and main-process CPU before/after each PR, recorded in
  the PR body.

## Open questions

- Diagnostics capture stays always-on and contract-complete; a settings gate
  would be a separate PM product call, not part of this plan.
- The filtered read-model wrapper's internal shape is the dev's call within
  the stated bound: exclusion BEFORE candidate/score/limit, never post-filter.
