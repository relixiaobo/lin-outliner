# Provider Retry State Machine

This is shape **(a): one complete feature in one PR**. It replaces the current
split retry behavior with one explicit provider-attempt state machine and adds a
canonical manual retry path for exhausted Turns.

## Goal

- Treat the initial provider request and its retry budget as separate concepts:
  the first retry is displayed as `1/5`, the last as `5/5`, for at most six
  provider requests.
- Automatically retry transient provider failures, including structured
  `rate_limit_exceeded` concurrency limits, while continuing to reject quota,
  authentication, validation, and other permanent failures.
- Distinguish request retry (`Retrying`) from recovery of an already-started
  stream (`Reconnecting`) in the runtime-only transcript-tail status.
- Remove intermediate failures and retry state after recovery. Persist and show
  an error only after the automatic budget is exhausted.
- Let the user retry an exhausted failure manually without changing whether the
  root conversation Turn was user-authored or host-authored by subagent delivery.
- Preserve the existing no-duplicate-output and no-duplicate-tool-execution
  safety boundary.

## Non-goals

- No provider-internal retry layer. The Tenon kernel remains the sole owner of
  retry budgets, backoff, cancellation, and UI state.
- No automatic retry after material assistant output or a replay-unsafe tool
  call has crossed the canonical boundary.
- No renderer heuristic that hides an earlier error because a later Turn
  succeeds.
- No persisted record for intermediate retry attempts, retry counters, or
  transient status rows.
- No provider settings UI or user-configurable retry budget.
- No migration or compatibility reader for pre-release data.

## Design

### One explicit attempt model

The kernel owns an initial attempt plus two named recovery classes:

- `request`: a provider request failed before a usable stream began;
- `stream`: a started stream terminated before the runtime crossed its replay
  safety boundary.

The retry lifecycle reports the recovery class, the retry ordinal, and its
class budget. Request recovery uses ordinals `1/5` through `5/5`; the initial
request is never presented as retry zero or attempt one. Stream recovery keeps
its independently bounded replay policy and is labeled `Reconnecting` rather
than conflated with a failed request.

Selecting a retry replaces the current provider attempt. The failed attempt
does not emit a terminal Turn error. The runtime clears the transient status as
soon as replacement output begins, the Turn settles, or cancellation wins. A
successful replacement therefore leaves neither an error nor retry residue.
Only exhaustion or a non-retryable failure reaches the canonical Turn error.

### Canonical transient classification

Use `@earendil-works/pi-ai`'s `isRetryableAssistantError` as the canonical
provider-error classifier at the agent gateway. This covers provider-formatted
transient failures such as `rate_limit_exceeded: Concurrency limit exceeded for
account, please retry later`, while rejecting permanent quota failures such as
`insufficient_quota`.

Tenon's existing attempt-safety predicates remain additional requirements:

- cancellation is never retryable;
- the request/stream must be in the appropriate phase;
- material assistant output must not be replayed automatically;
- a completed or otherwise replay-unsafe tool call prevents automatic retry.

The narrower local Responses classifier used by unrelated page translation is
not broadened. Provider SDK retries stay disabled so canonical classification
cannot create a nested retry budget hidden from the kernel or renderer.

### Backoff and cancellation

Request retries retain abortable exponential backoff with bounded jitter. The
fifth retry extends the existing sequence by one bounded step. Waiting observes
the Run abort signal, and cancellation clears retry UI before settling without
opening another request.

Tests inject deterministic delay behavior for lifecycle assertions and verify
the pure delay bounds separately.

### Canonical manual retry command

Add `turn/retry` to the core agent command protocol. The renderer sends only the
Thread and terminal Turn identity; it never reconstructs message text or chooses
a new trigger.

Main admits the command only when the target Turn is:

- present in the selected Thread;
- the latest Turn;
- a retryable terminal failure or host-restart interruption;
- not already active, superseded, or being retried.

Admission prepares the replacement from the original canonical input while the
terminal Turn is still present. One internal `history/retry` rollout event then
removes the terminal Turn and starts the replacement in the same projection
transaction. An admission or append failure leaves the terminal Turn unchanged;
restart sees either the complete old state or the complete replacement. The
replacement preserves the original `TurnTrigger`, stable client ID, context
evidence, and host provenance. This is required for host-authored subagent
notifications: replay must remain an `agent_message` delivery and must never
become a user message. Delivery bookkeeping remains consistent with admission
so a recovered notification is neither lost nor delivered twice.

Stale, non-latest, active, missing, and non-retryable targets fail closed at the
command boundary with no Thread mutation. Double activation is serialized by
the same Thread lifecycle ownership used for ordinary Turn admission.

### Renderer behavior

The transcript tail derives its copy directly from the runtime retry class:

- request: `Retrying {current}/{max}`;
- stream: `Reconnecting {current}/{max}`.

The status remains a polite live region outside canonical history and updates
in place. It disappears on successful recovery, terminal settlement,
cancellation, Thread switch, hydration, or close.

A retryable terminal Turn renders one Retry action even when it was host-authored.
The action invokes `ThreadStore.retryTurn(threadId, turnId)`
and relies on main admission for eligibility. The renderer does not reuse the
user-message edit/rollback path and does not subscribe to broader state merely
to drive the click handler.

### Specification and verification

Update the current model-runtime and thread-rendering specifications with the
attempt vocabulary, five-retry budget, transient classifier, terminal-error
rule, and provenance-preserving manual retry contract. Update the subagent
contract where host-authored notification replay is specified.

Focused tests cover:

- exact transient concurrency-limit and permanent-quota classifications;
- retry ordinals `1/5` through `5/5`, recovery cleanup, exhaustion, and abort;
- request versus stream wording and lifecycle cleanup;
- no retry after material output or replay-unsafe tool activity;
- manual retry for user-authored and host-authored Turns with unchanged trigger
  and provenance;
- refusal of stale, non-latest, active, missing, and non-retryable Turns;
- one terminal Retry action and replacement of the prior terminal Turn after success.

## Open questions

None. The retry accounting, UI lifecycle, classifier ownership, and manual
retry provenance are ratified.

## Files

- `src/main/agent/runtime/kernel/retryPolicy.ts`
- `src/main/agent/runtime/kernel/ModelGateway.ts`
- `src/main/agent/runtime/PiTurnExecutor.ts`
- `src/core/agent/protocol.ts`
- `src/core/agent/codec.ts`
- `src/main/agent/ThreadService.ts`
- `src/main/agent/thread/TurnLifecycle.ts`
- `src/main/agent/thread/ThreadCatalogOps.ts`
- `src/main/agent/thread/SubagentCollaboration.ts`
- `src/renderer/agent/store/threadStore.ts`
- `src/renderer/agent/components/ThreadView.tsx`
- English and Simplified Chinese agent messages
- focused core and renderer tests
- `docs/spec/agent-model-runtime.md`
- `docs/spec/agent-thread-rendering.md`
- `docs/spec/agent-subagent-threads.md` when required by the final protocol
- this plan

No dependency, provider-setting, `docs/TASKS.md`, or `CHANGELOG.md` change is
part of the dev-agent PR.

## Risks

- A classifier that is broader than provider semantics could retry permanent
  failures. Exact positive and negative fixtures pin the canonical boundary.
- Retrying after canonical material output could duplicate text or mutations.
  Existing replay-safety gates remain mandatory and receive regression tests.
- A manual retry that reconstructs renderer-visible text can corrupt hidden
  input or host provenance. Main rebuilds exclusively from canonical Turn data.
- Rollback and host-notification delivery can race. Admission and delivery
  bookkeeping must settle as one lifecycle operation before execution starts.
- A missing clear event can leave stale retry UI. Every success, terminal,
  cancellation, selection, hydration, and close path is covered.

## Collision check

- Open PR #565 (`cc-2/agents-editor`) overlaps `PiTurnExecutor.ts`,
  `TurnLifecycle.ts`, `ThreadService.ts`, `threadStore.ts`, agent messages, and
  the subagent specification.
- This branch therefore claims the retry feature but is sequenced after #565.
  It will rebase onto the merged interface before final verification and will
  not ask the PM to reconcile the overlap.
- #565 is the only open PR. With this Draft PR, the significant review queue is
  at the project cap of two.

## Checklist

- [ ] Make request retry accounting explicit as `1/5` through `5/5`.
- [ ] Use the canonical pi-ai transient classifier behind the safety gates.
- [ ] Separate request retry and stream reconnection runtime states.
- [ ] Add and admit provenance-preserving `turn/retry`.
- [ ] Render automatic and manual retry states for every eligible Turn source.
- [ ] Cover recovery, exhaustion, refusal, cancellation, and replay safety.
- [ ] Fold the shipped design into current specs.
- [ ] Run typecheck, core tests, renderer tests, targeted E2E, and docs check.
