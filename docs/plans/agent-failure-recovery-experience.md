# Agent Failure Recovery Experience

Shape: **(b) A SET of independent complete features.** The plan contains three
shippable units: canonical-history continuation, explicit whole-Turn Rerun, and
generation-scoped delegated failure presentation. Each unit has its own
behavior, verification, and specification updates. They share vocabulary, but
none is groundwork whose value depends on a later PR.

## Goal

### Purpose

Make Agent failures truthful, recoverable, and unambiguous without
discarding work that is already canonical or exposing transport machinery as
conversation content.

The reader must be able to answer four questions at every failure surface:

1. Is the root conversation still working?
2. What failed: a transient provider attempt, one Turn, or one delegated
   generation?
3. Did the direct parent receive the delegated result?
4. Will the next action preserve completed work or deliberately start over?

### Objectives

- **OBJ-1:** Continue a failed Turn from canonical settled history without the
  host dispatching any settled tool again.
- **OBJ-2:** Give provider retry, continuation, and whole-Turn rerun distinct
  semantics, names, actions, and history behavior.
- **OBJ-3:** Separate a stable Agent's current state from the immutable outcome
  of each execution generation.
- **OBJ-4:** Make delegated failure delivery factual and durable without
  claiming that delivery means handling, acceptance, or task completion.
- **OBJ-5:** Close the blank-subagent-transcript regression through the single
  canonical author and renderability mechanisms owned by PR #587, not through
  a parallel transport-message rule.
- **OBJ-6:** Preserve the existing bounded provider retry and delegated
  notification machinery unless verification proves a defect in those owners.

### Minimum acceptable outcome

- A failed latest root Turn with settled projectable progress offers
  **Continue from failure**. The source Turn remains readable, a new linked
  Turn starts from canonical history, and settled tool dispatch counts stay at
  one.
- The existing whole-Turn action is called **Rerun turn** end to end. It keeps
  its current accepted-input replay and projected-history replacement semantics
  and warns when repeating the Turn may repeat effects.
- A failed child generation says **This run failed** and separately says
  whether its direct parent is waiting to be notified or has been notified. A
  still-active root remains **Working**.
- Replaying the original failing rollout after #587 produces no empty speaker,
  bubble, accessibility output, or vertical block.

### Evidence and current constraints

Observed behavior and existing architecture establish the brownfield target:

- The failing delegated session contained host transport `userMessage` Items
  whose visible text was empty while typed `additionalContext` still carried
  the model context. The renderer opened speaker groups before discovering that
  the Items rendered nothing.
- PR #587 replaces that transport shape with canonical Agent-authored input,
  renders the delivery as `SubagentReport`, and filters
  `threadItemRendersNothing` Items before speaker grouping. It is the owner of
  authorship and blank-block removal.
- `CanonicalContextProjector.projectTurn` already rebuilds complete
  assistant/tool exchanges from canonical Items and excludes interrupted
  assistant tails from later provider history.
- `ContextBudgetPlanner` already treats assistant tool calls and their results
  as one protocol unit and rejects orphan results or incomplete exchanges.
- The kernel records ordinary tool failures as error tool results and continues
  model execution in the same Turn. A general tool retry engine is not missing
  from the whole-Turn recovery path.
- The current `turn/retry` path replays the target Turn's accepted input batches,
  persists an append-only history marker, removes the target from the current
  projection, and starts its replacement. This is coherent whole-Turn rerun
  behavior under the wrong name.
- `SubagentExecutionLedger` already owns generation identity, terminal outcome,
  notification state, delivery batching, retry after a busy parent, and restart
  recovery. Child failure propagation therefore needs verification and clearer
  projection, not another delivery queue.

### Decision summary

The clean target is:

> Canonical history is the checkpoint. Recovery starts a linked continuation
> from the latest projectable canonical frontier.

The projectable frontier is the provider history produced by the existing
canonical projector and accepted by the existing protocol-unit planner. It is
not a stored Item cursor, a second transcript snapshot, or a mutable recovery
ledger.

This target deliberately reuses the event-sourced Thread model:

- settled Items remain facts;
- interrupted assistant output remains readable evidence but is not model
  history;
- a continuation is an ordinary new Turn with a typed link to its source;
- a rerun remains an explicit rollback-and-replacement of the projected Turn;
  and
- delegated notification rows remain the delivery authority.

### Rejected alternatives

| Alternative | Decision | Reason |
| --- | --- | --- |
| Persist a checkpoint ledger with Item cursors and replay classes | Reject | It duplicates canonical Items and can disagree after retry, rollback, fork, compaction, or repair. |
| Add automatic read-only/mutating tool retry classification | Defer outside this plan | Tool errors already become canonical results; generic idempotency and unknown-dispatch recovery are a separate tool-execution problem. |
| Keep every whole-Turn rerun attempt in the ordinary transcript | Reject | The append-only rollout already preserves audit evidence; an attempt graph would require new context omission and transcript navigation rules. |
| Patch only empty delivery `userMessage` rows | Reject | PR #587 establishes canonical authorship and a generic renderability boundary; a transport-shape exception would regress on the next producer. |
| Add OS notification aggregation | Defer outside this plan | It does not determine recovery correctness or delegated failure truth and has an independent product policy surface. |

## Non-goals

- No second checkpoint store, Item cursor, recovery snapshot, attempt graph, or
  renderer-owned recovery authority.
- No automatic replay of a failed tool call, side-effect classifier, tool
  attempt budget, compensation framework, shell rollback, or generic
  idempotency system.
- No guarantee that a newly generated tool call will never resemble an earlier
  call. The invariant is narrower and enforceable: the host never mechanically
  redispatches a settled canonical Tool Item during continuation.
- No automatic resume of a terminal child generation. Its failure remains
  immutable; the parent or reader may make a new decision that starts another
  generation.
- No host-authored claim that the assignment or root task succeeded or failed.
  The host reports execution, liveness, and delivery facts only.
- No `handled`, `used`, `accepted`, or `taskComplete` delivery state. Delivery
  proves only that the direct parent received the result.
- No duplicate author classifier, transport-specific transcript suppression,
  or visible-content store beside the #587 `ThreadInputAuthor` and
  `threadItemRendersNothing` path.
- No change to provider retry budgets or ownership. `streamWithPolicy` remains
  the sole bounded owner of request and stream retries.
- No promise that continuation avoids resending context or consuming provider
  input tokens. It preserves work and effects, not transport cost.
- No compatibility reader or migration for renamed pre-release Retry protocol
  records. Follow the repository's explicit reset policy if the persisted event
  name changes.

## Design

### Canonical vocabulary and truth hierarchy

| Scope | Trigger and owner | History behavior | User-facing state/action |
| --- | --- | --- | --- |
| Provider request/stream attempt | Automatic, bounded by the active executor | Same active Turn; no canonical retry Item | **Retrying 2/5** or **Reconnecting 2/5** |
| Failed-Turn continuation | Explicit reader action; main validates | Source Turn remains; append one linked continuation Turn using canonical history | **Continue from failure** |
| Whole-Turn rerun | Explicit reader action only | Replay accepted input and replace the target in current projection; rollout keeps audit evidence | **Rerun turn** |
| Delegated generation settlement | Child runtime and direct-parent delivery pipeline | Immutable generation outcome plus factual notification state | **This run failed** / **Parent notified** |

The following product rules apply across all three units:

- **BR-1:** A provider attempt that is retrying is not terminal and cannot
  render as a failed Turn or failed generation.
- **BR-2:** A terminal Turn is immutable. Continuation appends a new Turn;
  Rerun replaces the old Turn only in the canonical current-history projection.
- **BR-3:** Provider role never establishes reader or Agent authorship.
- **BR-4:** A child generation's terminal status never becomes the root Turn's
  terminal status.
- **BR-5:** Delivery means `pending`, `delivering`, or `delivered`; UI copy maps
  these to notification progress and never to semantic handling.
- **BR-6:** A stable Agent surface may show current liveness, while a historical
  transcript anchor or report always shows the generation that created it.

### Preserved authorities

Implementation must extend these owners rather than route around them:

- `CanonicalContextProjector` is the sole canonical-to-provider-history
  projection owner.
- `ContextBudgetPlanner` is the sole complete-protocol-unit validator and
  context-budget owner.
- The kernel's normal tool call/result loop remains the owner of tool failure
  settlement inside an active Turn.
- `TurnLifecycle` and the existing Thread lock/admission path remain the only
  Turn-start authority.
- `RolloutStore` and `ThreadHistoryProjectionStore` remain the append-only
  evidence and current-history authorities for Rerun.
- `SubagentExecutionLedger` and `SubagentCollaboration` remain the only child
  settlement and direct-parent notification owners.
- After #587, `ThreadInputAuthor` and `threadItemRendersNothing` remain the only
  speaker-trust and renderability authorities.

### Feature 1: Continue from canonical history

This is one complete feature PR.

**FR-1: Main-owned continuation eligibility.** The renderer requests
continuation with only the Thread and source Turn identities. Under the Thread
admission lock, main revalidates all of the following:

- the Thread is a persistent root user Thread;
- the source is still its latest terminal failed Turn;
- the Thread has no active Turn and the source was not stopped by the reader;
- projecting canonical history through the source succeeds;
- the projected source Turn contributes at least one complete settled
  assistant/tool protocol unit beyond its accepted input; and
- the resulting provider history passes the existing protocol-unit planner.

The renderer never submits an Item boundary, tool classification, projected
messages, or a cached eligibility reason. If projection is unavailable or
invalid, main degrades to `unavailable` eligibility and leaves **Rerun turn** or
a new reader message available; it does not kill the Thread.

**FR-2: Linked continuation admission.** A successful action appends a new Turn
through normal admission with a typed continuation trigger containing the
source Turn identity. The trigger is enough to explain provenance and rebuild
the relationship after restart. It carries no checkpoint cursor.

The new Turn receives:

- the ordinary canonical provider projection through the source Turn;
- the same current model, permissions, working directory, compaction, resource,
  and configuration rules as any new Turn; and
- a typed host continuation directive stating that settled history is prior
  evidence and must not be repeated merely to reconstruct progress.

The directive is model context, not a transcript participant, and contains no
copy of the task or prior output. Canonical history remains the task authority.

**FR-3: No host replay.** Continuation begins with the next provider call. It
does not enqueue or execute any earlier Tool Item. Completed and error tool
results enter provider history exactly as they do for an ordinary later Turn.
An interrupted assistant tail stays visible in the source Turn but remains
excluded by `CanonicalContextProjector`.

If the new model later chooses another tool call, that call has a new canonical
identity and follows ordinary admission and permission policy. It is a new
model decision, not recovery replay.

**FR-4: Action and race behavior.** **Continue from failure** is the primary
action only while eligibility is current. Selecting it latches the action until
the command returns. If another Turn, steer, Rerun, deletion, or recovery wins
the lock first, the request performs no write and reloads current canonical
state.

The source Turn remains visible with its interrupted or failed evidence. The
new Turn renders directly after it and identifies itself as continuing prior
work without exposing Turn IDs or checkpoint metadata.

Ordinary Turn admission supplies crash safety: restart observes either no new
Turn or one accepted continuation Turn. There is no separate recovery commit
that can become split-brain.

### Feature 2: Make whole-Turn Rerun explicit

This is one complete feature PR and may land before Feature 1 after #587 and
#592 have landed.

**FR-5: One semantic name.** Rename every product and code surface that means
"replay the accepted input from the beginning" from Retry to Rerun. This
includes the renderer action, i18n keys, store/client methods, IPC command,
protocol request/response types, lifecycle helpers, history event/marker names,
tests, and current specifications. Provider retry retains the word Retry.

The canonical operation is `turn/rerun`; no automatic runtime or delegated
delivery path may invoke it.

**FR-6: Preserve replacement semantics.** Rerun keeps the existing behavior:

1. read the target Turn's complete accepted initial and steering input batches
   in canonical order;
2. preserve each input's canonical author, content, resources, client identity,
   and acceptance semantics;
3. append the canonical history-rerun marker and replacement `turn/started` as
   one durable operation;
4. omit the target Turn from current transcript and provider-history projection;
   and
5. keep the old rollout events as audit evidence available to Trajectory and
   diagnostics.

Rerun does not create a normal-history attempt graph and does not reuse settled
assistant/tool output. When the target contains a settled tool Item, the reader
must confirm copy that states the Turn starts from the beginning and may repeat
actions. The warning is intentionally broad; it does not claim to classify
side effects.

### Feature 3: Generation-scoped delegated failure truth

This is one complete feature PR after #587 and #592. It includes the original
blank-transcript regression closure because both symptoms arise on delegated
delivery surfaces, while reusing #587's mechanism.

**FR-7: Existing delivery path is authoritative.** A terminal background child
generation writes one notification row through the existing settlement
pipeline. The row remains pending while the direct parent is busy, survives
restart, and is admitted at the parent's next valid idle boundary. Terminal
failure uses the same path as terminal success.

Implementation first adds end-to-end evidence for this existing contract. Any
defect is fixed in `SubagentCollaboration` or `SubagentExecutionLedger`; no
second queue, renderer acknowledgement, or root-direct bypass is introduced.

**FR-8: Immutable generation receipt.** Presentation projects a generation
receipt keyed by stable Agent ID and generation from existing execution rows,
delivered-notification references, and the matching child Turn. The receipt
contains only:

- generation identity;
- terminal status and duration;
- bounded actionable error text;
- partial-output availability;
- direct-parent identity; and
- notification state and delivery Turn reference.

Transcript spawn/resume anchors and `SubagentReport` read their exact generation
receipt. Resuming the stable Agent can update its detail header and live work
strip, but cannot rewrite an earlier anchor from **This run failed** to
**Working** or **Finished**.

The generation receipt remains a projection rather than a second persisted
record. If an existing source cannot identify a generation unambiguously, the
fix adds the minimum missing identity to the existing execution projection or
canonical anchor; it does not duplicate terminal status.

**FR-9: Scope-aware status and delivery copy.** Delegated surfaces use scoped
facts:

- active stable Agent: **Working**;
- terminal generation: **This run finished**, **This run failed**,
  **This run was interrupted**, or **This run was stopped**;
- pending delivery: **Waiting to notify {parent}**;
- active delivery: **Notifying {parent}**;
- delivered: **{parent} notified**; and
- active root after a child failure: **Working**, with the failed generation
  shown separately.

A root or parent can become terminal only from its own canonical Turn state.
Child counts and receipts may explain that one run failed, but they cannot
derive a root-level task outcome.

**FR-10: Blank-transcript closure after #587.** Re-run the original failure
shape against #587's canonical Agent-authored delivery and `SubagentReport`
replacement. Before speaker grouping, spacing, copy-target selection, and the
accessibility tree, every Item for which `threadItemRendersNothing` is true is
removed from the visible run.

If the original fixture still opens an empty speaker, extend the existing
renderability classifier or grouping boundary. Do not add a delivery-message
exception, infer authorship from provider role, suppress the whole Turn, or
store a second `visible` flag.

Typed additional context remains available to model projection and Trajectory
while contributing zero ordinary transcript height and zero accessible speaker
output.

### User flows

#### FLOW-1: Recover a transient provider attempt

- **Trigger:** The active provider request or stream fails with an existing
  retryable classification.
- **Visible state:** The same active Turn shows one neutral, in-place
  **Retrying** or **Reconnecting** status with the bounded ordinal.
- **Result:** Success clears the transient state and continues the same Turn.
- **Terminal path:** Exhaustion terminalizes the Turn once; no failed state is
  shown and then silently resurrected inside the same generation.
- **Requirements:** BR-1, OBJ-6.

#### FLOW-2: Continue useful work after a terminal failure

- **Trigger:** The latest root Turn fails after at least one complete settled
  assistant/tool protocol unit.
- **Visible state:** The failed evidence remains readable and **Continue from
  failure** is primary; **Rerun turn** is secondary.
- **Decision:** Continue preserves canonical history. Rerun deliberately starts
  from accepted input.
- **Result:** Continue appends one linked Turn and starts the next provider call
  without redispatching historical tools.
- **Failure recovery:** A stale or unprojectable source changes nothing and
  reloads current state.
- **Requirements:** FR-1 through FR-6.

#### FLOW-3: Receive a failed child result

- **Trigger:** A background child generation terminalizes with failure.
- **Visible state:** Its immutable receipt says **This run failed** and either
  **Waiting to notify {parent}** or **{parent} notified**. The root's own state
  remains independent.
- **Result:** The existing delivery pipeline admits the factual Agent-authored
  result to the direct parent. The parent model may use partial output, change
  approach, start a new generation, ask the reader, or report the limitation.
- **Failure recovery:** Busy-parent and restart paths retain the pending row;
  no empty transport speaker is emitted.
- **Requirements:** FR-7 through FR-10.

### Implementation suggestions

These symbol names are suggestions; the observable requirements above are the
contract.

For Feature 1:

- Add a narrow `turn/continue` request/response and a continuation Turn trigger
  carrying only `sourceTurnId`.
- Derive eligibility by comparing the source Turn's canonical projected
  assistant boundaries with its accepted-input frontier; reuse
  `projectTurnsWithBoundaries` and the protocol-unit planner.
- Keep the continuation directive typed and reproducible from the trigger so it
  cannot become another mutable source of task state.
- Use the ordinary `TurnLifecycle` admission transaction and Thread lock. Do
  not add recovery persistence beside the rollout.

For Feature 2:

- Rename `turnRetry.ts`, `isRetryableTurn`, `retryTurn`, Retry admission types,
  `replaceLatestTurnForRetryWithLocksHeld`, `persistHistoryRetry`, and the
  `history/retry` record to Rerun equivalents in one cutover.
- Preserve `ThreadHistoryProjectionStore` replacement behavior and rollout
  audit retention exactly; naming and warning change, semantics do not.
- Derive the repeat-action warning from the presence of settled tool Items,
  without introducing a tool metadata inventory.

For Feature 3:

- Keep `SubagentRegistryEntry` as stable-current-state projection for live
  surfaces and add a renderer-facing generation receipt derived from existing
  canonical inputs.
- Resolve an anchor's generation from canonical spawn/resume order or a minimal
  explicit generation identity; do not read the stable entry's latest status
  for a historical anchor.
- Use the current notification state and delivered-notification references for
  delivery copy. Never persist presentation strings.
- After #587, reuse its `SubagentReport`, canonical `ThreadInputAuthor`, and
  pre-grouping `threadItemRendersNothing` guard.

### Files and ownership

Feature 1 is expected to touch:

- `src/core/agent/protocol.ts`
- `src/core/agent/codec.ts`
- `src/main/agent/ThreadService.ts`
- `src/main/agent/thread/TurnLifecycle.ts`
- `src/main/agent/context/ContextProjector.ts` only for a reusable eligibility
  projection, not for a second recovery mode
- `src/renderer/agent/store/threadStore.ts`
- `src/renderer/agent/components/ThreadView.tsx`
- Agent core/model-runtime/thread-rendering specs and focused core/renderer/E2E
  tests

Feature 2 is expected to touch:

- `src/core/agent/turnRetry.ts` by rename
- `src/core/agent/protocol.ts`
- `src/core/agent/codec.ts`
- `src/main/agent/ThreadService.ts`
- `src/main/agent/thread/TurnLifecycle.ts`
- `src/main/agent/thread/ThreadCatalogOps.ts`
- `src/main/agent/thread/ThreadCore.ts`
- `src/main/agent/persistence/RolloutStore.ts`
- `src/main/agent/persistence/ThreadHistoryProjectionStore.ts`
- `src/renderer/agent/store/threadStore.ts`
- `src/renderer/agent/components/ThreadView.tsx`
- English and Simplified Chinese Agent message catalogs
- Agent core/thread-rendering specs and existing Retry-focused tests by rename
  and semantic expansion

Feature 3 is expected to touch:

- `src/main/agent/thread/subagentExecutionProjection.ts` only if the existing
  projection lacks a required canonical generation identity
- `src/main/agent/thread/SubagentCollaboration.ts` and
  `src/main/agent/persistence/SubagentExecutionLedger.ts` only if the delivery
  verification exposes a real authority defect
- `src/renderer/agent/subagentPresentation.ts`
- `src/renderer/agent/components/SubagentChip.tsx`
- `src/renderer/agent/components/SubagentWorkStrip.tsx`
- `src/renderer/agent/components/SubagentDetailView.tsx`
- `src/renderer/agent/components/SubagentReport.tsx`
- `src/renderer/agent/components/ThreadView.tsx`
- Agent subagent/thread-rendering specs and focused delivery/presentation/E2E
  tests

No package, build configuration, Outliner command protocol, OS-notification,
or main-owned release file change is expected from any feature PR.

### Risks and mitigations

- **RISK-1: Split recovery authority.** A persisted cursor can disagree with
  canonical history after rollback, fork, or repair. Mitigation: persist only
  the continuation source relationship and always derive provider context from
  canonical history.
- **RISK-2: Duplicate effects.** Mechanical replay of a settled tool can repeat
  local or outward actions. Mitigation: continuation starts at a provider call;
  tests assert historical tool dispatch counts, not only final prose.
- **RISK-3: Invalid provider history.** An incomplete exchange can produce an
  orphan call or result. Mitigation: use the current projector and protocol-unit
  planner as the eligibility gate; unavailable continuation degrades without
  killing the Thread.
- **RISK-4: Rerun becomes an accidental continuation.** Reusing settled output
  would make the two actions indistinguishable. Mitigation: preserve current
  accepted-input-only replacement semantics and test the provider context.
- **RISK-5: Historical status time travel.** A resumed Agent's current state can
  overwrite an older failed anchor. Mitigation: historical anchors use an
  immutable generation receipt; only live surfaces use the stable entry.
- **RISK-6: False delivery reassurance.** `delivered` can be misread as handled
  or successful. Mitigation: copy says only **notified** and no semantic
  acknowledgement enum exists.
- **RISK-7: Blank rows return under another producer.** A delivery-specific
  filter would miss the next content-free Item shape. Mitigation: canonical
  authorship plus the generic renderability classifier runs before grouping.
- **RISK-8: Scope regrows during implementation.** Tool retry policy and OS
  notification aggregation are tempting adjacent fixes. Mitigation: their
  absence is an explicit review condition for all three PRs.

### Acceptance criteria

- **AC-1:** While a provider request or stream is automatically retrying, the
  same Turn remains active, exactly one neutral in-place ordinal is visible,
  and no retry Turn or canonical retry Item is created.
- **AC-2:** When provider recovery succeeds, the transient state clears without
  leaving a terminal failure row; when attempts exhaust, the Turn terminalizes
  exactly once.
- **AC-3:** Given a failed latest root Turn containing three settled tool
  exchanges, continuation is eligible from canonical history and the three
  historical tools each retain a total dispatch count of one.
- **AC-4:** The continuation's provider context contains the three complete
  assistant/tool exchanges and excludes an interrupted trailing assistant
  message.
- **AC-5:** A failed Turn with no settled assistant/tool unit does not offer
  continuation; Rerun or a new reader message remains available.
- **AC-6:** When canonical projection produces an orphan or incomplete tool
  exchange, continuation is unavailable without a renderer crash, Thread
  terminalization, or mutation.
- **AC-7:** When continuation wins admission, the source Turn remains readable,
  exactly one linked Turn is durable, and restart restores that one Turn.
- **AC-8:** When another admission wins first, a stale continuation request
  performs no write and reloads canonical state.
- **AC-9:** A model-selected tool call after continuation is admitted as a new
  call under ordinary permissions; no host path copies or redispatches an old
  Tool Item.
- **AC-10:** Every whole-Turn surface and symbol uses Rerun vocabulary while
  provider-attempt recovery continues to use Retry/Reconnect vocabulary.
- **AC-11:** Rerun reconstructs all accepted initial and steering inputs in
  canonical order with exact authors, resources, and client identities, and
  excludes the target's assistant/tool output from new provider context.
- **AC-12:** Rerun removes the target from current transcript projection while
  retaining its append-only rollout evidence and history marker for audit.
- **AC-13:** Rerun of a Turn containing a settled tool requires confirmation
  that actions may repeat; declining confirmation performs no write.
- **AC-14:** No automatic provider, notification, parent-continuation, or
  startup path invokes `turn/rerun`.
- **AC-15:** A failed background child generation creates one existing-ledger
  terminal notification, survives a busy direct parent and restart, and reaches
  that parent exactly once.
- **AC-16:** Before delivery, the generation receipt says **Waiting to notify
  {parent}**; after durable delivery it says **{parent} notified** and never
  claims handling, acceptance, success, or task completion.
- **AC-17:** While the parent/root continues after a child generation fails, its
  own status remains **Working** and the child receipt separately says **This
  run failed**.
- **AC-18:** After the same stable Agent starts a later generation, the earlier
  spawn/resume anchor retains its original terminal status, duration, error,
  and delivery receipt while live surfaces show the new generation.
- **AC-19:** After #587, the original delivery fixture renders one factual
  `SubagentReport` and no empty bubble, speaker header, copy target, accessible
  speaker output, or blank vertical block.
- **AC-20:** A content-free Item of any supported author kind is filtered by the
  existing generic renderability boundary before speaker grouping; attachment-
  only reader messages remain visible.
- **AC-21:** Rollout rebuild, renderer reload, Retry-to-Rerun cutover reset, and
  app restart reproduce continuation links, rerun replacement, generation
  receipts, and delivery state from their existing canonical authorities.
- **AC-22:** Typecheck, core tests, renderer tests, docs checks, the focused
  Agent E2E suite, light/dark visual verification, and a forced real-provider
  continuation smoke pass. The smoke records exact tool dispatch counts.

### Collision result

- PR #587 is a hard dependency for all three
  features. It changes protocol and lifecycle author preservation used by
  Continuation and Rerun, and it owns `SubagentCollaboration`, `ThreadView`,
  `ThreadItemView`, Agent specs, and the main Agent test suites used by Feature
  3. This plan must consume its canonical author and renderability contracts
  after merge.
- PR #592 (`outliner-runtime-recovery`) overlaps `ThreadView`,
  `SubagentDetailView`, Agent rendering specs, and the shared E2E mock. All
  three features wait for it; each must rebase and regenerate its file queue
  from the resulting tree.
- PR #591 is currently plan-only. Its later host composition implementation may
  overlap lifecycle ownership, so each feature repeats the collision check when
  it claims work.
- The current review queue already contains two significant implementation
  changes. No feature in this plan opens an implementation claim until that
  queue has capacity and its dependencies have landed.
- The three features touch shared Agent surfaces. Land one complete feature at
  a time; rebase and rerun the file-level claim check before the next claim.

## Open questions

There are no unresolved product-direction questions in this plan. The following
are empirical gates, not invitations to invent new mechanisms:

- **OQ-1:** After #587 lands, does the captured failing delivery fixture already
  satisfy AC-19 and AC-20? If yes, Feature 3 adds/keeps the regression evidence
  and makes no second blank-message implementation.
- **OQ-2:** Does the current canonical projector expose enough source-Turn
  boundary information to determine whether that Turn contributed a complete
  settled assistant/tool unit? If not, expose the minimum read-only projection
  needed by eligibility; do not persist a checkpoint cursor.
- **OQ-3:** Can every historical generation receipt be derived unambiguously
  from existing anchor order, child Turns, and delivered-notification references?
  If not, add only the missing generation identity to the existing canonical
  projection.

## Implementation checklist

### Feature 1 checklist

1. Rebase on the latest merged Agent protocol and regenerate the collision
   queue from open PR scopes and actual files.
2. Add focused projector/planner tests proving the canonical frontier includes
   settled tool exchanges and excludes interrupted assistant tails.
3. Add continuation eligibility, typed source trigger, ordinary admission, and
   stale-race handling without a checkpoint store.
4. Add the primary action and source/continuation presentation, then update the
   current Agent core, model-runtime, and rendering specs.
5. Run focused core/renderer/E2E tests and the real-provider exact-dispatch
   smoke before the full required verification.

### Feature 2 checklist

1. Regenerate every whole-Turn Retry symbol, copy, test, spec, command, and
   persistence-event hit from `rg`; completion is an empty misnamed queue.
2. Perform the one-cutover Rerun rename and preserve replacement behavior.
3. Add broad repeat-action confirmation from settled Tool Items and prove every
   non-user path cannot invoke Rerun.
4. Reset isolated pre-release userData if the persisted event cutover requires
   it, then verify rollout rebuild and exact input/author preservation.
5. Run the full required verification for the protocol and persistence blast
   radius.

### Feature 3 checklist

1. Rebase after #587 and #592 and replay the original delegated failure fixture
   before editing production code.
2. Add end-to-end busy-parent, restart, failed-generation, and exactly-once
   direct-parent delivery evidence around the existing ledger.
3. Project immutable generation receipts from existing authorities and move
   historical anchors/reports off the stable current-state entry.
4. Apply scope-aware failure and notification copy; keep root liveness derived
   from the root's own execution.
5. Close any remaining blank speaker only through #587's existing author and
   renderability boundary, then update current subagent/rendering specs.
6. Run typecheck, core tests, renderer tests, docs checks, focused Agent E2E,
   `git diff --check`, and light/dark visual verification.
