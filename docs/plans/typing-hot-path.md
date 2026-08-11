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
  reserved-tagged ids, active tag definitions, and generated ids. Its update
  rules split by what the data is: **membership sets** (owned / protected /
  reserved-tagged / generated) update from operations whose verdict was
  `affectsMemory` plus the memory pipeline's own writes — but **classification
  inputs** update from EVERY committed sparse delta, because the classifier
  reads them to judge the NEXT command: `commandUsesReservedTag` resolves
  by-name tag creation/paste against all active tag definitions, so an
  ordinary tagDef rename or trash move — itself `affectsMemory=false` — still
  changes what a later command resolves to. Gating those inputs on
  `affectsMemory` would drift the index; the per-delta update is O(changed)
  (a tagDef appears in the delta exactly when it changes). Only digest and
  wake are gated on the verdict. The guard answers a text patch with O(1)
  lookups against the index. The index is
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
  projection changes without a verdict take the conservative path. The
  verdict's **lifecycle spans every notification of its operation**: a text
  patch's `operationId` fires again when `flushTextEditGroupNow` emits its
  end-of-group (empty) projection event, so a consume-once verdict would send
  that second event down the conservative full-graph path, and a never-expiring
  one would leak — the verdict lives until the operation's group closes, and
  empty deltas skip graph work outright. What defers
  is ONLY the digest and the wake: `canonicalGraphDigest` computation and the
  pipeline wake move to a debounced idle timer (~500 ms) or the pipeline's own
  wake points. The generated-node **ownership reconciliation** (fingerprint
  comparison → `markNodeUserAuthoritative`) does NOT defer — it completes
  before the memory write gate releases, so a pipeline write can never act on
  stale ownership of a node the user just edited. Synchronous does NOT mean
  full-graph: today the reconciliation builds the whole canonical graph to
  fingerprint one node, so the `MemoryMutationIndex` additionally stores each
  canonical node's fingerprint inputs (category, `sourceDate`, `parentKey`,
  tags, text — the exact `memoryNodeFingerprint` surface). Those inputs are
  DERIVED from ancestry: a day-node rename changes `sourceDate` for every
  generated descendant, a container move changes `parentKey`, an ancestor
  entering Trash changes graph membership — none of which put the descendants
  in the sparse delta. The index therefore maintains the reverse-dependency
  closure (ancestor → dependent generated records) and reconciliation runs
  over **all affected generated records** — O(affected), not O(one) and not
  O(all generated). The zero-full-graph-build guarantee covers ALL text
  patches, **including patches to owned/generated nodes**. `memory:*` self-publications
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
- **Bound the serialize cost — PM-ratified 2026-08-11: incremental
  update-export append log.** Measured on the real production document (314
  nodes, 415 KB envelope): a full-snapshot serialize emits 373 KB in ~3 ms
  warm (15 ms cold) and grows with total edit history — the envelope is
  oplog-dominated, so heavy use inflates even a small document — while an
  update export from the persisted version is 22 bytes in ~0.1 ms and stays
  O(changed) forever. The ratified shape: each save appends
  `doc.export({ mode: 'update', from: lastPersistedVersion })` to a log
  alongside the snapshot; idle/threshold **compaction** rewrites the snapshot
  and truncates the log on the saver's schedule (never inside the typing
  rhythm); **crash recovery** reads the snapshot and replays the log,
  discarding a torn tail — the same pattern `RolloutStore` ships hardened.
  Worker-thread export was evaluated and REJECTED as degenerate: the Loro doc
  lives on the main thread, so a worker either structured-clones the full
  state per save (the O(N) cost stays on main) or maintains an incremental
  mirror (this option's plumbing plus a second-instance drift risk). This
  also closes the snapshotted-tier capture question: capture IS the
  incremental export, O(changed) by construction.
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
  drains by awaiting the latest revision's ack.
- **Three ack tiers — trusted transactions keep their durability contract.**
  The handoff has three acknowledgement levels: *accepted* (the mutation
  marked the document dirty at a persistence revision — immediate and
  O(changed); **this is what ordinary UI mutations return at**), *snapshotted*
  (the saver captured a consistent state covering that revision — an internal
  pipeline milestone that runs on the saver's cadence, never per keystroke —
  under the ratified persistence option, capture IS the incremental
  `export(update)` from the last persisted version: O(changed) by
  construction, with compaction's full-snapshot rewrite confined to the
  saver's schedule; the accepted → snapshotted main-thread work is still
  measured separately as acceptance evidence), and *durable* (bytes
  on disk). A mutation
  never waits for snapshot capture — an "ordinary mutations return at
  submitted" reading would smuggle the coalescing wait back into the
  keystroke. **Trusted document-system transactions are an
  explicit exception**: today `runMutation` awaits `saveCore()` inline when a
  `systemContext` is present, and the spec requires the transaction to resolve
  only after the workspace bytes are durable — the memory control plane's
  SQLite finalization must never precede the document write, or a crash leaves
  the stores disagreeing. Those transactions (and the memory write gate)
  therefore await the *durable* ack. Acceptance bound, scoped accordingly: no
  **ordinary** keystroke mutation ever waits on an O(document) serialize or on
  the file write; trusted-transaction latency is deliberately unchanged.
- **Spec closure (A6), shipped in the same PR.** PR-B overturns contracts the
  specs state today, and each must be rewritten with the behavior: the
  `docs/spec/commands.md` convention "every mutating command persists the
  workspace snapshot before returning" (becomes the accepted/durable tier
  contract), the `docs/spec/architecture.md` persistence/coalescing
  paragraphs (700 ms window, forced flush points, before-quit flush), and the
  `docs/spec/launcher.md` quit-flush note (the two-phase quit replaces the
  exit-after-flush description).
- **Fix the text-search map clone — with the before-state preserved.** The
  delta refresh legitimately reads BOTH generations: deletions collect
  descendants from the previous map, and Trash-boundary changes compare
  previous against next. In-place mutation would make them the same object and
  leave a trashed ancestor's unchanged descendants indexed. `textSearchNodes`
  therefore becomes an immutable structurally-shared map (or generational COW)
  where producing the next generation is O(changed) while the previous
  generation stays readable until the refresh completes. Tests cover the
  semantic cases — a subtree crossing the Trash boundary, a parent deletion
  pruning descendants, tagDef/fieldDef/reference-dependent refreshes — not
  merely a no-copy counter.
- **Quit policy (PM-ratified 2026-08-11): a failed save blocks quit — via a
  two-phase state machine, not a patch on the current handler.** Today's
  `before-quit` latches `quitAfterFlush = true`, unregisters hotkeys, disposes
  services, and starts closing agent services BEFORE the drain result exists —
  cancelling from there would leave a half-torn-down app, and the latch makes
  a second ⌘Q bypass the drain entirely (`if (quitAfterFlush) return`). The
  redesign: **Phase 1 is reversible** — nothing is torn down; the document
  drains toward the durable ack under the deadline. The drain is a
  **linearizable revision barrier**: with saves off the mutation queue and
  services still live, new mutations can arrive after a drain target is
  chosen, so Phase 2 entry requires `durableRevision ≥ latestAcceptedRevision`
  checked atomically — either mutation admission freezes at the barrier, or
  the drain loops until the check holds at the moment of transition; an app
  must never exit with a newer accepted revision than the one it persisted.
  Only that established barrier enters **Phase 2** — irreversible teardown
  (hotkeys, services, agent close) and exit. A failed/timed-out drain with dirty state resets the latch, keeps
  every service live, and surfaces the persistent Retry / Quit-anyway choice;
  a second ⌘Q while dirty re-enters Phase 1, never bypasses it. The
  bounded-timeout exit remains for non-document flushes inside Phase 2, so a
  wedged auxiliary flush still cannot hold the process hostage.

### PR-C — renderer keystroke commit cost (renderer)

- **Semantic revisions where they work, per-node incrementality where they
  don't.** The global projection revision bumps on every delta — and typing a
  picker query is itself a document mutation — so any cache keyed on it misses
  on exactly the keystrokes it exists for. But a coarse "presentation revision"
  fed by titles has the same trap: the node being edited changes title every
  keystroke, bumping the revision globally. So the split is: narrow
  **structural** revisions maintained from the applied `ProjectionUpdate` delta
  — a tag-definition revision, a trash-membership revision, and a
  **referenceGraphRevision** defined on **edge signatures** (source id,
  target id, `refRole`, source parentage, search/query ancestry) and NEVER on
  full `inlineRefs` values: inline-ref offsets shift whenever text is inserted
  before a ref, so an offset-sensitive revision would bump on exactly the
  keystrokes it must ignore (`nodeReverseKeys` already compares target ids
  only — the precedent to follow) — for the facts that change rarely; and
  **per-node incremental maintenance** for the facts that change per keystroke
  (titles, `updatedAt`): caches patch the changed nodes' entries in place
  rather than invalidating globally.
- **`referenceSummary`:** maintained incrementally — `buildReferenceSummary`
  depends on far more than titles (reference edges, `refRole` backlink
  eligibility, source-parent and search-ancestry resolution, trash state), so
  its cache patches entries from changed ids and rebuilds only on
  referenceGraphRevision / trash-revision changes. The WeakMap-on-`byId` key is
  the bug: `byId` changes identity per delta by design. **Scope note — the
  expanded-Backlinks path is separate and stays O(N) for now:**
  `referenceSummaryForExpandedTarget` runs `includeUnlinked` full-corpus text
  matching, a dependency set (every node's text/description) no incremental
  reference cache covers. This PR does NOT claim O(changed) for it; instead it
  moves that recompute off the synchronous keystroke commit (deferred/debounced
  refresh of the expanded section, linked references still update immediately
  via the incremental summary). Deferring is not enough on its own —
  `buildReferenceSummary` is one synchronous full-document loop, so whenever
  the debounced scan DOES run it would still block the renderer for its whole
  duration; the deferred scan therefore runs cooperatively (chunked with
  yields, or in a worker), and typing while a scan is in flight must stay
  responsive. The worker option carries its own trap: posting the full
  `DocumentIndex`/Map does the structured-clone serialization ON the sending
  thread — an O(N) jank relocated, not removed. A worker path must feed from
  an incrementally maintained mirror (delta messages) or a transferable
  representation built in bounded batches, and the responsiveness probe
  measures from BEFORE task submission. A true incremental mention index is an explicit follow-up, not
  this PR. The deferral is a user-visible freshness change with its own
  acceptance contract: linked references update
  immediately; unlinked mentions refresh debounced; a stale computation never
  overwrites a newer one (generation-checked); collapsing the section or
  switching targets cancels pending work; and the References freshness
  paragraphs in `docs/spec/ui-behavior.md` update in the same PR (A6).
- **Decouple the agent dock from irrelevant document deltas.** The transcript
  cannot be permanently severed from the index — `threadNodeReferenceStyle`
  and reference labels legitimately read node titles/colors, which must stay
  fresh. Pass the index through a stable read-at-render accessor (ref/context)
  so `DocumentIndex` identity stops being a memo input, and re-render reference
  chips off a per-node-id subscription so a rename/recolor still propagates
  (a global revision would bump per keystroke via the edited node's title).
  The subscription covers the **derived color chain**, not just the target
  node: a chip's color resolves target → `tags[0]` → tagDef → defConfig →
  value child text, so a tagDef/defConfig edit recolors chips whose target
  never changed — subscribe through the same reverse-dependency closure the
  row renderer uses (`ReverseEdges`/`propagateDirty`), not on the target id
  alone. And the subscription surface is **every index-derived transcript
  leaf, not chips alone**: tool-activity segments and subjects
  (`threadToolActivitySegments`), the process-header summary
  (`threadProcessSummary`), and any other label resolution read the index too —
  chip-only subscription would leave tool summaries and headers showing stale
  titles after a rename. Event-driven reads (the copy actions) take the
  accessor's latest value at click time instead of subscribing.
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
  Queries resolve against a posting index that serves the EXISTING contains
  semantics at **every query length** — mid-word substrings, one- and
  two-character queries, single CJK characters (`rankTextSearchLabel` is plain
  substring matching today, and none of that narrows) AND locates **exact
  full substrings with a bounded result**: a fixed 1..3-gram intersection is
  not enough on its own — for a query like `abcd`, arbitrarily many labels
  containing `abc` and `bcd` but never `abcd` intersect as false positives,
  and verifying them degenerates to O(N). The structure must resolve the
  complete substring (suffix-array/suffix-automaton postings, or n-grams with
  positional verification whose false-positive work is itself bounded) and
  return bounded DISTINCT node ids. It yields a **bounded candidate set**
  without enumerating all nodes. Semantics are the PM-ratified **shortlist
  contract** (2026-08-11): exact global top-24 equivalence cannot be bounded —
  the real composite ordering is text rank → disabled → untitled → context
  rank → label length → `updatedAt` → label, an empty query ties every node on
  text rank, and the cycle-disable check (`canReachInDisplayGraph`) walks the
  whole display graph — so the picker returns a deterministic shortlist
  instead: retrieval by text-rank tiers from the label index (an
  `updatedAt`-ordered list serves the empty query), a hard visit bound, and
  the full tie-break chain applied within the retrieved set only.
  Rank-completeness still holds — no excluded candidate has a better text
  rank than any included one — and disabled/cycle states are computed only for
  the shortlist. That is necessary but not sufficient: each cycle check
  (`canReachInDisplayGraph`) is itself a full display-graph DFS, so 24
  shortlist members could still cost 24 × O(N) per keystroke. The reachability
  answer is therefore cached — a reverse-reachable set, or an equivalent
  bounded reachability index — so the per-keystroke bound covers **graph nodes
  visited**, not merely cycle-check invocations. Two contracts the cache must
  state: (1) **invalidation keys on display-graph adjacency, not reference
  edges alone** — the DFS walks ordinary content-child edges too, so a pure
  content subtree move changes reachability without touching a reference
  edge; the key combines the structure (parent/children) revision with
  referenceGraphRevision; (2) **cold builds never run on the input event** —
  first popover open or a post-invalidation rebuild constructs the set
  cooperatively (or precomputed off-thread), so the O(N) build cost cannot
  land inside a keystroke. The visible difference is confined to deep ties (which
  equal-rank peers fill the tail); top results for real queries are
  text-rank-dominated and unchanged. Breadcrumb presentation is computed
  lazily for the final bounded results at render time, never stored per node —
  an ancestor rename therefore cannot invalidate descendants' cached entries.
  Full rebuild only on
  referenceGraphRevision / trash / tag-definition changes. Share one
  trash-descendant set per trash revision (the precomputed-Trash-set precedent
  from the perf program) instead of per-candidate ancestor walks with `Set`
  allocations.
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
  dependencies** (sort field ids, filter-rule fields, group field) — and the
  intersection runs against the **derived-dependency closure, not the raw
  changed fields**: a reference row's display value reads its TARGET node
  (`displayNode`), and an empty-title parent's Name derives from descendant
  text, so a target rename changes a sort value on rows whose own fields never
  appear in the delta. The existing `ReverseEdges`/`propagateDirty` machinery
  in `renderRev` already encodes this propagation for render dirtiness —
  reuse it to expand the changed-id set to the effective changed-field set
  BEFORE intersecting. Disjoint → in-place row update; intersecting →
  invalidate and rebuild the affected branch, same as a structural change.
  Invalidation rules per trigger are stated in the PR.
- **`CodeBlockRow`:** debounce re-highlighting (~150 ms). The text itself lives
  in the editor; the highlight is decoration and may lag a beat.
- **Spec closure (A6), shipped in the same PR.** PR-C's user-visible changes
  land in the specs: the `@` picker's ratified shortlist semantics (wherever
  the picker's behavior is specified — `docs/spec/ui-behavior.md`, and the
  launcher spec if its picker shares the path) alongside the References
  freshness paragraphs already listed above.

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
  node still authorizes and reconciles ownership synchronously **without a
  full graph build (counter covers the owned/generated case too)**;
  ancestor-derived reconciliation cases — a day-node rename, a container move,
  an ancestor entering Trash — reconcile every affected generated descendant,
  asserted on the **control-store outcomes** (ownership flips, removals), not
  merely on the pipeline wake; the verdict survives the end-of-group empty
  projection event (graph-build counter checked after the group flush fires,
  with empty deltas doing zero graph work). Transaction
  cases: a multi-command transaction whose later commands depend on earlier
  ones' membership changes authorizes identically to the full-scan guard, the
  overlay folds on commit, and a rolled-back transaction leaves the base index
  byte-identical (commit/rollback equivalence). Classification-input case: an
  ordinary tagDef rename or trash move (verdict `affectsMemory=false`)
  followed by a by-name tag create/paste classifies identically to the
  full-scan guard.
- Unit, PR-B: a text-patch burst performs no synchronous save inside
  `runMutation` and never queues behind an in-flight file write; sustained
  typing past the max-wait still checkpoints (fake clock); a failed background
  save keeps the dirty revision, retries, and surfaces — never a silent drop;
  `before-quit` drains to the latest revision's ack; a trusted document-system
  transaction still resolves only after the durable ack (the cross-store
  ordering test: SQLite finalization never observed before the workspace
  write); the search-refresh map is not copied per patch (counter) AND the
  generational structure passes the semantic cases — Trash-boundary subtree
  crossing, parent deletion pruning descendants, tagDef/fieldDef/reference
  dependent refreshes — with before-state reads intact; quit state machine —
  clean state quits fast, a dirty-state deadline cancels into the Retry /
  Quit-anyway surface with hotkeys and services still functional (nothing torn
  down in Phase 1), and a second ⌘Q while dirty re-enters the drain rather
  than bypassing it via the latch; a mutation injected DURING the drain moves
  the barrier — the app exits only once `durableRevision ≥
  latestAcceptedRevision` holds atomically at Phase 2 entry.
- Unit, PR-C: incremental-maintenance equivalence tests — patched
  referenceSummary / candidate-index state equals a from-scratch build across
  a mutation corpus (`tests/renderer`); a candidate-visit upper-bound test —
  a picker query touches at most O(bounded results) candidate entries, never
  all nodes (counter); **shortlist-contract tests** — the visit bound holds on
  every query including the empty and universal-match ones,
  rank-completeness holds (no excluded candidate out-ranks an included one),
  ordering is deterministic across runs, disabled/cycle computation is
  invoked only for shortlist members, AND the per-keystroke bound counts
  **graph nodes visited by reachability checks**, not merely invocations
  (cached reverse-reachable set); **query-length coverage tests** — one-char,
  two-char, single-CJK-character, mid-word substring, AND long queries over a
  corpus dense in shared-gram false positives (labels containing every 3-gram
  of the query but never the query itself) all retrieve through the posting
  index with results matching contains semantics inside the visit bound;
  **reachability-cache tests** — a cold cache builds off the input event
  (first-open keystroke latency unaffected) and a pure content subtree move
  (no reference edge touched) invalidates reachability; an **edge-signature test** —
  inserting text before an inline ref (offset-only change) does not bump
  referenceGraphRevision; **expanded-Backlinks freshness tests** — linked
  updates immediate, unlinked debounced, stale generation never overwrites
  newer, collapse/target-switch cancels, and typing while an unlinked scan is
  in flight stays responsive (the cooperative scan yields — this scenario
  joins the A9 probe run with an expanded References section); a transcript
  fixture that asserts no
  `ThreadTurnView` re-render on a document-only index change AND zero
  transcript renders per document delta while the rail is closed (suspension
  must remove the work, not merely survive it); rail close→reopen preserves
  composer draft, staged attachments, and scroll position; **rename/recolor
  regressions across every index-derived leaf** — a node rename refreshes
  reference chips, tool-activity subjects, and the process header, and a copy
  action after a rename copies the new title (accessor read at click time);
  patched visual-row
  model equals a from-scratch `buildVisualRows` across sort/filter/group/
  reference mutations — including sort/filter/group **parity under typing**:
  editing Name, Updated-relevant content, a custom field value that feeds the
  active sort/filter/group, and renaming a reference target must each move,
  regroup, or re-filter rows identically to a full rebuild.
- **Probe (A9):** `renderProbe` typing latency on the large test document,
  before/after each PR, with the agent rail open and a Subagent streaming —
  numbers recorded in each PR body.

## Open questions

- ~~PM ratification required before PR-B builds~~ — ratified 2026-08-11:
  incremental update-export append log with compaction (measurements in the
  PR-B design above). PR-B is unblocked; compaction thresholds are the dev's
  call within the stated bounds.
- PR-A's `affectsMemory` verdict transport (operation metadata vs a
  guard-to-listener side channel keyed by operationId) is the dev's call; the
  bound is one classifier, not two. Likewise the `MemoryMutationIndex`
  bootstrap (built once from the full scan at startup, then incremental).
