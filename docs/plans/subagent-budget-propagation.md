# Subagent Budget Propagation — spawn-time token budgets over the existing Goal mechanism

Shape: **(b) a SET of two independent complete features, each its own PR.**
PR A is buildable now; PR B is ordered behind `native-turn-kernel` (genuine
dependency: its enforcement point is the kernel's model-call boundary).

Motivation (2026-07-29 incident): one research fan-out burned ~1.5M input
tokens with no forward pressure — a single child Turn reached 586k input with
neither the parent nor the user able to see or stop it. The budget mechanism
(`ThreadGoal.tokenBudget` → `budgetLimited`) and the fan-out mechanism
(`spawn_agent`) both exist and are wired to nothing in common. This plan
connects them; it introduces **no new concepts**.

## Goal

1. `collaboration.spawn_agent` accepts an optional token budget; spawning
   creates a child `ThreadGoal` carrying it. Child usage already flows into the
   Goal after every Turn; exhaustion flips it to `budgetLimited` through the
   existing store logic, unchanged.
2. A `budgetLimited` child refuses further **non-user** Turn admission with a
   typed error the parent model sees; the human bright line stays — a
   user-triggered Turn is never budget-gated.
3. The parent model can see budget state: `tokensUsed` / `tokenBudget` join
   `CollaborationAgentView` (so `list_agents` and `wait_agent` report them).
4. (PR B) The budget also caps a Turn **in flight**: the kernel consults a
   budget port before every model call and settles the Turn gracefully when
   the budget is exhausted mid-Turn — the incident's actual failure mode.

## Non-goals

- No subtree/aggregate budgets (a parent budget covering grandchildren):
  double-counting semantics are not worth the complexity now. Per-child only.
- No default budget in runtime settings in this plan (deferred, PM-decidable
  later; the spawn parameter is optional and absent means unlimited, exactly
  today's behavior).
- No new `TurnStatus`, no protocol-surface change beyond the two schema
  additions named below.
- No cost/currency budgets — tokens only, matching `ThreadGoal`.
- No change to GoalStore semantics, the continuation chain, or renderer Goal
  UI beyond what the added fields imply.

## Current state (verified facts)

- `ThreadGoal` (`src/core/agent/goal.ts`): `objective`, `status`
  (`active | paused | blocked | usageLimited | budgetLimited | complete`),
  `tokenBudget: number | null`, `tokensUsed`, `timeUsedSeconds`.
  `GoalStore.create(threadId, objective, tokenBudget)` validates a positive
  safe integer (`GoalStore.ts:71-74`); `GoalStore.addUsage` flips status to
  `budgetLimited` when `tokensUsed >= tokenBudget` (`GoalStore.ts:123-132`).
  `GoalExtension` mirrors both for ephemeral threads and publishes
  `goal/updated` on create/update/addUsage (`GoalExtension.ts:37-63`).
- Usage is committed once per Turn, after completion:
  `this.goals.addUsage(threadId, turn.execution.usage.totalTokens, …, turnId)`
  in `ThreadService.executeActiveTurn`.
- Continuation gating already respects the budget: `GoalExtension.onThreadIdle`
  admits a continuation only for `status === 'active'`
  (`GoalExtension.ts:70-84`) — `budgetLimited` stops the chain today.
- **No spawn ↔ Goal wiring exists** (verified: no goal reference in
  `spawnCollaborationAgent`, `ThreadService.ts:2249`).
- `spawn_agent` input schema: `task_name`, `message`, `fork_turns`,
  `agent_type`, `model`, `reasoning_effort` (`src/core/agent/tools.ts:297-304`).
- `CollaborationAgentView`: `taskPath`, `threadId`, `parentThreadId`,
  `nickname`, `role`, `status` (`ThreadService.ts:309-316`), mirrored in
  `collaborationAgentViewSchema` (`tools.ts`) used by `list_agents` and the
  post-#444 `wait_agent` output.
- Mid-Turn usage exists in memory: `PiEventNormalizer.usage`
  (`MutableTurnUsage`) accumulates per assistant `message_end`
  (`PiTurnExecutor.ts:655+`), but nothing reads it before Turn completion.

## Design — PR A: budget contract, admission gate, visibility (buildable now)

One complete feature: spawn-time budgets that bound a child across Turns and
are visible to the parent.

1. **Schema** (`src/core/agent/tools.ts`): add optional
   `max_total_tokens: numberSchema('Optional total token budget for the child
   Thread. Omit for unlimited.')` to `spawnAgentSchema`. Add
   `tokensUsed: { type: 'number' }` and `tokenBudget: { type: ['number','null'] }`
   to `collaborationAgentViewSchema` (required fields; `tokensUsed` is 0 and
   `tokenBudget` null when no Goal exists). Update the `spawn_agent` and
   `wait_agent` descriptions to state the budget contract in one sentence each.
2. **Spawn wiring** (`ThreadService.spawnCollaborationAgent`,
   `ToolRuntime` spawn handler): validate `max_total_tokens` as a positive
   safe integer; after child creation, call the Goal extension's `create` with
   objective `Subagent task: ${taskName}` and the budget. Applies to
   `childKind: 'collaboration'` spawns; isolated-Skill children may pass one
   too (same code path) but no caller sets it in this PR.
3. **Admission gate** (`ThreadService`, the single Turn-admission choke point
   used by followup/send/steer/continuation/automation triggers): if the
   target Thread's Goal is `budgetLimited` AND the trigger is NOT
   `{ kind: 'user' }`, refuse admission with error
   `Subagent token budget exhausted (<used> of <budget> tokens); the child
   refuses new work. Interrupt, review its output, or spawn a fresh child.`
   The refusal surfaces through the existing tool-error path so the parent
   model reads it verbatim. Per A12 this is an admission-boundary invariant —
   fail-closed is correct here. A user-triggered Turn on the child is never
   gated (bright line; add a test).
4. **Visibility** (`ThreadService.listCollaborationAgents` +
   `collaborationWaitResult`): populate `tokensUsed`/`tokenBudget` from the
   Goal extension (0/null when absent). No renderer work required — the Goal
   pane already reflects `goal/updated`.
5. **Spec** (same PR): `docs/spec/agent-subagent-threads.md` gains a "Budgets"
   subsection (spawn parameter, Goal reuse, admission-gate rule, bright line);
   `docs/spec/agent-tool-design.md` collaboration table row updated.

Not touched in PR A (tripwire): `src/main/agent/runtime/kernel/**` and
`src/main/agent/runtime/PiTurnExecutor.ts` (the loop surface the tripwire
exists to protect); `GoalStore.ts` semantics; any codec beyond the two schema
additions. **Narrow allowance** (fixes a self-contradiction an earlier
revision had with Design step 2, which always named this handler):
`runtime/ToolRuntime.ts` may change ONLY inside the `spawn_agent`
collaboration handler (`:191-205`) — validate and pass `max_total_tokens`
through to `spawnCollaborationAgent`; the file's diff must contain nothing
outside that handler (plus a validator helper if none fits).

## Design — PR B: mid-Turn enforcement (after `native-turn-kernel`)

One complete feature: the budget caps the Turn in flight, not just between
Turns. Depends on the kernel because its natural insertion point is the loop's
model-call boundary; building it pre-kernel would mean one more stream-wrapper
— the exact pattern `native-turn-kernel` exists to eliminate.

1. **Port** (`runtime/types.ts`): optional
   `remainingTokenBudget?: () => number | null` on `TurnExecutionContext` —
   `null` = unlimited; computed by ThreadService as
   `tokenBudget - goal.tokensUsed` at Turn start (committed usage; the
   in-flight Turn's own usage is the kernel's to add).
2. **Kernel check** (`kernel/kernel.ts`, start of each iteration before
   projection): if `remaining !== null` and
   `normalizer-accumulated turn usage >= remaining`, stop: settle the Turn as
   `'interrupted'` with error
   `Token budget exhausted mid-Turn (<total> of <budget> tokens)` — reusing
   the existing interrupted path (no new `TurnStatus`). The subsequent
   `addUsage` commit flips the Goal to `budgetLimited`, and PR A's gate takes
   over from there. The first model call is never blocked (a fresh Turn with
   an already-exhausted budget is PR A's admission gate's job, not the
   kernel's).
3. **Diagnostics**: the settle records a normal interrupted outcome; no new
   activity type. The budget numbers appear in the error string only.
4. **Tests**: kernel unit test with a scripted gateway (two calls, budget
   exhausted after the first → exactly one provider call, Turn interrupted,
   goal flips after commit); ThreadService integration test for the
   PR A + PR B interplay.

## Verification

- PR A: `bun run typecheck`; `test:core` (new: GoalExtension spawn wiring,
  admission-gate refusal + user bright line, view/schema codecs);
  `test:renderer`; `docs:check`. Real run (dev userData): spawn a child with
  `max_total_tokens: 2000`, let it exceed across two Turns, confirm
  `wait_agent` shows `budgetLimited` usage, a `followup_task` is refused with
  the typed error, and a user-typed message into the child thread still runs.
- PR B: kernel unit tests above; real run with a small budget confirming
  mid-Turn interruption after the in-flight call completes, and that PR A's
  gate refuses the next non-user Turn.
- Tripwire (both PRs): allowed-file lists as stated per PR; any file outside
  them fails the gate.

## Open questions

Non-blocking, deferred by design: (a) a runtime-settings default budget for
all spawns (PM decision, separate fast-track if wanted); (b) surfacing
budget state in the subagent task panel UI beyond the Goal pane (renderer
polish, fast-track); (c) whether isolated-Skill invocations should default to
a budget once (a) exists.

## Checklist

- [ ] PR A: schema + spawn wiring + admission gate + visibility + spec + tests
- [ ] PR A real-run: exceed, refusal, user bright line
- [ ] PR B (after native-turn-kernel): budget port + kernel check + tests
- [ ] PR B real-run: mid-Turn interruption
