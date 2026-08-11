# Typing Hot Path

**Shape:** (b) a SET of three independent complete features, each its own PR,
each shippable and measurable alone. Ordered by expected payoff: PR-A (memory
extension off the mutation path) → PR-B (document save/export off the typing
rhythm) → PR-C (renderer keystroke commit cost). No hard dependency between
them.

## Goal

A keystroke in the outliner must cost O(changed), not O(document). Today one
keystroke pays multiple full-document passes in the main process (which also
serves all IPC, including agent streaming) and several more inside the
renderer's synchronous `flushSync` commit. Verified costs, per keystroke batch:

Main process:

- `DocumentService.runMutation` calls
  `guardMutation(command, args, meta, this.core.projection())` — the projection
  argument is evaluated eagerly (a full `assembleProjection`) for **every**
  command, and the registered guard (`MemoryExtension.authorizeMutation` →
  `memoryGraphMayChange`) then performs ~4 more full-document passes
  (`new Map(projection.nodes...)`, `commandUsesReservedTag`'s
  `activeDefinitions` filter with per-node trash walk, a reserved-tag filter,
  `timeline.graph(projection)`) plus a `generatedNodes()` SQLite SELECT —
  all **before** the command's own switch can bail out.
- `onProjectionChanged` (in `main.ts`) unconditionally calls
  `MemoryExtension.documentChanged`, which builds the full memory graph
  **twice** (`timeline.graph()` twice — each a fresh `getProjection()` + full
  node index + full tagged scan), fingerprints generated nodes, computes
  `canonicalGraphDigest` (stable-JSON + SHA-256 of the graph), and re-SELECTs
  `generatedNodes()` — per projection change, i.e. per keystroke batch.
- Two forced synchronous full-document saves sit inside the typing rhythm:
  `runMutation` awaits `flushCoreSaveNow()` on the first text patch after a
  structural edit, and the text-edit group flush awaits `saveCore()` on the
  first non-text command after typing. Each save runs `serializeState`:
  `materializeState` (O(N) object spread) + `maxTreeDepth` walk + full
  `doc.export({ mode: 'snapshot' })` (document + CRDT history) + base64 +
  whole-blob `JSON.stringify` — synchronous CPU on the main thread. A
  "type row → Enter → type row" cycle pays two full exports per row.
- The incremental text-search refresh clones the entire node map per committed
  text patch (`const nextNodes = new Map(previousNodes)` in
  `DocumentService`); the index update itself is already incremental.

Renderer (all inside the per-keystroke `flushSync` in `useCommandRunner`):

- `referenceSummaryForIndex` caches on a WeakMap keyed by `index.byId`, but
  `reduceProjection` produces a new `SparseProjectionMap` identity per delta —
  the cache misses on every keystroke and rebuilds the full summary by
  iterating every node (a hash lookup per node through the sparse map's
  generator). Called from the `OutlinerItem` component body.
- The agent dock re-renders its whole visible transcript per keystroke:
  `ThreadTurnView`'s memo is defeated by the fresh `index` prop identity each
  projection delta; `ThreadItemView` is not memoized; and `ThreadDock` stays
  mounted when the rail is closed (`inert` only) — the cost is paid even with
  the agent rail closed.
- The `@` reference popover scans the whole document twice per keystroke while
  open: `TriggerPopover`'s item-count `useMemo` depends on the `props` object
  itself (a fresh object every render, so it never hits) plus a fresh
  `existingTagIds ?? []` fallback; `ReferenceSelector` recomputes
  `referenceItems` with no memo at all; `referenceCandidates` filters all
  `projection.nodes` with a per-candidate `isNodeInTrash` ancestor walk that
  allocates a `Set` per node. The `#` tag selector has a candidate cache
  (`activeTagSelectorIndexes`) but it is keyed on the `DocumentIndex` identity,
  which is replaced by the very keystroke the cache was built to serve.
- `Sidebar` is unmemoized and re-renders per delta; each visible row pays a
  `sidebarNodePresentation` + children scan + an `isNodeInTrash` walk with a
  fresh `Set` allocation.
- `buildVisualRows` (flat outliner) rebuilds row models for **every expanded
  parent** per keystroke; virtualization bounds rendering, not row building.
- `CodeBlockRow` re-highlights the entire block through Shiki on every typed
  character (`useEffect` on `[value, language]`, no debounce).

## Non-goals

- **No memory-feature semantics change.** The mutation guard blocks exactly the
  same commands; memory graph change detection fires for the same real changes
  (only its evaluation cost and timing move). Guard outcomes are byte-identical.
- **The renderer `flushSync`-on-apply stays** (A9: latency-first). This plan
  shrinks what the flush commits, not the flush itself.
- **No editor or virtualization architecture change**; no new state library.
- Startup sequencing, agent tool-call costs, and interaction-chrome scroll
  costs are separate plans (`startup-window-first`, `agent-tool-call-path`,
  `interaction-jank-cleanups`).

## Design

### PR-A — memory extension off the mutation path (main)

- **Lazy guard input.** `guardMutation` receives a projection **thunk** (or the
  maintained `DocumentReadModel`) instead of an eagerly assembled projection;
  a mutation with no registered guard, or a guard that bails on the command
  kind, never assembles anything.
- **O(changed) fast path in the guard.** Reorder `memoryGraphMayChange` so the
  command-kind switch runs first; only commands that can touch reserved tags or
  memory nodes proceed to graph work. `commandUsesReservedTag`'s active
  tag-definition set is computed once per projection revision and cached, not
  rebuilt per command.
- **Deferred, guard-informed `documentChanged`.** A new-state changed-node-id
  check is NOT a sound bail: memory-graph membership also depends on facts a
  changed id does not carry — the node's OLD tags (a removal), deletion events
  (id-only in the delta), the parent day node's date text, Daily-Notes
  ancestry, and Trash membership (`canonicalMemoryGraph`'s
  `isDayNodeInsideDailyNotes` / `isInTrash` walks). Instead, the mutation guard
  — which already evaluates graph relevance for the command — records an
  `affectsMemory` verdict on the operation, and `documentChanged` consumes that
  verdict (one source of truth, no second classifier to drift). Non-command
  projection changes without a verdict take the conservative path. The full
  digest (`canonicalGraphDigest`) moves off the per-event path: mark dirty and
  compute on a debounced idle timer (~500 ms) or at the memory pipeline's own
  wake points. `generatedNodes()` becomes a cached read invalidated by
  `MemoryControlStore` writes instead of a per-event SELECT.
- Invariant: a real memory-graph change — including tag removal, a subtree
  moving into Trash, and a day-node rename — still wakes the pipeline within
  the debounce window; a keystroke that cannot affect the graph does zero graph
  work. The equivalence tests below enumerate exactly these cases.

### PR-B — document save/export off the typing rhythm (main)

- **Remove forced synchronous saves from the mutation queue.** The undo-group
  boundary (`endUndoGroup`) keeps its grouping semantics, but the disk write it
  forces joins the coalescer instead of being awaited inline; likewise the
  structural-edit → first-keystroke forced flush. Ordering stays correct
  because all saves already serialize through the mutation queue.
- **An honest crash window needs a max-wait checkpoint.** The 700 ms coalescer
  (`scheduleTextEditFlush`) clears and re-arms its timer on every patch, so
  sustained typing defers the save indefinitely — "loses at most the coalescing
  window" is false today and would stay false. Add a checkpoint measured from
  the FIRST unsaved change, not reset by subsequent keystrokes (e.g. 5 s
  max-wait): the crash window becomes max(idle window, max-wait), stated as
  such.
- **Bound the serialize cost — persistence contract, PM decides.**
  `serializeState` currently produces one atomic single-file envelope with a
  full Loro snapshot per save. The two ways out — incremental
  `doc.export({ mode: 'update' })` appends with compaction and crash-recovery
  rules, or moving export + base64 + stringify to a worker (Loro binding
  transferability permitting) — change the persistence contract (file format
  and/or threading model), which is directional: the one-pager presents both
  with measurements and the PM ratifies one BEFORE build. Acceptance bound
  either way: no keystroke ever waits on an O(document) serialize.
- **Fix the text-search map clone.** Maintain `textSearchNodes` as a persistent
  structure mutated under the mutation queue (or COW buckets), so a committed
  text patch costs O(changed), not an O(N) `new Map(previousNodes)` copy (both
  the plain and yielding variants).

### PR-C — renderer keystroke commit cost (renderer)

- **Semantic revisions, not the projection revision.** The global projection
  revision bumps on every delta — and typing a picker query is itself a
  document mutation — so any cache keyed on it still misses on exactly the
  keystrokes it exists for. This PR introduces narrow semantic revision
  counters maintained from the `ProjectionUpdate` delta as it is applied: a
  tag-definition revision, a trash-membership revision, and a
  reference-presentation revision (titles/colors of referenced nodes). Caches
  below key on these.
- **`referenceSummary`:** cache on the reference-relevant semantic revision, or
  patch the summary incrementally from changed ids. The WeakMap-on-`byId` key
  is the bug: `byId` changes identity per delta by design.
- **Decouple the agent dock from irrelevant document deltas.** The transcript
  cannot be permanently severed from the index — `threadNodeReferenceStyle`
  and reference labels legitimately read node titles/colors, which must stay
  fresh. Pass the index through a stable read-at-render accessor (ref/context)
  so `DocumentIndex` identity stops being a memo input, and re-render reference
  chips off the reference-presentation semantic revision (or a per-node-id
  subscription) so a rename/recolor still propagates. Memoize `ThreadItemView`.
  Stop paying for a closed dock: unmount (or fully suspend) the transcript when
  the rail is closed instead of relying on `inert`.
- **Reference/tag pickers:** fix `TriggerPopover`'s memo deps (destructure the
  props it reads); memoize `referenceItems` on (semantic revision, query); give
  the `@` path a cached candidate base like the `#` path has, keyed on the
  tag/trash semantic revisions rather than `DocumentIndex` identity; share one
  trash-descendant set per trash revision (the precomputed-Trash-set precedent
  from the perf program) instead of per-candidate ancestor walks with `Set`
  allocations.
- **`Sidebar`:** memoize rows; use the shared per-revision trash-descendant set.
- **`buildVisualRows`:** derive rows for the virtual window plus overscan, or
  patch the row model from changed ids, instead of rebuilding every expanded
  branch per delta.
- **`CodeBlockRow`:** debounce re-highlighting (~150 ms). The text itself lives
  in the editor; the highlight is decoration and may lag a beat.

## Verification

- Unit, PR-A: guard outcome equivalence over the command corpus (same
  allow/deny as today), with instrumentation counters proving zero full-graph
  builds for a plain text patch and at most one digest computation per debounce
  window (`tests/core`, alongside the existing memory extension tests).
  Wake-equivalence cases enumerate the non-obvious graph changes: memory-tag
  REMOVAL, id-only deletion, a day-node date rename, a move out of Daily
  Notes, and an ancestor entering Trash — each must still wake the pipeline.
- Unit, PR-B: a text-patch burst performs no synchronous save inside
  `runMutation`; sustained typing past the max-wait still checkpoints (fake
  clock); the search-refresh map is not copied per patch (counter);
  crash-window semantics documented in the test that covers the coalescer.
- Unit, PR-C: cache-hit tests for referenceSummary / candidate bases across a
  simulated delta (`tests/renderer`); a transcript fixture that asserts no
  `ThreadTurnView` re-render on a document-only index change.
- **Probe (A9):** `renderProbe` typing latency on the large test document,
  before/after each PR, with the agent rail open and a Subagent streaming —
  numbers recorded in each PR body.

## Open questions

- **PM ratification required before PR-B builds:** incremental-update
  export (file-format change: append log + compaction + recovery rules) vs
  worker-thread export (threading change, binding transferability to verify) —
  a persistence-contract decision, presented with measurements at the
  one-pager.
- Whether `referenceSummary` moves to incremental patching or revision-keyed
  caching is the dev's call; both satisfy the bound.
- PR-A's `affectsMemory` verdict transport (operation metadata vs a
  guard-to-listener side channel keyed by operationId) is the dev's call; the
  bound is one classifier, not two.
