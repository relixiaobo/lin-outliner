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

- **Lazy guard input — the live projection thunk ONLY, never the read model.**
  `guardMutation` receives a thunk over `core.projection()` instead of an
  eagerly assembled projection; a mutation with no registered guard never
  assembles anything. The `DocumentReadModel` is NOT a legal guard input: it
  updates from post-commit deltas, while `core.projection()` explicitly builds
  fresh inside a transaction to reflect in-flight mutations — a guard reading
  the read model mid-transaction would judge a multi-command memory
  publication against stale membership.
- **A `MemoryMutationIndex`, because a command-kind switch cannot answer
  membership.** Even a plain `apply_node_text_patch` must be judged against
  the guard's membership sets — is the target canonical-owned, a protected
  ancestor, reserved-tagged? — and today those sets exist only as products of
  the full scan (`memoryGraphMayChange` walks ancestors from every
  reserved-tagged node and descendants+ancestors of every graph container).
  Nor can they be cached on the projection revision, which bumps every
  keystroke. PR-A therefore maintains an incremental `MemoryMutationIndex`
  holding at least: canonical-owned ids, protected-ancestor ids,
  reserved-tagged ids, active tag definitions, and generated ids. It updates
  only from operations whose verdict was `affectsMemory` (and from the memory
  pipeline's own writes); ordinary revision churn never invalidates it. The
  guard answers a text patch with O(1) lookups against the index. The index is
  **transaction-aware**: updates accumulate in an overlay while a transaction
  is open (later commands in the same transaction read through it), fold into
  the base only on outer commit, and are discarded on rollback — the base
  never observes an uncommitted state.
- **Deferred, guard-informed `documentChanged`.** A new-state changed-node-id
  check is NOT a sound bail: memory-graph membership also depends on facts a
  changed id does not carry — the node's OLD tags (a removal), deletion events
  (id-only in the delta), the parent day node's date text, Daily-Notes
  ancestry, and Trash membership (`canonicalMemoryGraph`'s
  `isDayNodeInsideDailyNotes` / `isInTrash` walks). Instead, the mutation guard
  — which already evaluates graph relevance for the command — records an
  `affectsMemory` verdict on the operation, and `documentChanged` consumes that
  verdict (one source of truth, no second classifier to drift). Non-command
  projection changes without a verdict take the conservative path. What defers
  is ONLY the digest and the wake: `canonicalGraphDigest` computation and the
  pipeline wake move to a debounced idle timer (~500 ms) or the pipeline's own
  wake points. The generated-node **ownership reconciliation** (fingerprint
  comparison → `markNodeUserAuthoritative`) does NOT defer — it completes
  before the memory write gate releases, so a pipeline write can never act on
  stale ownership of a node the user just edited. `memory:*` self-publications
  keep their existing skip. `generatedNodes()` becomes a cached read
  invalidated by `MemoryControlStore` writes instead of a per-event SELECT.
- Invariant: a real memory-graph change — including tag removal, a subtree
  moving into Trash, and a day-node rename — still wakes the pipeline within
  the debounce window; a keystroke that cannot affect the graph does zero graph
  work. The equivalence tests below enumerate exactly these cases.

### PR-B — document save/export off the typing rhythm (main)

- **Remove forced synchronous saves from the mutation queue.** The undo-group
  boundary (`endUndoGroup`) keeps its grouping semantics, but the disk write it
  forces joins the coalescer instead of being awaited inline; likewise the
  structural-edit → first-keystroke forced flush. Save ordering is owned by the
  handoff contract below — persistence revisions, single snapshot ownership,
  and acks — NOT by the mutation queue, which saves leave entirely.
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
  with measurements and the PM ratifies one BEFORE build. No product code for
  PR-B lands ahead of that ratification.
- **The save leaves the mutation queue entirely — a full handoff contract,
  not just an off-thread serialize.** Today `flushCoreSave` chains onto
  `mutationQueue` and `saveCore` awaits the whole `atomicWriteFile`, so a
  keystroke arriving during a save queues behind the file write and rename —
  moving only the serialize off-thread would leave that intact. PR-B defines
  the pipeline explicitly: a mutation marks the document dirty at a
  **persistence revision** and returns; a background saver (owning snapshot →
  serialize → write) acknowledges the revision it durably persisted. Failure
  handling is part of the contract: a failed save keeps the dirty state at its
  revision, retries with backoff, and surfaces a persistent failure (today's
  timer `void`s the promise — a silent-drop this PR removes); `before-quit`
  drains by awaiting the latest revision's ack. Acceptance bound: no keystroke
  ever waits on an O(document) serialize OR on the file write.
- **Fix the text-search map clone.** Maintain `textSearchNodes` as a persistent
  structure mutated under the mutation queue (or COW buckets), so a committed
  text patch costs O(changed), not an O(N) `new Map(previousNodes)` copy (both
  the plain and yielding variants).

### PR-C — renderer keystroke commit cost (renderer)

- **Semantic revisions where they work, per-node incrementality where they
  don't.** The global projection revision bumps on every delta — and typing a
  picker query is itself a document mutation — so any cache keyed on it misses
  on exactly the keystrokes it exists for. But a coarse "presentation revision"
  fed by titles has the same trap: the node being edited changes title every
  keystroke, bumping the revision globally. So the split is: narrow
  **structural** revisions maintained from the applied `ProjectionUpdate` delta
  — a tag-definition revision, a trash-membership revision, and a
  **referenceGraphRevision** (reference edges, `inlineRefs`, `refRole`, source
  parentage, search/query ancestry) — for the facts that change rarely; and
  **per-node incremental maintenance** for the facts that change per keystroke
  (titles, `updatedAt`): caches patch the changed nodes' entries in place
  rather than invalidating globally.
- **`referenceSummary`:** maintained incrementally — `buildReferenceSummary`
  depends on far more than titles (reference edges, `refRole` backlink
  eligibility, source-parent and search-ancestry resolution, trash state), so
  its cache patches entries from changed ids and rebuilds only on
  referenceGraphRevision / trash-revision changes. The WeakMap-on-`byId` key is
  the bug: `byId` changes identity per delta by design.
- **Decouple the agent dock from irrelevant document deltas.** The transcript
  cannot be permanently severed from the index — `threadNodeReferenceStyle`
  and reference labels legitimately read node titles/colors, which must stay
  fresh. Pass the index through a stable read-at-render accessor (ref/context)
  so `DocumentIndex` identity stops being a memo input, and re-render reference
  chips off a per-node-id subscription so a rename/recolor still propagates
  (a global revision would bump per keystroke via the edited node's title).
  (`ThreadItemView` memoization itself belongs to `agent-streaming-followups`,
  which sequences the prop stabilization it needs — this PR only removes the
  document-delta trigger and does NOT touch item-level memo.) Stop paying for a
  closed dock via **state-preserving suspension, never a bare unmount**:
  `ThreadView` owns the composer draft as local state and its cleanup aborts
  and discards unsent attachments, so unmounting on rail close would destroy
  the user's draft, staged attachments, and scroll position. Either gate
  rendering while keeping the component mounted (suspension), or first hoist
  draft/attachment state above the mount boundary — closing and reopening the
  rail must be lossless.
- **Reference/tag pickers:** fix `TriggerPopover`'s memo deps (destructure the
  props it reads). The `@` candidate base cannot be revision-cached — it reads
  titles, ancestor breadcrumbs, `updatedAt`, candidate types, and the
  display-cycle graph, several of which change on the very keystroke being
  served — so it becomes a **queryable label index, not just a maintained base
  table**: an incrementally patched base (per-node entries updated from
  changed ids) is necessary but not sufficient — a query that still
  filters/ranks/sorts every node only shrinks the constant, not the O(N).
  Queries resolve against a label/text lookup structure (sorted label keys or
  n-gram buckets — dev's choice) that yields a **bounded candidate set**
  without enumerating all nodes; rank/sort run on that bounded set only.
  Breadcrumb and display-cycle presentation are computed lazily for the
  bounded results at render time, never stored per node — an ancestor rename
  therefore cannot invalidate descendants' cached entries, because breadcrumbs
  are not cached. Full rebuild only on referenceGraphRevision / trash /
  tag-definition changes. Share one trash-descendant set per trash revision
  (the precomputed-Trash-set precedent from the perf program) instead of
  per-candidate ancestor walks with `Set` allocations.
- **`Sidebar`:** memoize rows; use the shared per-revision trash-descendant set.
- **`buildVisualRows`: incremental row-model patching — window-only derivation
  is out.** The layout model needs the complete flat row list:
  `buildRowLayout` sums every row's height for total height and scroll
  offsets, and forced-index collection scans all rows — deriving only the
  viewport would force a virtualization-architecture change this plan's
  non-goals exclude. Instead the full row model is kept and **patched** from
  changed ids — but "text patch → in-place row update" is NOT universally
  sound: Name, Updated, and custom field values all feed the active view's
  sort (`fieldTextFor`), filter (`partitionFilterRows`), and grouping, so
  ordinary typing can legitimately move a row, cross a group, or enter/leave
  the filtered set. The patcher therefore declares the active view's **field
  dependencies** (sort field ids, filter-rule fields, group field): a text
  patch whose changed fields are disjoint from them updates the row in place;
  one that intersects them invalidates and rebuilds the affected branch, same
  as a structural change. Invalidation rules per trigger are stated in the
  PR.
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
  `MemoryMutationIndex` equivalence: after an arbitrary mutation corpus, the
  index's membership sets equal the sets the full scan derives; a text patch
  to a non-memory node does zero graph work while one to an owned/generated
  node still authorizes and reconciles ownership synchronously. Transaction
  cases: a multi-command transaction whose later commands depend on earlier
  ones' membership changes authorizes identically to the full-scan guard, the
  overlay folds on commit, and a rolled-back transaction leaves the base index
  byte-identical (commit/rollback equivalence).
- Unit, PR-B: a text-patch burst performs no synchronous save inside
  `runMutation` and never queues behind an in-flight file write; sustained
  typing past the max-wait still checkpoints (fake clock); a failed background
  save keeps the dirty revision, retries, and surfaces — never a silent drop;
  `before-quit` drains to the latest revision's ack; the search-refresh map is
  not copied per patch (counter).
- Unit, PR-C: incremental-maintenance equivalence tests — patched
  referenceSummary / candidate-index state equals a from-scratch build across
  a mutation corpus (`tests/renderer`); a candidate-visit upper-bound test —
  a picker query touches at most O(bounded results) candidate entries, never
  all nodes (counter); a transcript fixture that asserts no `ThreadTurnView`
  re-render on a document-only index change; rail close→reopen preserves
  composer draft, staged attachments, and scroll position; patched visual-row
  model equals a from-scratch `buildVisualRows` across sort/filter/group/
  reference mutations — including sort/filter/group **parity under typing**:
  editing Name, Updated-relevant content, a custom field value that feeds the
  active sort/filter/group, and renaming a reference target must each move,
  regroup, or re-filter rows identically to a full rebuild.
- **Probe (A9):** `renderProbe` typing latency on the large test document,
  before/after each PR, with the agent rail open and a Subagent streaming —
  numbers recorded in each PR body.

## Open questions

- **PM ratification required before PR-B builds:** incremental-update
  export (file-format change: append log + compaction + recovery rules) vs
  worker-thread export (threading change, binding transferability to verify) —
  a persistence-contract decision, presented with measurements at the
  one-pager.
- PR-A's `affectsMemory` verdict transport (operation metadata vs a
  guard-to-listener side channel keyed by operationId) is the dev's call; the
  bound is one classifier, not two. Likewise the `MemoryMutationIndex`
  bootstrap (built once from the full scan at startup, then incremental).
