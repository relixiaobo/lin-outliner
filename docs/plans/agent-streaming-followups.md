# Agent Streaming Follow-ups

**Shape:** (a) ONE complete feature in one PR — a bounded cost-cleanup pass on
the same pipeline PR #525 (`agent-streaming-delta-pipeline`) hardened, building
on it after it merges.

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
  `docs/plans/agent-streaming-delta-pipeline.md`).
- No markdown renderer swap; `MemoizedMarkdownBlock` block-level memoization
  stays the rendering unit.

## Design

- **Catalog record cache.** `ThreadMetadataStore` keeps a small per-thread
  decoded-record cache (invalidated by that thread's own writes —
  `setPreview`/`setStatus`/`setModel`/`setArchived`/configuration writes — and
  by delete). `requireThread` on the notification path becomes a Map hit.
- **Incremental tail lexing.** `splitMarkdownBlocks` caches the previous
  commit's `(text, blocks)`: when the new text extends the old (the streaming
  case), re-lex only from the start of the previous **last** block (the only
  block a pure append can change — earlier block boundaries are final for
  appended input), reusing the earlier blocks verbatim. Fallback to a full lex
  when the text did not extend the cache (edit, reset) or when the reused
  prefix disagrees on re-join. `remend` runs on the tail slice only.
- **Memoize the streaming Turn's items.** `memo(ThreadItemView)` — item objects
  keep identity across deltas for all but the item receiving the delta, so a
  shallow compare suffices once callback props are stabilized (they already
  come from `useCallback` in `ThreadTurnView`). `projectSubagentsForTurn` /
  `groupTurnContent` results are memoized on `(turn.items, threadsById,
  latestTurnByThread)` rather than the `turn` wrapper identity.
- **Isolate the ticker.** Extract the elapsed label into a leaf component that
  owns `useSubagentElapsedMs`; `SubagentActivityItem` no longer holds ticking
  state above `SubagentRunDetail`, so the 1 Hz tick repaints a text span, not
  the nested transcript.

## Verification

- Unit (`tests/core`): counter test — N recorded notifications for one thread
  perform one metadata SELECT; a metadata write invalidates the cache.
- Unit (`tests/renderer`): `splitMarkdownBlocks` incremental path — appending
  text yields blocks identical to a from-scratch lex across a corpus of
  markdown shapes (headings, fences, tables, footnote defs — the `def`
  redistribution path in particular); a non-append change falls back correctly.
- Unit (`tests/renderer`): a delta to one item re-renders only that
  `ThreadItemView` (probe/counter fixture); the elapsed tick does not re-render
  the nested transcript fixture.
- **A9 manual:** long streaming answer (100 KB+) with an expanded Subagent row —
  renderer CPU before/after, recorded in the PR body.

## Open questions

- None; every change is behavior-preserving with a measurable bound.
