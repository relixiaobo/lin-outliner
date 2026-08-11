# Interaction Jank Cleanups

**Shape:** (a) ONE PR bundling small, independent, individually-complete fixes
(the established pattern for cleanup batches). Any item can be dropped from the
bundle without affecting the others.

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
6. **`ActionInvocationService.actionProjection`** cache compares
   `this.host.projection()` by identity, but `liveProjection()` returns a new
   object every call — the cache can never hit, and it is invoked inside the
   per-hit map of a launcher query (up to 8 full projection + `byId` builds per
   query). `rankedMoveToCandidates` re-walks `projection.nodes` the same way.
7. **`nodeRetrievalService` / `searchNodeText`**: every `search_nodes` and
   launcher retrieval rebuilds the search-document index
   (`new Map(allNodes.map(...))` + trash-descendant set + a defensive clone in
   `prepareSearchQueryEvaluation`) — the unshipped P3-11/12 items from the perf
   program, folded in here.
8. **`useWorkspaceKeyboard`** re-subscribes the window `keydown` listener per
   projection delta (effect deps include `index`/`ui` that the handler already
   reads through `latestStateRef`).

## Non-goals

- No behavioral change to any menu, overlay anchor semantics, translation
  scheduling policy, or search ranking.
- The typing hot path, agent streaming, and startup are separate plans.

## Design

Per item, the smallest fix that removes the cost:

1. `useAnchoredOverlay.update` runs through one shared rAF (coalescing all
   scroll/resize triggers per frame); `setStyle` bails when the computed style
   is shallow-equal; the scroll listener attaches to the scroll parents of the
   anchor (plus `window`) instead of capture-everything, or at minimum bails
   early when the anchor's rect is unchanged.
2. `handlePanelScroll` routes the dock measurement through the existing
   `requestTitleDockMeasure`.
3. One module-level scroll dispatcher: a single capture listener that
   dispatches to registered views only when the scrolled target lies inside
   that view's scroller (a `contains` check before any geometry read).
4. Key both option caches on a definition-relevant revision (fieldDef/tagDef
   membership), not on `index` identity — same pattern as the shipped selector
   caches, with the key fixed to survive unrelated deltas.
5. Coalesce translation geometry scans to one per animation frame and bound the
   scan to viewport-adjacent records (the controller already tracks priority;
   hoist the rect read behind the priority window).
6. Key `actionProjection` on the document revision token (exposed by
   `DocumentService`) instead of object identity, and hoist the call out of the
   per-hit map.
7. Cache the prepared search index on the same revision token; drop the
   defensive clone in `prepareSearchQueryEvaluation` in favor of a frozen
   structure.
8. Drop the unnecessary effect deps; the handler already reads live state
   through `latestStateRef`.

## Verification

- Unit where the fix is a cache: revision-keyed hit/miss tests (items 4, 6, 7).
- DevTools performance trace (manual): scrolling a long outline with a menu
  open shows no forced-reflow warnings from overlay/panel/table code paths;
  numbers in the PR body (A9).
- Existing outliner/table/launcher/translation suites stay green — every change
  is cost-only.

## Open questions

- Item 1's listener scoping (scroll-parents vs early-bail) is the dev's call;
  the acceptance bound is no overlay re-render and no rect read for a scroll
  that cannot move the anchor.
