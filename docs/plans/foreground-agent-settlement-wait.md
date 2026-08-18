# Foreground Agent Settlement Wait

**Shape:** (b) a SET of two independent complete features, each its own PR. Both
are complete and verifiable alone; they are ordered only because both touch the
foreground branch of `SubagentCollaboration.spawnAgent` and would otherwise
conflict.

- **PR-1 — one settlement authority per Agent generation.** Delete the
  hand-rolled predicate wait; await the promise of the settlement state machine
  that already computes the same fact. Closes the live deadlock.
- **PR-2 — the foreground wait must lose to Stop.** Make the foreground `agent`
  call abortable end to end, so a wedged wait degrades to a cancelled Turn
  instead of a dead app.

## Goal

A foreground `agent` tool call must return exactly when the child's generation
reaches terminal — including the child's own follow-up notification Turns and
every background descendant it spawned — and must never be able to block a root
Turn forever.

Today it can. A root Turn wedges permanently, with no user-visible escape, when
a foreground child Agent itself spawns background Agents. The Turn stays
`inProgress` in `thread_turns` forever, the tool call never records
`item/completed`, and Stop cannot break it: only killing the process clears it.

## Non-goals

- Any change to the notification protocol, to `agent` / `agent_message` /
  `task_stop` tool contracts, or to `src/core/commands.ts` / `src/core/types.ts`.
  This is an internal liveness fix; the observable contract is unchanged except
  that the wait now ends when it should.
- Changing how background Agents notify parents. `SubagentExecutionLedger`
  terminal recording and delivery stay exactly as they are — PR-1 *consumes*
  that authority rather than modifying it.
- A general "every tool call races its AbortSignal" rule in `ToolRuntime` /
  `PiTurnExecutor`. That is a wider blast radius and a separate directional
  call; see Open questions.
- Recovering an already-wedged process. Restart plus the existing startup
  recovery handles it; the durable ledger is consistent.

## Background: the observed failure

Reproduced on a real run (root user Thread → foreground `agent` → that Agent
spawned three background `agent`s). The durable state afterwards:

- Root Turn: `status = inProgress`, never advanced past the `agent` tool call.
- Foreground child: idle, four completed Turns, terminal recorded for its
  generation.
- All three background grandchildren: idle, notifications `delivered`.

Every participant finished. Only the parent's wait never woke.

**Why.** `SubagentCollaboration.waitForAgentSettlement` is a two-source wait:
`TurnLifecycle.waitForIdle` for the child's own Turn edge, and the
`CollaborationActivityState.waiters` set for descendant activity. It parks when
the child is idle *and* `hasOutstandingChildren` is still true. The only thing
that can wake it at the watched Agent's key is
`queueChildTurnActivity` calling `signalCollaborationActivity(thread.parentThreadId)`
when a **grandchild's** Turn ends.

In the observed run all three grandchild Turns had already ended before the
child's first Turn ended, so all three wake-ups were spent while the parent was
still inside `waitForIdle`. The parent then parked on a signal source that could
never fire again: the child's remaining Turns (the ones that consume the
notifications) signal the *root's* key, not the child's. The immediate re-check
inside the parking promise (`hasActiveTurn`) also missed, because it ran in the
23 ms gap between the child's first Turn completing and its notification Turn
starting.

The `pending` half of `CollaborationActivityState` does not rescue it:
`takePendingCollaborationActivity` is consumed by the signalled Thread's own Turn
loop in `TurnLifecycle`, and `waitForAgentSettlement` never reads it. So the wait
is purely edge-triggered against a condition that is level-valued — a classic
lost wakeup.

**Why a patch is the wrong answer.** Adding one more `signalCollaborationActivity`
call (e.g. on the watched Thread's own idle edge) closes this instance and leaves
the class open: the predicate has many inputs, and the next state transition that
changes it reintroduces the hang. The design defect is upstream of the missing
edge.

## Design

### The root defect: three copies of one predicate

"Is this Agent generation still blocked?" is answered in three places:

- `hasOutstandingChildren` — used by `waitForAgentSettlement`,
  `queueChildTurnActivity`, and `recordTerminalSettlement`.
- `hasBlockingBackgroundChildren` — a near-identical sibling.
- the same call inside `startReservedTerminalSettlement`, as the pipeline's own
  gate.

And the foreground path asks the question twice in sequence: first
`waitForAgentSettlement` (a hand-rolled approximation), then
`ensureTerminalPipeline` (the real machine). The duplication is the bug.

### The seam that is already correct

`TerminalSettlementReservation` is keyed by `executionKey(agentId, generation)`
and is exactly the right granularity and lifetime:

- It survives the child's notification Turns — `reserveTerminalSettlement` bumps
  `revision` for a new Turn on the same generation instead of creating a second
  reservation.
- Its drive loop is **level-triggered and self-healing**: `retryTerminalSettlements`
  re-pushes every live reservation, and it is called from `threadBecameIdle`,
  which `TurnLifecycle` invokes on every Turn-settle edge. Descendant deferral is
  a first-class outcome (`TerminalSettlementOutcome`'s
  `deferredForDescendants`), not a race to be guessed at.
- It already computes the instant the foreground caller wants. In the observed
  run, `SubagentExecutionLedger.recordTerminal` wrote the child's terminal row
  for generation 1 at precisely the moment the parent should have resumed.

The correct wake-up was computed, and durably recorded, by code that was running
normally. The waiter was simply attached to a different, weaker approximation.

### PR-1 — one settlement authority per Agent generation

Give each `executionKey(agentId, generation)` a single deferred that settles
**exactly once**, and make the foreground path await it:

1. Own the deferred in a map keyed by `executionKey`, **not** on the
   `TerminalSettlementReservation` object. This is load-bearing: between
   `spawnChild` and the child's first Turn ending, no reservation exists
   (`reserveTerminalSettlement` is only reached from
   `prepareChildTerminalSettlement`). A waiter that does `map.get(key)` on the
   reservation would see `undefined` and degrade straight back into a race. The
   deferred is created by whoever arrives first — the spawning caller or the
   reservation.
2. Resolve it in the success branch of `startReservedTerminalSettlement`, where
   the outcome is not `deferredForDescendants` and the reservation is being
   removed. `deferredForDescendants` deliberately does **not** settle it; the
   descendant's idle edge restarts the reservation, exactly as today.
3. Reject it with `TERMINAL_SETTLEMENT_RETRY_EXHAUSTED_MESSAGE` when
   `scheduleTerminalSettlementRetry` exhausts `MAX_TERMINAL_SETTLEMENT_RETRIES`
   — the semantics `ensureTerminalPipeline` already has.
4. Replace the foreground branch of `spawnAgent` — both
   `waitForAgentSettlement` and `ensureTerminalPipeline` — with a single await on
   that deferred, then the existing terminal read and result construction.
5. **Delete `waitForAgentSettlement`, `CollaborationActivityState.waiters`, and
   the `waiters` loops in `beginClose` and `signalCollaborationActivity`.** The
   `waiters` set has no other consumer. The `pending` half stays: it serves the
   Turn loop's activity flush and is unrelated.

**The invariant this buys.** The rule to hold changes from

> every state transition that can change the predicate must remember to signal a
> waiter set keyed by a *different* Thread's id

to

> every path that removes or exhausts a reservation must settle its deferred

The second is enumerable in one file — reservation removal on success, removal on
generation/Turn mismatch in `retryTerminalSettlements`, retry exhaustion, and
`beginClose`. That is the whole list, and a reviewer can check it by reading the
map's call sites.

### PR-2 — the foreground wait must lose to Stop

Independent of any deadlock: today a foreground `agent` call that fails to settle
is unkillable, and that is what turns a bug into a forced restart. Three layers
each decline to cancel it:

- `spawnAgent`'s abort listener only calls `TurnLifecycle.interruptTurn` on the
  **child's** active Turn. When the child has no active Turn — the exact state in
  the observed failure — abort is a no-op.
- `ToolRuntime` awaits the tool promise directly.
- `PiTurnExecutor` only checks `signal.aborted` *between* steps.

Make the foreground wait itself race the invoking Turn's `AbortSignal`, so Stop
always wins and the tool call resolves as interrupted. Keep the existing
child-interrupt behaviour on abort; add the race, do not replace it. The
settlement machine is unaffected — the child's generation still settles on its
own schedule and still records its terminal; only the parent stops waiting.

This is A12 read on the liveness axis: an invariant on the user path must
degrade, not kill the user's action. A wait that cannot be cancelled is the same
failure shape as a `throw` on the user path.

## Open questions

1. **Should the abort race generalize?** PR-2 scopes it to the foreground `agent`
   wait. The stronger rule — no `await` on the user path without an abort race,
   enforced in `ToolRuntime` for every tool — is more correct and has a much
   wider blast radius (every tool, including ones whose partial effects are not
   safely abandonable). PM call; keep it out of these two PRs either way.
2. **Should `hasBlockingBackgroundChildren` be folded into
   `hasOutstandingChildren`?** They are near-identical and the duplication is
   evidence of the same drift. It is a genuine cleanup but it is *not* required
   by PR-1 (which removes one of the three call sites, not the predicate), and
   the two have subtly different treatment of ready-but-unconsumed notifications.
   Deliberately deferred rather than smuggled in.
3. **Does anything else await `waitForAgentSettlement`'s shape indirectly?**
   Verified by grep at plan time: `waiters` has no consumer besides
   `waitForAgentSettlement` and `beginClose`. Re-verify at build time before
   deleting.

## Checklists

### PR-1

- [ ] Add the per-`executionKey` settlement deferred, owned independently of
      `TerminalSettlementReservation` lifetime.
- [ ] Settle it on success, on generation/Turn-mismatch removal, on retry
      exhaustion (reject), and on `beginClose`.
- [ ] Rewrite the `spawnAgent` foreground branch to a single await.
- [ ] Delete `waitForAgentSettlement`, `CollaborationActivityState.waiters`, and
      both `waiters` loops.
- [ ] Regression test, next to `tests/core/subagentForegroundMessageDelivery.test.ts`:
      root → foreground Agent → background Agent, where the background Agent's
      terminal notification is still undelivered at the instant the foreground
      Agent's first Turn ends. Drive it with a controlled scheduler so the 23 ms
      window is deterministic rather than sampled.
- [ ] Test: the foreground call still waits across the child's notification Turns
      (it must not return at the child's *first* idle edge).
- [ ] Test: retry exhaustion surfaces as a rejected foreground call, not a hang.

### PR-2

- [ ] Race the invoking Turn's `AbortSignal` in the foreground wait; keep the
      existing child-interrupt on abort.
- [ ] Test: Stop during a foreground `agent` call settles the root Turn as
      interrupted while the child settles independently.
- [ ] `docs/lessons.md`: no `await` on the user path without an abort race —
      an uncancellable wait is A12's failure shape on the liveness axis.

### Spec

- [ ] Fold the settlement-authority design into
      `docs/spec/agent-tool-design.md` (foreground `agent` completion semantics)
      in the same change as PR-1.
