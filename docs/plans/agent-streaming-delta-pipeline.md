# Agent Streaming Delta Pipeline

**Shape:** (b) a SET of two independent complete features, each its own PR,
ordered by priority only (Feature 1 first — it is the dominant cost); neither
depends on the other.

## Goal

Keep the whole app responsive while an Agent Turn streams — especially during a
Subagent run, when the parent Turn and the child Thread stream concurrently and
the reader may have the Subagent row expanded.

Today every provider chunk (a token-sized text delta) independently pays the
full durability + validation + IPC + re-render pipeline. Verified per-chunk
costs, per streaming Thread:

- **Rollout append with fsync.** `RolloutStore.appendEvent` does
  stat → open → write → `handle.sync()` → close for every recorded
  notification. An fsync is milliseconds on macOS; at streaming rates this
  alone saturates the main process.
- **Projection full-item rewrite.** `ThreadHistoryProjectionStore.applyItemDelta`
  SELECTs the accumulated `item_json`, `JSON.parse`s it, re-validates with
  `decodeThreadItem`, appends the delta, `JSON.stringify`s, and UPDATEs — all
  synchronously on the main thread. O(item²) over the life of a stream; a long
  research answer means megabytes per second of redundant parse/stringify.
- **SQLite defaults.** `openSqlite` opens `node:sqlite` `DatabaseSync` with no
  pragmas: no WAL, so each UPDATE is its own journaled synchronous transaction.
- **Three codec passes + one IPC message per chunk.**
  `ThreadCore.recordNotification` decodes, the projection decodes again, the
  preload (`decodeAgentCoreNotification`) decodes a third time; nothing batches.
- **Whole-snapshot renderer store.** `ThreadStore.patch` builds a new snapshot
  and synchronously notifies every `useThreadStore()` subscriber per
  notification. Expanding a Subagent row calls `ensureThreadHistory`, so the
  child's deltas start applying to the store AND a second full `ThreadView`
  mounts — per-token render work roughly doubles, which is why expansion feels
  distinctly worse.

`ThreadCore.applyEphemeralNotification` additionally re-runs a full
`decodeTurn` on every delta for ephemeral Threads — same shape of redundant
work, same fix family.

## Non-goals

- **No protocol change.** Notification shapes in `src/core/agent/protocol.ts`
  are untouched; delta coalescing is value-level (adjacent text deltas
  concatenate into one notification of the same shape).
- **No renderer component restructuring.** `ThreadTurnView` and markdown blocks
  are already memoized; per-thread store selectors are deliberately deferred —
  reconsider only if measurement still shows jank after both features land.
- **No change to the persistence contract** (`docs/spec/agent-core.md`
  Persistence): the rollout JSONL stays the history source of truth and the
  history projection stays rebuildable.
- **No migration.** Pre-release rules apply; no format change is involved
  anyway (WAL is a runtime pragma).

## Design

### Feature 1 — main-process streaming write path (one PR)

Internal build order (A7 — each step lands with tests green, but they ship as
one PR): pragmas → rollout group commit → delta coalescing → projection
streaming overlay.

**1a. SQLite pragmas.** `openSqlite` executes `journal_mode=WAL` and
`synchronous=NORMAL` on open. Applies to all agent databases.

**1b. Rollout group commit.** `RolloutStore` keeps one append handle open per
Thread (map of `threadId → { handle, byteOffset }`), replacing the per-event
stat/open/close; appends write immediately and return. fsync becomes batched:
a short timer (~150 ms, constant in one place) after the first unsynced write,
plus forced sync at barriers — `item/completed`, `items/completed`,
`turn/completed`, before a Thread delete's `rm`, and `flush()` (which the
`before-quit` path already awaits). Handles close on Thread delete, on quit,
and past a small LRU cap. The existing torn-tail repair in `readEntries`
already tolerates a partial trailing line, so the crash window changes from
"nothing unsynced" to "at most the group-commit window".

Stated durability trade: a hard crash may lose the final ≲150 ms of streamed
text. Completed items and Turns remain synced barriers, so completed content
never regresses.

**1c. Delta coalescing.** In `ThreadCore.recordNotification` — the single choke
point every recorded notification passes through — keep at most one pending
`item/delta` group per Thread, keyed by (turnId, itemId, delta type). An
incoming string-append delta (`agentMessageText`, `reasoningContent`,
`reasoningSummary`, `commandOutput`) matching the pending group merges by
concatenation. Anything else for that Thread — a delta for a different item or
type, a `dynamicToolOutput` delta (appends discrete content items; never
merged), or any non-delta notification — flushes the pending group **first**,
preserving per-Thread order by construction; Turn-level notifications from
`TurnLifecycle` also pass through `recordNotification`, so interrupt and
steering paths need no special casing. An idle-group timer (~40 ms) bounds
display latency. A flush runs the existing pipeline (rollout append, projection
apply, listener broadcast, extension notify) once with the merged delta.

Effect: every downstream per-event cost — rollout write, projection apply, IPC
message, preload decode, renderer render — drops by the merge factor (typically
10–50×). `ItemRecorder`'s in-memory item state stays per-chunk current
(unchanged), so executor-visible reads do not lag.

**1d. Projection streaming overlay.** `ThreadHistoryProjectionStore` holds
in-progress streamed items as **decoded objects in memory**
(`threadId → turnId → itemId → ThreadItem`). `item/delta` decodes the stored
item once on first delta, then applies `applyThreadItemDelta` in memory,
advances the watermark, and writes **no row**. Read paths (`listTurns`,
`readTurn`, `unfinishedItems`) overlay these objects over their rows —
mid-stream history reads (the Subagent-row expansion path) must keep returning
accumulated text. `item/completed` / `items/completed` write the final row as
today and drop the overlay entry; `turn/completed` and `history/rollback` drop
the Turn's entries; `rebuildThread` clears the Thread's overlay before
replaying.

Crash-recovery invariant: **streamed text recorded in the rollout survives a
crash even though delta rows are no longer written.** `reconcileThread` already
reads the full rollout at open; when the newest Turn is `inProgress`,
reconstruct that Turn's open items from the rollout entries (replay deltas onto
each `item/started` snapshot) and persist the result to rows **before**
`finishCrashedTurn` reads `unfinishedItems`. One bounded write per open item,
paid only for a crashed Thread at open.

Equivalence contract: the incremental-vs-rebuilt tests in
`tests/core/agentCorePersistence.test.ts` compare through read APIs; the
overlay narrows the guarantee from row-level to read-surface equivalence for
in-progress items only. Completed items keep byte-identical rows.

Also in this step: the `item/delta` arm of
`ThreadCore.applyEphemeralNotification` stops re-running whole-Turn
`decodeTurn` — the item was validated at `item/started`, and
`applyThreadItemDelta` only appends; validate the delta application result, not
the entire Turn.

### Feature 2 — renderer store notification batching (one PR)

`ThreadStore.patch` keeps updating `this.snapshot` synchronously — every
request/response method, the `historyRevisions` guards, and existing tests keep
their exact semantics. Only **listener notification** defers: the first patch
in a frame schedules a flush (`requestAnimationFrame`, falling back to a ~16 ms
timeout where rAF is unavailable; the scheduler is injectable for tests), and
the flush notifies each listener once. `useSyncExternalStore` reads the latest
snapshot at flush, so React renders at most once per frame per subscriber
regardless of how many notifications arrived — parent stream, expanded child
stream, or both. An occluded window's suspended rAF simply defers rendering
until reveal, which is the desired behavior; the snapshot itself is never
stale.

## Verification

- **Rollout group commit** (`tests/core/agentCorePersistence.test.ts` +
  new cases): sync behavior observable via injected hooks/clock, not real
  timers — N streamed appends produce ≤1 sync until a barrier event forces one;
  a torn trailing line after an unsynced append still repairs on read.
- **Coalescing** (new, `tests/core`): N text deltas inside the window yield one
  merged rollout entry; a delta followed by `item/completed` for the same item
  flushes the delta first (ordering); deltas for distinct items or types do not
  merge; `dynamicToolOutput` passes through unmerged.
- **Projection overlay** (`tests/core/agentCorePersistence.test.ts`): after
  `item/delta` the `thread_items` row is unchanged while `readTurn` returns the
  accumulated text; the existing interrupted-rollout scenario extends to assert
  `finishCrashedTurn`-visible content includes streamed deltas after a
  simulated crash (fresh store + reconcile-shaped replay).
- **Renderer batching** (`tests/renderer/threadStore.test.ts`): N
  `applyNotification` calls update the snapshot synchronously but notify
  listeners once per injected-scheduler flush.
- **Perceived responsiveness (A9).** Manual before/after with a research
  Subagent running and its row expanded: typing latency in the outliner, main
  process CPU (Activity Monitor), and delta IPC rate. Record the numbers in the
  PR body.

## Open questions

- Window constants: 150 ms group-commit and 40 ms coalescing are starting
  points — tune against the responsiveness measurements; both live in one
  place.
- Rollout handle LRU cap (suggest 16): confirm it comfortably covers parent +
  children + automations running concurrently.
- WAL interaction with the data-maintenance flows (wipe/export): SQLite handles
  stray `-wal`/`-shm` companions itself, but confirm the maintenance paths copy
  or delete the whole database family.
