# Subagent Task Outcome Contract

Shape: **(a) ONE complete feature in one PR.** Protocol, runtime,
persistence, notifications, renderer, tests, and current specs land together;
shipping only one layer would preserve the same false-completion bug elsewhere.

## Goal

### Purpose

Make delegated Agent work truthful and resumable when one execution stops
before its assignment is complete. Separate three facts that currently collapse
into `completed`:

1. **Execution lifecycle** - how one Agent generation stopped.
2. **Assignment outcome** - whether that generation satisfied the delegated
   request or still needs work.
3. **Resource budget** - the circuit breaker for one generation, independent of
   both lifecycle and task semantics.

## Non-goals

- Do not create a `ThreadGoal` for every delegation. Exploratory work may have
  no durable Goal, and must not inherit Goal auto-continuation or occupy the
  Thread's one Goal slot.
- Do not infer completion from prose, a normal provider stop, elapsed time,
  token use, tool count, or the absence of an error.
- Do not force a summarization call after interruption or automatically resume
  incomplete work.
- Do not generate success criteria, decompose tasks, add currency budgets, or
  expose token controls in product UI.
- Do not change root Goals, context compaction, isolated-Skill result ownership,
  permissions, worktrees, depth/concurrency limits, or user-stop authority.
- Do not ship a compatibility reader for the old pre-release execution/budget
  rows or notification envelope.

## Design

### Decision

Every `agent` spawn and terminal-Agent `agent_message` resume starts one
**assignment generation**. The prompt may be precise, exploratory, or
ambiguous; the host does not manufacture stronger criteria than the caller
supplied. The generation starts `active` and receives one delegated-only tool:

```ts
update_assignment({ status: 'complete' | 'needs_followup' | 'blocked' })
```

`complete` means the Agent believes the requested scope for this generation is
satisfied as reasonably understood, not that its parent task or project is
complete. `needs_followup` covers bounded exploration, unresolved scope, and
useful partial progress. `blocked` requires input or an external-state change.

A normal stop without a declaration settles as `needsFollowup`, never
`complete`. This can produce a false negative when a model forgets the tool,
but cannot promote partial work into false success. No status schedules another
provider call.

The existing `1,500,000` token default becomes a **per-generation circuit
breaker**, not a shared request-tree pool. Siblings cannot consume one another's
allowance. A budget-limited generation returns a checkpoint and is resumable
under the same Agent ID and transcript; an explicit resume starts a new
generation with a fresh breaker.

### Evidence, constraints, and rejected alternatives

The triggering development session had a `1,500,000`-token shared pool. Its
four initial children consumed `601,836`, `295,740`, `372,895`, and `455,090`
tokens: `1,725,561` together, while no child approached the breaker alone.
Three were interrupted. Cache reads were approximately 64% of usage. Repair and
repeated synthesis later took the conversation to approximately `6.116M`
tokens and `$9.34`; the shared cutoff did not produce a cheaper completed task.

The inspected `Coding/.research-repos/cc-2.1` snapshot has no equivalent shared
delegation-tree token pool. It relies on compaction, transcript resume, and
partial-output preservation on kill. Tenon adopts those continuity properties,
but not its ambiguous reuse of `completed` for process and task lifecycle.

Rejected options:

- Raising the shared pool only moves the sibling-starvation threshold.
- Disabling every default cap leaves one vague or runaway generation unbounded.
- Reusing `ThreadGoal` adds the wrong objective and continuation semantics; the
  archived `subagent-budget-propagation` plan already rejected Goal as the
  resource carrier.
- A forced near-limit summary is not evidence of completion and consumes the
  resource whose exhaustion caused it.

### State contract, flow, and requirements

**FR-01: Execution lifecycle.** Rename delegated terminal `completed` to
`finished`. `SubagentExecutionStatus` is `running | finished | failed |
interrupted | killed`; the underlying Turn keeps its current vocabulary.
`finished` means only that the provider loop reached its ordinary stop.

**FR-02: Assignment outcome.** Add `SubagentTaskStatus`: `active | complete |
needsFollowup | blocked | budgetLimited`. `active` is live-only. Terminal
settlement freezes one of the other four for that exact generation.

**BR-01: Settlement matrix.** Only `(finished, complete)` is a result:

| Execution | Declaration / cause | Task | Payload |
| --- | --- | --- | --- |
| `finished` | `complete` | `complete` | `result` |
| `finished` | `blocked` | `blocked` | `checkpoint` |
| `finished` | follow-up or none | `needsFollowup` | `checkpoint` |
| `interrupted` | generation budget | `budgetLimited` | `checkpoint` |
| failed, other interrupted, or killed | any | `needsFollowup` | `checkpoint` |

A checkpoint contains only useful text already recorded in the Turn, after the
existing output scan. If none exists, omit it; the host invents nothing. Error
and usage remain separate. A completion declaration is provisional until a
normal stop, so a later failure cannot become a completed deliverable.

**BR-02: Steering reopens the decision.** Accepting steering into a running
generation resets its declaration to `active` before delivery. The Agent must
assess the expanded request again.

**BR-03: Resume is explicit.** Resume keeps Agent ID, Thread, transcript,
configuration, model, and worktree; it increments execution generation, resets
task status to `active`, and creates a fresh generation budget. No checkpoint,
blocked state, or warning auto-resumes. Unrelated work should normally use a
new Agent; this remains guidance rather than prompt classification.

```text
spawn or explicit resume
  -> running + active
  -> finished + complete       -> result
  -> finished + needsFollowup  -> checkpoint
  -> finished + blocked        -> checkpoint
  -> interrupted + budgetLimited -> checkpoint
  -> failed/interrupted/killed + needsFollowup -> checkpoint
```

### Delegated control tool

**FR-03:** Add `update_assignment` to the canonical tool catalog and
`ToolRuntime`. It is host-required for every foreground/background collaboration
Agent, including `explore`, `plan`, and Role-backed Agents; Role narrowing and a
parent tool subset cannot remove it. Root Threads and isolated Skills do not see
it. There is no summary argument that could overwrite canonical assistant text.

The stable delegated prompt says the request is an assignment, not necessarily
a Goal; the Agent must not broaden ambiguous scope to manufacture certainty;
it uses `needs_followup` after a bounded exploratory pass and calls `complete`
only when no material requested work remains. Declarations are guarded by
`{agentId, generation, currentTurnId}`. Repeated calls are last-write-wins until
terminal settlement; a stale call cannot mutate a resumed generation.

### Durable outcome, failure, and recovery

**FR-04:** Extend `SubagentExecutionLedger`, not Goal storage. The current
execution row carries the provisional declaration; `SubagentGenerationSnapshot`
includes it for admission rollback. Each terminal notification persists frozen
execution/task statuses, terminal error, and later the exact parent
`deliveryTurnId`. Delayed delivery and subsequent resume therefore cannot
relabel historical output.

`SubagentExecutionProjection` exposes both current statuses, typed terminal
error, and the durable delivery link. This fully absorbs the board's
`subagent-projection-error-surface` item: cold reopen retains failure detail,
and a settled-but-undelivered child Turn cannot shift report cards through the
current count-from-the-end join. Missing inspection-only projection data
degrades to `needsFollowup` and an unlinked checkpoint under A12; it cannot fail
a user Turn.

Initial admission, declaration, steering reset, generation advance,
notification freeze, delivery link, and rollback use existing transaction and
compare-and-set boundaries. An older terminal pipeline cannot overwrite a
resumed generation.

### Per-generation budget

**FR-05:** Preserve request ownership/cancellation, but remove shared sibling
debiting from the default resource policy. `subagentTokenBudget` remains
`1_500_000` by default and applies separately to each child execution
generation; `null` still disables it explicitly. Budget state is keyed by
`{agentId, generation}`. Resume starts at zero. Isolated Skills use the same
child-runtime breaker but keep Skill-owned output semantics and no assignment
tool.

If `SubagentRequestLedger` retains cancellation ownership, split or rename its
API so ownership cannot be mistaken for a shared allowance. SQLite and
transaction helpers may be reused; shared sibling debiting may not survive
under another name. Existing depth, live concurrency, stop, and ownership
closure continue to bound structure and cancellation.

The 80% notice says not to claim completion unless the assignment is complete;
otherwise preserve verified progress, unknowns, and next work before the stop.
Hard exhaustion uses the existing typed kernel interruption and performs no
extra provider call. Transcript, Items, partial text, worktree, tool results,
and usage settle before notification. An already accepted final answer keeps
the existing last-call overshoot rule.

### Output and parent contract

**FR-06:** Foreground results and background notifications use one semantic
encoder with explicit `execution-status` and `task-status` elements. Preserve
the non-user boundary, IDs, output file, error, usage, worktree, XML escaping,
and scanner. A complete envelope names its payload `result`; every other useful
payload is `checkpoint`.

Launch/resume copy promises notification when the **run settles**, not when the
task completes. Parent guidance says a checkpoint is incomplete evidence: it
may synthesize verified facts, but must not report the assignment as complete.
A continuation should name the missing work or clarification rather than
reflexively replay `continue`.

### Renderer behavior

**FR-07:** `subagentPresentation` keeps execution and task state separate.
Anchors, the work strip, report cards, and Agent detail use translated combined
labels such as `Finished - Complete`, `Finished - Needs follow-up`, `Finished -
Blocked`, `Interrupted - Budget limited`, and `Failed - Needs follow-up`.
Token counts remain absent from product UI. Current child Turn state is live
truth; the durable projection is settled truth after cold reopen.

Report cards title only complete output `Result`; other useful output is
`Checkpoint`. Bulk **Delete finished Agents** excludes any subtree containing
`needsFollowup`, `blocked`, `budgetLimited`, live, or queued work. Explicit
single-Agent deletion remains available after inspection.

## Open Questions

None before implementation. Reconsider a separate opt-in aggregate request
ceiling only if post-ship telemetry shows repeated explicit resumes or broad
fan-out, rather than one-generation runaway, is the dominant cost failure. It
must remain independent of assignment outcome.

## Files And Ownership

- `src/core/agent/tools.ts`, `src/core/agent/protocol.ts`, and
  `src/core/agent/codec.ts` - canonical tool/status/projection contracts.
- `ToolRuntime`, `subagentToolPolicy`, `SubagentExecutionLedger`,
  `SubagentRequestLedger`, `TurnLifecycle`, and `SubagentCollaboration` - guarded
  declaration, generation budget, settlement, resume, and rollback.
- `subagentOutput` and `subagentExecutionProjection` - one outcome encoder and
  durable projection.
- `agentSettings` - unchanged numeric default, revised per-generation meaning.
- `subagentPresentation`, Agent anchor/work-strip/detail components, i18n, and
  deletion eligibility - dual-state UI.
- Focused Core, renderer, E2E, codec, tool-catalog, restart, and parity fixtures.
- `agent-subagent-threads`, `agent-thread-rendering`, `agent-tool-design`, and
  affected Goal/runtime specs.

The Core tool/protocol files are shared surfaces and need coordinated ownership.
Dev agents do not edit `docs/TASKS.md` or `CHANGELOG.md`; main owns the absorbed
board item and changelog at merge.

## Risks

- A model may omit `update_assignment`; the safe default is `needsFollowup`,
  pinned by prompt/tool fixtures with no heuristic fallback.
- Per-generation caps allow more aggregate fan-out spend. That is the deliberate
  trade for failure isolation; depth, concurrency, explicit stop, and visible
  generation resumes remain.
- A parent may repeatedly resume checkpoints. No runtime continuation exists,
  and parent guidance requires a concrete missing gap before resume.
- Partial output can still be wrong. `checkpoint` states provenance, not quality;
  scanning and the untrusted-output boundary remain.
- Broad protocol scope raises regression risk. Foundation lands before
  consumers, persistence is a clean cut, and the full relevant gate runs.

## Collision Result

- PR #568 (`long-message-disclosure-anchor`) overlaps
  `agent-thread-rendering` and adjacent renderer code. It should land first;
  this branch rebases afterward.
- Draft PR #567 (`provider-retry-state-machine`) plans terminal-error,
  `ThreadService`, `threadStore`, and runtime/rendering-spec work. There is no
  semantic dependency; whichever implementation is approved first lands first,
  and the second adopts its terminal-error shape.
- `subagent-projection-error-surface` is absorbed, not parallel work.
- With #567 and this plan, the significant review queue is at its cap of two;
  #568 is a small fix already through implementation review.

## Acceptance Criteria

- **AC-01:** A normal Agent stop without declaration is `finished +
  needsFollowup` and exposes only a checkpoint.
- **AC-02:** Only a normal stop after `complete` is `finished + complete` and
  exposes a result; later steering, failure, interrupt, or kill prevents it.
- **AC-03:** Failed, interrupted, killed, blocked, and undeclared generations
  preserve useful scanned partial text without a forced provider call.
- **AC-04:** Exhausting one generation's default budget does not debit or stop a
  sibling. Each of the four measured incident children fits independently.
- **AC-05:** Explicit resume preserves identity/history/worktree, increments
  generation, resets task state, and receives a fresh breaker without erasing
  the prior checkpoint.
- **AC-06:** Crash recovery preserves the exact historical execution status,
  task status, error, payload label, and delivery Turn idempotently.
- **AC-07:** No incomplete status or budget warning starts hidden work.
- **AC-08:** All collaboration Agent types see `update_assignment` despite Role
  narrowing; roots and isolated Skills do not.
- **AC-09:** Cold-reopened chips, report cards, strip, and detail agree without
  loading every child Turn or joining deliveries by ordinal.
- **AC-10:** Bulk cleanup preserves every incomplete, live, or queued subtree.
- **AC-11:** Root Goals, isolated-Skill delivery, permissions, worktree
  retention, user-stop boundaries, depth, and concurrency behavior regress none.

## Build Checklist

- [ ] Add canonical statuses, `update_assignment`, clean-cut codecs, ledger
  fields, and transaction/rollback tests.
- [ ] Separate request ownership from generation budgets and prove sibling
  isolation in kernel/admission/accrual tests.
- [ ] Freeze two-axis outcomes, unify foreground/background payload semantics,
  and persist error plus delivery Turn across restart races.
- [ ] Update renderer states, checkpoint naming, deletion safety, i18n, and
  light/dark E2E evidence.
- [ ] Fold behavior into current specs; run `bun run typecheck`,
  `bun run test:core`, `bun run test:renderer`, targeted Agent E2E,
  `bun run docs:check`, and visual verification before marking ready.
