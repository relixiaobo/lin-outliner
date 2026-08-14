# Agent Streaming Follow-ups

**Shape:** (a) ONE complete feature in one PR — a bounded cost-cleanup pass on
the same pipeline PR #525 (`agent-streaming-delta-pipeline`) hardened, building
on it now that it has merged.

## Goal

Remove the four remaining per-delta / per-tick costs on the streaming path that
the delta-pipeline plan did not cover (found by the 2026-08-11 performance
audit):

- **`ThreadCore.requireThread` per recorded notification.** Every notification
  — after coalescing, still tens per second across streams — falls through to
  `ThreadMetadataStore.require`: an uncached `SELECT * FROM threads` plus
  `recordFromRow` (2–3 `JSON.parse` + full `decodeThread` + `deepFreeze`).
- **Streaming markdown re-lexes the full text.** `ThreadMarkdown` throttles
  commits to 80 ms, but each commit runs `remend` and `Lexer.lex`
  (`splitMarkdownBlocks`) over the **entire** accumulated message — O(full
  text) per commit, quadratic over a long answer's life.
- **The active Turn re-renders all its items per notification.**
  `ThreadTurnView` is memoized, but inside a streaming Turn `ThreadItemView` is
  not, and `projectSubagentsForTurn` + `groupTurnContent` recompute per
  notification — a research Turn with dozens of tool items re-renders them all
  on every merged delta.
- **The Subagent elapsed ticker re-renders the nested transcript.**
  `useSubagentElapsedMs` ticks 1 Hz inside `SubagentActivityItem`, which
  renders `SubagentRunDetail` (a full nested `ThreadView`) in the same
  component — an expanded child transcript re-renders every second even when
  nothing streamed.

## Non-goals

- No change to the delta-pipeline design shipped by PR #525 (coalescing
  windows, overlay, group commit, store frame batching stay as specified in
  `docs/spec/agent-core.md`, where that plan's design was folded on merge).
- No markdown renderer swap; `MemoizedMarkdownBlock` block-level memoization
  stays the rendering unit.

## Design

- **Catalog record cache with centralized invalidation.** `ThreadMetadataStore`
  keeps a small per-thread decoded-record cache. Invalidation is NOT a list of
  known setters — name writes alone have three independent paths (manual,
  automatic, clear) and the list would drift. Instead every catalog mutation
  funnels through one internal write helper that updates/invalidates the cache
  as its last step; a test enumerates the store's public mutators and asserts
  each one invalidates. `requireThread` on the notification path becomes a Map
  hit.
- **Incremental tail lexing — with the definition caveat.** A pure append does
  NOT only change the last block: `splitMarkdownBlocks` folds the full
  reference-definition set (`def` tokens) into **every** visible block, so an
  appended `[ref]: url` definition changes all of them. The incremental path
  caches the previous commit's `(text, blocks, definitions)`: when the new text
  extends the old, re-lex from the start of the previous last block; if the
  tail lex leaves the definition set unchanged, reuse the earlier blocks
  verbatim — if the definition set changed, fall back to a full lex (rare and
  worth paying). Also fall back when the text did not extend the cache (edit,
  reset). `remend` runs on the tail slice only. (Restructuring definitions into
  a layer passed to blocks separately would remove the caveat entirely; the
  dev may choose it if the fallback proves frequent in practice.)
- **Memoize the streaming Turn's items — props first, memo second.** Item
  objects DO keep identity across deltas for all but the item receiving the
  delta (`updateItemDelta` replaces only the target), but a bare
  `memo(ThreadItemView)` would still miss every notification: several
  `ThreadTurnView` callbacks take the whole `turn` as a `useCallback` dep (new
  identity per delta), and the recomputed `subagents` projection flows into
  every item. Note the `items` ARRAY identity also changes per delta (the store
  maps a fresh array), so keying a helper memo on `turn.items` would miss every
  time too — array-keyed `useMemo` is not the mechanism. Order of work: (1)
  re-key the callbacks on `turn.id` with the live Turn read through a ref; (2)
  make `projectSubagentsForTurn` / `groupTurnContent` incremental via pairwise
  identity diffing: each keeps its previous `(inputs, perItemResults, result)`;
  on a new array it walks pairwise object identities (pointer compares only) —
  an unchanged item reuses its previous projected object (identity-stable
  output), a changed item recomputes alone, and group boundaries rebuild only
  when a grouping-relevant field (type/status/membership) changed. The
  subagent-presentation cache is **two layers**, because its inputs are not the
  items alone:
  - *Per-child base layer* — one entry per related child, keyed on the child
    Thread record identity, its `latestTurnByThread` entry, and the parent
    items that evidence it. A child-only change recomputes exactly that
    child's base entry.
  - *Collection layer* — the projection work that is irreducibly
  collection-scoped and must recompute whenever its own inputs change, not
  per child: **eligible Agent-child membership**, derived from canonical Agent
  lineage and execution status (a newly admitted child can arrive through
  catalog/Turn notifications before any parent Item changes, so the membership
  set is itself a key); the **parent Turn's presentation fields**
    (`livePresentationState` reads the parent's status and `startedAt`, so
    parent settlement changes rows with no item or child-entry change); and the
    **display-name collision set** (`disambiguateDisplayNames` ordinal-numbers
    duplicates across all children, so one child's join/rename/removal renames
    same-named siblings). The collection layer is O(children) counting over
    cached base entries — cheap — and it applies ordinals compare-and-reuse, so
    a child whose final display name did not change keeps its identical
    presentation object.
  A text delta then re-projects exactly the one changed item — and the one
  group block containing it — with zero recomputation of unchanged items; (3) only then
  `memo(ThreadItemView)`, with a render-count test proving the memo actually
  hits during a streamed delta.
- **Isolate the ticker — the whole header, not just a span.** The elapsed value
  also feeds the row's `aria-label` and `title`, so extracting only a visible
  text span would leave assistive text stale. Extract the complete row
  header/button subtree (label, `aria-label`, `title`) into a leaf component
  that owns `useSubagentElapsedMs`; `SubagentActivityItem` no longer holds
  ticking state above `SubagentRunDetail`, so the 1 Hz tick repaints the
  header only — accessibility stays fresh and the nested transcript stops
  re-rendering per second.

## Verification

- Unit (`tests/core`): counter test — N recorded notifications for one thread
  perform one metadata SELECT; a metadata write invalidates the cache.
- Unit (`tests/renderer`): `splitMarkdownBlocks` incremental path — appending
  text yields blocks identical to a from-scratch lex across a corpus of
  markdown shapes (headings, fences, tables, footnote defs — the `def`
  redistribution path in particular); a non-append change falls back correctly.
- Unit (`tests/renderer`): a delta to one item re-renders only that
  `ThreadItemView` (probe/counter fixture); AND helper-level counters — a text
  delta re-projects exactly ONE item (and rebuilds only its group block) with
  zero recomputation of unchanged items, which keep identity-stable
  presentation objects (a render-count assertion alone cannot catch helper
  recomputation, so both are asserted); AND a child-only change (child Thread
  status/latest-Turn update with parent items untouched) refreshes exactly the
  items referencing that child — no stale nickname/status/duration, no
  recomputation of unrelated items. Collection-layer cases: a newly admitted
  Agent appearing through canonical lineage/status shows up without any parent
  Item change; the parent Turn settling with unchanged items updates every row's
  live state; a same-named child joining, renaming, and being removed each
  renumber exactly the colliding siblings (and children whose final display
  name is unchanged keep identity-stable presentation objects). The elapsed
  tick does not re-render the nested transcript fixture.
- **A9 manual:** long streaming answer (100 KB+) with an expanded Subagent row —
  renderer CPU before/after, recorded in the PR body.

## Open questions

- None; every change is behavior-preserving with a measurable bound.
