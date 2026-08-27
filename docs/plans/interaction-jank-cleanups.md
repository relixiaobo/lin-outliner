# Interaction Jank Cleanups

**Shape:** (b) a SET of four independent complete features, each its own PR —
the 2026-08-11 plan review correctly flagged that two of these are mechanism
changes, not small cleanups, and must not ride a bundle:

- **PR-1 chrome scroll batching** (items 1, 2, 3, 8 — genuinely small, bundled)
- **PR-2 semantic caches** (items 4, 6)
- **PR-3 translation geometry** (item 5 — a scheduling-mechanism change)
- **PR-4 search index reuse** (item 7 — a data-structure change)

## Goal

Remove per-scroll-event forced layouts and per-delta scans in interaction
chrome — costs that fire during scrolling, menu use, and launcher/search use.
Verified items (2026-08-11 audit):

1. **`useAnchoredOverlay`** (≈20 consumers: menus, tag/date pickers, column
   menus, floating toolbar, `TriggerPopover`): a capture-phase `scroll`
   listener on `window` fires for scrolling anywhere in the app; `update` reads
   `getBoundingClientRect` + `scrollHeight`/`offsetHeight` un-batched and calls
   `setStyle` with a fresh object literal — the open overlay re-renders on
   every scroll event even when its position did not change, and the
   read-after-write cycle forces reflow.
2. **Panel title-dock measurement**: `handlePanelScroll` (used by `NodePanel`
   and `FilePreviewPanel`) calls `updateTitleDockedState` synchronously per
   scroll event (`offsetTop`/`offsetHeight` reads) even though the rAF-wrapped
   `requestTitleDockMeasure` already exists and is used everywhere else.
3. **Per-view window capture scroll listeners**: every mounted
   `OutlinerFlatView`/`OutlinerTableView` registers its own capture-phase
   `window` scroll listener; scrolling *any* surface schedules scroll-metric
   work (2× `getBoundingClientRect` + `clientHeight`) in **every** mounted
   view, N panels wide.
4. **`tableFieldChoices`** (`OutlinerTableView`) and
   `buildDefinitionTagOptions` (`DefinitionConfigPanel`): full
   `projection.nodes` proxy-array scans + locale sort, memo-keyed on
   `props.index` — recomputed on every projection delta for data that only
   changes when a `fieldDef`/`tagDef` changes.
5. **Translated-preview scroll scan**: `handleViewportScroll` (URL page and
   EPUB translation adapters) triggers the controller's `nextBatch`, which does
   an O(all blocks) `getBoundingClientRect` pass — hundreds of rect reads per
   scroll event on a long article, with no rAF/throttle between scroll and
   scan. (The request side is properly batched and capped; the geometry scan is
   the cost.)
6. **`ActionInvocationService.actionProjection`** caches by projection identity.
   `OutlineDocumentService.liveProjection()` returns its current snapshot's
   stable projection object until a Runtime Event installs the next revision, so
   the invalidation key is sound. The remaining candidate is only the repeated
   cache lookup inside per-hit mapping and the separate `projection.nodes` walk
   in `rankedMoveToCandidates`; measure before changing either.
7. **Runtime selector indexing**: every `find` request forks the current Core
   projection and constructs a new `OutlineSelectionIndex`. Its text index is
   lazy, so startup pays nothing, but the first textual selector in every request
   runs `buildTextSearchIndex` again. Repeated launcher and Agent searches thus
   rebuild an O(document) index at the same Runtime revision — the current form
   of the former P3-11/12/13 search-reuse work.
8. **`useWorkspaceKeyboard`** re-subscribes the window `keydown` listener per
   projection delta (effect deps include `index`/`ui` that the handler already
   reads through `latestStateRef`).

## Non-goals

- No user-visible behavioral change: menu/overlay anchor semantics, which
  blocks get translated and when (parity list in PR-3), and search ranking all
  stay identical — PR-3 and PR-4 change mechanisms, never outcomes.
- The typing hot path, agent streaming, and startup are separate plans.

## Design

Per item, the smallest fix that removes the cost:

1. `useAnchoredOverlay.update` runs through one shared rAF (coalescing all
   scroll/resize triggers per frame); `setStyle` bails when the computed style
   is shallow-equal; and the listener filters by **event target**, not by rect
   comparison — an "early bail when the rect is unchanged" cannot meet the
   bound, because reading the rect IS the forced layout being removed. Keep one
   capture listener but return immediately unless the scrolled target is a
   scroll parent of the anchor (a `contains` walk over cached ancestors, no
   geometry read); `window`/viewport scrolls still pass.
2. `handlePanelScroll` routes the dock measurement through the existing
   `requestTitleDockMeasure`.
3. One module-level scroll dispatcher: a single capture listener that
   dispatches to registered views only when the scrolled target lies inside
   that view's scroller (a `contains` check before any geometry read).
4. Key both option caches on a definition-relevant revision (fieldDef/tagDef
   membership), not on `index` identity — same pattern as the shipped selector
   caches, with the key fixed to survive unrelated deltas.
5. Translation geometry needs a mechanism change, not a hoist: "read rects only
   inside the priority window" is circular, because the priority window is
   itself computed from a full rect pass. Replace the per-scroll full scan with
   observed visibility — an `IntersectionObserver` (or maintained viewport
   buckets keyed by layout position) keeps a near-viewport candidate set
   incrementally, and `nextBatch` reads rects only for that set. The mechanism
   must handle: far scrollbar jumps (observer callbacks re-seed the set),
   dynamically inserted/removed blocks (observe on insert, unobserve on
   remove), and preemption of an in-flight batch when the viewport moves away —
   all behaviors the current full-scan approach gets for free and the
   replacement must not lose.
6. Preserve the stable projection-identity key supplied by
   `OutlineDocumentService`; hoist the cached projection out of repeated mapping
   only if the probe shows meaningful overhead. A regression test holds one
   Runtime revision constant across calls and proves the whole-document `byId`
   build occurs once, then proves the next delivered revision invalidates it.
7. Give the Runtime workspace one revision-keyed `OutlineSelectionIndex` reused
   across read requests. Its immutable projection map, document order, Trash
   ancestry facts, and lazy text index remain valid only for that exact revision;
   a committed Event swaps the cached index rather than mutating one observed by
   an in-flight request. Query-specific virtual condition/operand nodes stay in a
   small per-evaluation overlay so shared base maps remain immutable.
8. Drop the unnecessary effect deps; the handler already reads live state
   through `latestStateRef`.

## Verification

- Unit where the fix is a cache: revision-keyed hit/miss tests (items 4, 6, 7);
  for item 7, repeated Runtime reads at one revision share the selection/text
  index, the next revision replaces it, and a query with rule conditions resolves
  virtual nodes through an overlay while the shared base is unmutated.
- PR-3: translation behavior parity tests — far scrollbar jump translates the
  landing viewport, inserted blocks get observed, moving away preempts the
  in-flight batch; plus the geometry-scan counter bound (rect reads per scroll
  ≤ candidate-set size, not total blocks).
- DevTools performance trace (manual): scrolling a long outline with a menu
  open shows no forced-reflow warnings from overlay/panel/table code paths;
  numbers in the PR body (A9).
- Existing outliner/table/launcher/translation suites stay green — every change
  is cost-only.

## Open questions

- PR-3's candidate-set mechanism (IntersectionObserver vs maintained viewport
  buckets) is the dev's call; the bound is no O(all blocks) rect pass on the
  scroll path and no lost behavior from the parity list above.
