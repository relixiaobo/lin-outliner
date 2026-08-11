# Agent Streaming Delta Pipeline

**Shape:** (a) ONE complete feature in one PR (PM-ratified 2026-08-10). The two
parts below are build order within that single PR, not separate releases: the
main-process write path first (it is the dominant cost), the renderer store
batching on top.

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
- **SQLite synchronization.** Agent stores already open in WAL mode, but the
  rebuildable history projection uses `synchronous=FULL`, so every projected
  delta still pays the strongest power-loss barrier even though rollout JSONL
  can reconstruct it.
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
  reconsider only if measurement still shows jank after this PR lands.
- **No change to the persistence contract** (`docs/spec/agent-core.md`
  Persistence): the rollout JSONL stays the history source of truth and the
  history projection stays rebuildable.
- **No migration.** Pre-release rules apply; no format change is involved
  anyway (WAL is a runtime pragma).

## Design

### Part 1 — main-process streaming write path

Internal build order (A7 — each step lands with tests green): pragmas →
rollout group commit → delta coalescing → projection streaming overlay.

**1a. SQLite pragmas.** `openSqlite` establishes `journal_mode=WAL` and
`synchronous=NORMAL` as the agent-store baseline. The rebuildable history
projection uses that policy. Authoritative metadata, Goal, Memory, and
Automation stores retain their explicit `synchronous=FULL` override, so this
optimization does not widen their power-loss window.

**1b. Rollout group commit.** `RolloutStore` keeps one append handle open per
Thread (map of `threadId → { handle, byteOffset }`), replacing the per-event
stat/open/close; appends write immediately and return. fsync becomes batched:
a short timer (150 ms, constant in one place) after the first unsynced write,
plus forced sync at every non-delta lifecycle barrier — including
`item/completed`, `items/completed`, and `turn/completed` — and during
`flush()` (which the `before-quit` path already awaits). Handles close on
Thread delete, flush, and past a 16-handle LRU cap. Delete cancels a scheduled
sync, closes best-effort without syncing bytes that are about to be discarded,
and still unlinks if close reports an error. LRU eviction does sync before
close, but an eviction failure is background maintenance and cannot reverse a
successful append.
The existing torn-tail repair in `readEntries`
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
steering paths need no special casing. Rollback, delete, and service shutdown
also flush the Thread queue before mutating or closing its stores; rollback and
delete treat a stale-delta flush failure as best-effort so their destructive
cascade still completes. Transient notifications join the same per-Thread
queue and best-effort flush an older delta before broadcast. A 40 ms idle-group
timer bounds display latency. A flush runs the existing pipeline
(rollout append, projection apply, listener broadcast, extension notify) once
with the merged delta.

A deferred delta failure is reported but is not sticky. The failed group is
dropped, a later delta starts a fresh group, and a required lifecycle event
still persists. Its complete Item snapshot is the repair boundary for any
stream text whose earlier delta write failed.

Effect: every downstream per-event cost — rollout write, projection apply, IPC
message, preload decode, renderer render — drops by the merge factor (typically
10–50×). `ItemRecorder`'s in-memory item state stays per-chunk current
(unchanged), so executor-visible reads do not lag.

**1d. Projection streaming overlay.** `ThreadHistoryProjectionStore` holds
in-progress streamed items as **decoded objects in memory**
(`threadId → turnId → itemId → ThreadItem`). `item/delta` decodes the stored
item once on first delta, then applies `applyThreadItemDelta` in memory,
advances the watermark, and writes **no row**. Read paths (`listTurns`,
`readTurn`, `listItems`, `unfinishedItems`) overlay these objects over their rows —
mid-stream history reads (the Subagent-row expansion path) must keep returning
accumulated text. `item/completed` / `items/completed` write the final row as
today and drop the overlay entry; `turn/completed` and `history/rollback` drop
the Turn's entries; `rebuildThread` clears the Thread's overlay before
replaying.

Crash-recovery invariant: **streamed text recorded in the rollout survives a
crash even though delta rows are no longer written.** `reconcileThread` already
reads the full rollout at open. Because a `NORMAL` projection commit may reach
disk before an unsynced delta line, reconciliation compares the persisted
watermark boundary with the surviving rollout and rebuilds any projection that
advanced past a lost tail. When the newest Turn is `inProgress`,
reconstruct that Turn's open items from the rollout entries (replay deltas onto
each `item/started` snapshot) and persist the result to rows **before**
`finishCrashedTurn` reads `unfinishedItems`. One bounded write per open item,
paid only for a crashed Thread at open.

If a projection has a durable watermark but its rollout is completely absent,
reconciliation preserves the projection instead of rebuilding it from an empty
log. Startup first completes any projected rollback-hook recovery, writes an
atomic minimal rollout from the final projected Turn/Item snapshots, and then
rebuilds the projection from that replacement log so later ordinals remain
contiguous. A failure is isolated to that Thread; other catalog Threads still
reconcile, prune, and resume.

Equivalence contract: the incremental-vs-rebuilt tests in
`tests/core/agentCorePersistence.test.ts` compare through read APIs; the
overlay narrows the guarantee from row-level to read-surface equivalence for
in-progress items only. Completed items keep byte-identical rows.
Projection transactions keep an O(number of touched overlay keys) undo journal;
a failed SQLite commit replays those inverse mutations rather than cloning the
complete `streamingItems` tree for every delta.

Also in this step: the `item/delta` arm of
`ThreadCore.applyEphemeralNotification` stops re-running whole-Turn
`decodeTurn` — the item was validated at `item/started`, and
`applyThreadItemDelta` only appends; validate the delta application result, not
the entire Turn.

### Part 2 — renderer store notification batching

`ThreadStore.patch` keeps updating `this.snapshot` synchronously — every
request/response method, the `historyRevisions` guards, and existing tests keep
their exact semantics. High-frequency `item/delta` patches defer **listener
notification**: the first delta in a frame schedules a flush
(`requestAnimationFrame`, falling back to a ~16 ms timeout where rAF is
unavailable; the scheduler is injectable for tests), and the flush notifies
each listener once. Request/response and lifecycle patches notify immediately,
preserving focus and state-transition semantics; an immediate lifecycle patch
also consumes any older scheduled delta delivery so it cannot render stale or
duplicate state. `useSyncExternalStore` reads the latest snapshot at flush, so
React renders at most once per frame for token deltas regardless of whether
they arrive from the parent stream, expanded child stream, or both. An occluded
window's suspended rAF defers delta rendering until reveal, while the snapshot
itself is never stale.

## Verification

- **Rollout group commit** (`tests/core/agentCorePersistence.test.ts` +
  new cases): sync behavior observable via injected hooks/clock, not real
  timers — N streamed appends produce ≤1 sync until a barrier event forces one;
  a torn trailing line after an unsynced append still repairs on read; delete
  still unlinks after close failure, and LRU sync failure cannot reject the
  append that triggered eviction.
- **Coalescing** (new, `tests/core`): N text deltas inside the window yield one
  merged rollout entry; a delta followed by `item/completed` for the same item
  flushes the delta first (ordering); deltas for distinct items or types do not
  merge; `dynamicToolOutput` passes through unmerged; failed delta groups do not
  poison later deltas or required lifecycle events; transient delivery remains
  behind older recorded deltas.
- **Projection overlay** (`tests/core/agentCorePersistence.test.ts`): after
  `item/delta` the `thread_items` row is unchanged while `readTurn` returns the
  accumulated text; the existing interrupted-rollout scenario extends to assert
  `finishCrashedTurn`-visible content includes streamed deltas after a
  simulated crash (fresh store + reconcile-shaped replay). Injected commit
  failure restores the prior overlay, while a completely missing rollout is
  rebuilt from projection and accepts later Turns with contiguous ordinals.
- **Renderer batching** (`tests/renderer/threadStore.test.ts`): N delta
  `applyNotification` calls update the snapshot synchronously but notify
  listeners once per injected-scheduler flush; a lifecycle event delivers
  immediately and invalidates an older scheduled delta flush.
- **Perceived responsiveness (A9).** Manual before/after with a research
  Subagent running and its row expanded: typing latency in the outliner, main
  process CPU (Activity Monitor), and delta IPC rate. Record the numbers in the
  PR body.

## Open questions

None. The constants are 150 ms for rollout group commit, 40 ms for delta
coalescing, and 16 open rollout handles. Agent maintenance operates on the
owning userData tree or through live store APIs rather than copying a bare
SQLite database file, so WAL companion files do not create a separate export or
wipe contract.
