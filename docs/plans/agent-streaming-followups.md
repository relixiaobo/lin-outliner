# Agent Streaming Follow-ups

**Shape:** (a) ONE complete feature in one PR — a bounded cost-cleanup pass on
the same pipeline PR #525 (`agent-streaming-delta-pipeline`) hardened, building
on it now that it has merged.

**Boundary (2026-08-14 restructure, PM-ratified).** This plan originally
carried four costs. Two of their subjects — `projectSubagentsForTurn`'s
presentation internals and the `SubagentActivityItem` / `SubagentStateItem` /
`SubagentRunDetail` component structure that hosts the 1 Hz elapsed ticker —
are replaced wholesale by the ratified `subagent-interaction` redesign, so
optimizing them here would be work against a mechanism about to be replaced
(A7). This plan keeps everything that survives that redesign. Toward the
subagent surface it establishes only an *output contract* — identity-stable
projection results — as a small bridge whose contract the redesign's Agent
registry inherits; the ticker isolation and the per-child/collection cache
semantics moved into `subagent-interaction` as requirements on its new
components. This PR lands before `subagent-interaction`.

## Goal

Remove the remaining per-delta costs on the streaming path that the
delta-pipeline plan did not cover (found by the 2026-08-11 performance audit;
every premise re-verified against the post-#531/#533/#535 tree on 2026-08-14):

- **`ThreadCore.requireThread` per recorded notification.** Every notification
  — after coalescing, still tens per second across streams — consults the
  ephemeral-thread map and then, for every durable Thread, falls through to
  `ThreadMetadataStore.require`: an uncached `SELECT` plus `recordFromRow`
  (full `decodeThread` plus `JSON.parse` of `status_json`,
  `configuration_json`, and `tool_ceiling_json`).
- **Streaming markdown re-lexes the full text.** `useStreamingMarkdownText`
  commits at most every 80 ms (`STREAMING_MARKDOWN_THROTTLE_MS`), but each
  commit runs `remend` and then `Lexer.lex` (`splitMarkdownBlocks`) over the
  **entire** accumulated message — O(full text) per commit, quadratic over a
  long answer's life.
- **The active Turn re-renders all its items per notification.**
  `ThreadTurnView` is memoized, but `ThreadItemView` is not, and inside a
  streaming Turn every merged delta recomputes `projectSubagentsForTurn` (a
  `useMemo` whose deps include the per-delta-fresh `turn`) and re-runs
  `groupTurnContent` unmemoized — a research Turn with dozens of tool items
  re-renders them all on every merged delta.

## Non-goals

- No change to the delta-pipeline design shipped by PR #525 (coalescing
  windows, overlay, group commit, store frame batching stay as specified in
  `docs/spec/agent-core.md`, where that plan's design was folded on merge).
- No markdown renderer swap; `MemoizedMarkdownBlock` block-level memoization
  stays the rendering unit.
- No caching or restructuring of `projectSubagentsForTurn`'s internals, and no
  touch to `SubagentActivityItem` / `SubagentStateItem` / `SubagentRunDetail`
  (the elapsed-ticker isolation): those subjects belong to
  `subagent-interaction`, which replaces them. The only thing this plan does to
  the subagent projection is reuse its *output* by identity (below).

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
  reference-definition set (`def` tokens) into **every** visible block
  (re-verified: the definitions string is appended to each visible token's
  raw), so an appended `[ref]: url` definition changes all of them. The
  incremental path caches the previous commit's `(text, blocks, definitions)`:
  when the new text extends the old, re-lex from the start of the previous
  last block; if the tail lex leaves the definition set unchanged, reuse the
  earlier blocks verbatim — if the definition set changed, fall back to a full
  lex (rare and worth paying). Also fall back when the text did not extend the
  cache (edit, reset). `remend` runs on the tail slice only. (Restructuring
  definitions into a layer passed to blocks separately would remove the caveat
  entirely; the dev may choose it if the fallback proves frequent in practice.)
- **Memoize the streaming Turn's items — props first, memo second.** The
  identity groundwork is better than this plan's first draft assumed, and is
  now verified: the store preserves item object identity across a delta
  (`updateItemDelta` maps a fresh array replacing only the target item), and
  `delegationCollapsedItems` pushes the **original** item objects through the
  projection — an unchanged item reaches render identity-stable today. What
  breaks per-item memoization is the props: several `ThreadTurnView` callbacks
  take the whole `turn` as a `useCallback` dep (`editUserMessage`,
  `continueInNewChat`, `copyTurn`, `handleResponseContextMenu` — while
  `readToolOutput` / `readToolArguments` already key on `turn.id`, the pattern
  to extend), and the recomputed subagent projection hands items a fresh
  `byThreadId` map each run. Note the `items` ARRAY identity also changes per
  delta, so keying a helper memo on `turn.items` would miss every time —
  array-keyed `useMemo` is not the mechanism. Order of work:
  1. Re-key the callbacks on `turn.id`, reading the live Turn through a ref.
  2. Make `groupTurnContent` incremental via pairwise identity diffing: keep
     the previous `(items, result)`; on a new array, walk pairwise object
     identities (pointer compares only), reuse unchanged group blocks, and
     rebuild only the block containing a changed item — group boundaries
     rebuild only when a grouping-relevant field (type/status/membership)
     changed.
  3. **Projection output reuse — a bridge, not a cache.**
     `projectSubagentsForTurn` keeps its previous result: after computing a
     new `byThreadId`, reuse the previous per-entry `SubagentPresentation`
     object when field-equal, and return the previous map object when every
     entry was reused. Entries are small value objects and `durationMs`
     records outcomes rather than a live clock (`livePresentationState`
     leaves running rows at `durationMs: null`; the ticking elapsed display is
     component state), so a delta that does not touch a child's state compares
     equal. The projection still recomputes internally per delta — O(items),
     acceptable at real item counts — this step fixes *identity*, in a
     dozen-odd lines deliberately ignorant of the projection's internals. The
     identity-stable-output contract it establishes is inherited by
     `subagent-interaction`'s Agent registry, which replaces those internals
     and retires this bridge.
  4. Only then `memo(ThreadItemView)`, with a render-count test proving the
     memo actually hits during a streamed delta.

## Verification

- Unit (`tests/core`): counter test — N recorded notifications for one thread
  perform one metadata SELECT; a metadata write invalidates the cache.
- Unit (`tests/renderer`): `splitMarkdownBlocks` incremental path — appending
  text yields blocks identical to a from-scratch lex across a corpus of
  markdown shapes (headings, fences, tables, footnote defs — the `def`
  redistribution path in particular); a non-append change falls back correctly.
- Unit (`tests/renderer`): a delta to one item re-renders only that
  `ThreadItemView` (probe/counter fixture); AND helper-level counters — a text
  delta rebuilds only the group block containing the changed item, with
  unchanged blocks reused by identity; AND projection output reuse — a text
  delta to a non-subagent item returns the previous `byThreadId` map by
  identity, and a child-state change replaces exactly that child's entry
  object.
- **A9 manual:** long streaming answer (100 KB+) — renderer CPU before/after,
  recorded in the PR body. (The expanded-Subagent-row half of the original
  measurement moved with the ticker work to `subagent-interaction`.)

## Open questions

- None; every change is behavior-preserving with a measurable bound.
