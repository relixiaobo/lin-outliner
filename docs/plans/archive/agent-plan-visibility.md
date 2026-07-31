# Agent Plan Visibility

## Goal

A session shows the complete, actual process. When the agent updates its Plan,
the transcript says so — like every other tool call it makes.

## Why this reverses a ratified decision

`docs/plans/archive/agent-execution-interaction-consistency.md` (#438)
deliberately made the Plan transient:

> Keep `update_plan` as a model control tool, but **exclude its ordinary
> tool-call Item from the persisted Turn**. Remove `PlanThreadItem` … A terminal
> Turn snapshot contains neither the Plan nor the `update_plan` tool call.

The stated rationale was avoiding a second durable execution projection. The
consequence, seen in a real run: the model emits a dozen visible `Thought`
rows deliberating about calling `update_plan` and **nothing ever appears**. The
reasoning leaks the action while the action stays hidden, so the agent reads as
thinking about a tool it never calls.

PM ruling, 2026-07-31: the session must reflect the complete, actual process.
That outranks the no-durable-projection preference, and this plan records the
reversal so the archived design is not read as still current.

## Non-goals

- No change to the pill. The Plan's *content* surface — the current step — is
  `agent-run-presentation-consistency` PR C and stays exactly as shipped.
- No second projection: the Item becomes the canonical record. The
  `turn/plan/updated` notification stays as the pill's ephemeral fast path, not
  as a competing history.
- No new Item type. `update_plan` becomes an ordinary tool call, which is
  removing a special case rather than adding a mechanism.
- No change to `update_plan`'s input contract or validation.

## Shape

Shape **(a): ONE complete feature in one PR.**

## Design

- **Executor.** `PiTurnExecutor.startTool` / `completeTool`
  (`:785-800`) drop the `update_plan` special case and its
  `transientToolCallIds` set. The call produces a `dynamicToolCall` Item like
  any other tool, so it flows into the transcript, grouping, Turn Diagnostics,
  history after reload, and Turn copy through the paths that already exist.
- **Wording.** The row must not read `Used update_plan`. `update_plan` maps to
  its own `ToolActivityKind` with human copy — "Updated the plan" / "Updating
  the plan" — and a subject-bearing variant naming the step count, so repeated
  calls in one group collapse to a single readable phrase rather than a stack
  of identical rows.
- **The pill is unaffected.** `turn/plan/updated` still publishes the snapshot
  the pill reads; that notification is already transient-by-construction and
  never reaches the rollout writer.
- **Spec.** `agent-thread-rendering.md`'s Plan paragraph states the new
  contract: the pill carries the current step, the tool call is recorded like
  any other, and the two are not alternatives.

## Open questions

None. The PM ratified the ordinary-tool-call shape on 2026-07-31, with the cost
(reversing #438, one bounded snapshot persisted per call, new copy required)
stated at ratification time.
