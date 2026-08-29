# Agent Root Turn Recovery

**Shape:** ONE complete user-visible recovery feature in one PR.

## Goal

Give a failed root Turn two explicit, non-overlapping recovery choices:

- **Continue from failure** appends a linked Turn from the latest projectable
  canonical history without redispatching settled tools.
- **Rerun turn** deliberately starts the accepted input from the beginning and
  may repeat effects.

Provider request/stream Retry remains automatic inside the same active Turn.
Shipping the root actions together avoids a temporary UI and protocol vocabulary
where the secondary action still means whole-Turn replay but is called Retry.

## Non-goals

- No checkpoint store, Item cursor, recovery snapshot, attempt graph, or
  renderer-owned eligibility authority.
- No automatic tool-call replay, side-effect classifier, compensation system,
  or generic idempotency guarantee.
- No delegated-generation status or notification redesign; that is owned by
  `agent-delegated-failure-truth`.
- No change to provider retry budgets or `streamWithPolicy` ownership.
- No migration or compatibility reader for a renamed pre-release Rerun event.

## Design

### Canonical vocabulary

Provider **Retrying/Reconnecting** stays inside one active Turn. **Continue from
failure** preserves the failed Turn and appends a new linked Turn. **Rerun turn**
replays accepted input and replaces the target only in current-history
projection while rollout evidence remains append-only.

An automatic provider retry renders exactly one neutral in-place bounded
ordinal, creates no canonical Retry Item or replacement Turn, and keeps the same
Turn active. Success clears the transient state; exhaustion terminalizes the
Turn exactly once. It never renders a terminal failure and then resurrects that
same Turn.

Canonical Items are the checkpoint. `CanonicalContextProjector` remains the
only provider-history authority and `ContextBudgetPlanner` remains the complete
protocol-unit validator. Interrupted assistant tails stay readable evidence but
do not enter continued provider history.

Ordinary tool failures remain canonical error results under the active kernel's
normal tool loop; they do not create a separate retry engine or automatically
trigger Continue/Rerun.

### Continue from failure

The renderer submits only Thread and source Turn identity. Under the normal
Thread admission lock, main revalidates that the source is the latest failed
persistent root Turn, the Thread is idle, the reader did not stop it, canonical
projection succeeds, and at least one complete settled assistant/tool unit
beyond accepted input is projectable.

Success appends an ordinary new Turn with a typed continuation trigger pointing
to the source. The next provider call receives canonical history plus a bounded
Host directive that prior settled work is evidence, not work to replay. Main
never enqueues an earlier Tool Item. A stale or unavailable request performs no
write and reloads current state.

Ordinary admission supplies the current model, permissions, working directory,
resource, compaction, and configuration rules and makes restart observe either
no continuation or exactly one accepted linked Turn. The trigger stores no Item
cursor or copied task/output.

### Rerun turn

Rename every code, protocol, persistence event, i18n, renderer, store, lifecycle,
test, and spec surface that means whole-Turn replay from Retry to Rerun. The
canonical command is `turn/rerun`; no automatic path invokes it.

Rerun preserves current semantics: replay all accepted initial/steering input
with original author/resource/client evidence, atomically append the history
marker and replacement Turn start, omit the old Turn from current transcript
and provider projection, and retain rollout evidence for Trajectory/diagnostics.
If the target contains a settled tool, broad confirmation warns that actions may
repeat without pretending to classify side effects. Declining confirmation
performs no write.

### Dependencies and collisions

`agent-result-and-file-lifecycle` and the final canonical/renderer Item
projection must merge first. This plan shares Thread protocol, lifecycle,
projector, renderer store, and Turn surfaces with Cross-Thread and delegated
failure work; repeat the live file check and keep only one recovery claim open.

### Verification

Tests cover canonical-frontier eligibility, complete tool-call/result units,
interrupted tails, stale races, crash before/after continuation admission,
exactly-once historical tool dispatch, Rerun accepted-input fidelity, settled-
tool confirmation/refusal, rollout/current-history divergence, rollout rebuild,
renderer reload, restart, and provider Retry success/exhaustion behavior. Visual
coverage includes the one in-place Retry ordinal plus failed evidence and both
actions in light/dark and keyboard flows.

### Acceptance criteria

- Eligible failure offers Continue as primary and Rerun as explicit secondary.
- A failure with no complete settled assistant/tool unit, or with orphaned/
  incomplete protocol history, offers no Continue and changes no state; Rerun or
  new reader input remains available.
- Continue appends one linked Turn and dispatches no historical tool Item.
- Rerun restarts accepted input, replaces current projection, and warns when
  settled tools may repeat.
- Declining Rerun confirmation performs no write.
- Provider Retry remains in the same active Turn, creates no canonical retry
  record, clears after success, and terminalizes exactly once after exhaustion.
- Stale/unprojectable eligibility degrades without changing canonical history.
- Source failure evidence remains readable after either action.

## Open questions

The implementation may expose the minimum read-only source-Turn boundary from
the canonical projector if current output cannot prove a complete settled unit;
it must not persist a checkpoint cursor.

## Implementation checklist

- [ ] Regenerate the whole-Turn Retry symbol queue and source-Turn eligibility
      surface from current main.
- [ ] Land the one-cut Rerun rename and preserve replacement semantics.
- [ ] Reset isolated pre-release userData if the persisted event name changes;
      verify rollout rebuild, renderer reload, and exact input/author retention.
- [ ] Add main-owned continuation eligibility and ordinary linked admission.
- [ ] Update current Agent specs and run protocol, persistence, renderer, E2E,
      real-provider dispatch, docs, and visual checks.
