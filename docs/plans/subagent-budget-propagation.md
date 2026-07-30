# Subagent Budget Propagation — spawn-time token budgets over the existing Goal mechanism

Shape: **(b) a SET of three independent complete features, each its own PR.**
PR A shipped (#446). PR B is ordered behind `native-turn-kernel` (shipped —
claimable). PR C is ordered behind `threadservice-decomposition` (it touches
`spawnChild` and the ledger, which that PR's stage 3 relocates).

Motivation (2026-07-29 incident): one research fan-out burned ~1.5M input
tokens with no forward pressure — a single child Turn reached 586k input with
neither the parent nor the user able to see or stop it. The budget mechanism
(`ThreadGoal.tokenBudget` → `budgetLimited`) and the fan-out mechanism
(`spawn_agent`) both exist and are wired to nothing in common. This plan
connects the POLICY, but review of the first implementation (PR #446, gate
2026-07-30) proved that reusing `ThreadGoal` as the budget carrier is wrong:
an active Goal enrolls the child in `onThreadIdle` auto-continuation (the
runaway the feature exists to prevent), squats the single Goal slot the
child's own `create_goal` tool needs, and lets the child lift the breaker by
completing/replacing the Goal. The budget is therefore its own small
host-owned ledger; the Goal mechanism stays untouched.

## Sizing policy (PM-ratified 2026-07-30)

The budget is a **circuit breaker, not an allocation**. Empirical basis: local
usage data (legitimate subagent threads span 12k-432k totalTokens — a 35x
range, median 94k; the incident runaway at 682k sits only 1.6x above the
heaviest legitimate task), so no tight default can separate normal from
anomalous without false-killing real work. Industry evidence agrees: systems
that set tight per-subagent caps collect "my task died producing nothing" bug
reports (Claude Code issues #78460/#25569), while generous totals with
turn/spawn bounds go unremarked. An under-budget failure (task death) is far
worse UX than an over-budget one (bounded spend); the policy is therefore
asymmetric:

- **Global default 1,500,000 tokens, ON by default** (~3x the heaviest
  observed legitimate thread; worst case a runaway burns a few dollars before
  breaking). An opt-in breaker protects nobody — the 2026-07-29 incident had
  no one asking for budgets.
- **Soft landing before hard stop**: at 80% consumption the child receives one
  budget notice as a real steering input ("synthesize findings and conclude
  now") — converting task death into early completion. The hard stop is for
  children that ignore it.
- **Decision ladder**: explicit user directive in the prompt > parent model's
  per-spawn `max_total_tokens` > (future, data-driven) Role/Skill defaults >
  the global default. Launch ships the ladder's ends only.
- Budget measures `totalTokens` (includes cacheRead — work volume, not billed
  cost); the 1.5M default absorbs that inflation. CacheRead down-weighting is
  a deferred, data-informed follow-up.
- **User-irrelevance boundary (PM-ratified 2026-07-30): the token budget is a
  system fail-safe, not a user concept.** Humans never see or set token
  numbers: the runtime setting stays developer/ops-level config (no product
  settings UI); any user-visible rendering of an exhausted budget uses
  translated copy (task status + preserved results), never token counts; any
  future user-facing budget surface (task panel, notifications) speaks
  time/status first and money at most — tokens never. Model-facing surfaces
  (`max_total_tokens`, `wait_agent` fields, the 80% notice, the typed error
  read by the parent model) are system-internal and stay token-denominated.
  Open question (b) is to be read under this boundary.

## Goal

1. `collaboration.spawn_agent` accepts an optional token budget; spawning
   records it in a host-owned per-thread budget ledger (NOT a `ThreadGoal` —
   see Motivation). Usage is tallied into the ledger at the same
   per-Turn commit point that feeds `goals.addUsage`; exhaustion is derived
   (`tokensUsed >= tokenBudget`).
2. A `budgetLimited` child refuses further **non-user** Turn admission with a
   typed error the parent model sees; the human bright line stays — a
   user-triggered Turn is never budget-gated.
3. The parent model can see budget state: `tokensUsed` / `tokenBudget` join
   `CollaborationAgentView` (so `list_agents` and `wait_agent` report them).
4. (PR B) The budget also caps a Turn **in flight**: the kernel consults a
   budget port before every model call and settles the Turn gracefully when
   the budget is exhausted mid-Turn — the incident's actual failure mode.

## Non-goals

- No reservation/escrow sub-pools (nested carve-outs with refund semantics);
  PR C's single tree pool with optional per-child caps is the whole
  conservation model.
- No per-Role/Skill defaults yet (data-driven follow-up once the Goal usage
  ledger has a few weeks of distribution); launch carries the single global
  default from the Sizing policy.
- No cacheRead down-weighting in the budget measure at launch (deferred,
  data-informed).
- No new `TurnStatus`, no protocol-surface change beyond the two schema
  additions named below.
- No cost/currency budgets — tokens only, matching `ThreadGoal`.
- No change to Goal semantics: `GoalStore`, the continuation chain, and the
  child's goal tooling are untouched (the ledger is a sibling table, not a
  Goal). Sole allowance: `GoalExtension.onThreadIdle` catches the typed
  exhaustion error to record an accurate deferral reason (diagnostic-only).

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
- **Why the budget must not be a Goal** (verified, PR #446 review):
  `GoalExtension.onThreadIdle` starts a continuation Turn for ANY thread whose
  Goal is `active` (`GoalExtension.ts:70-84`) — a host-created active budget
  Goal makes every idle child restart itself until the budget exhausts;
  `GoalStore.create` throws on an existing unfinished Goal (single slot), so a
  pre-created budget Goal breaks the child's own `create_goal` tool; and
  `update_goal 'complete'` + `create_goal` without `token_budget` replaces the
  Goal and silently removes the breaker.
- Turn-admission refusals are `ThreadBusyError`, which `tryStartTurnIfIdle`
  converts to a soft `null` for feature callers (goal continuation,
  automations); a plain `Error` there permanently fails automation runs.
- `sendCollaborationMessage` drains the child's mailbox BEFORE admission — any
  gate that throws after the drain loses the queued messages.
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
2. **Budget ledger + spawn wiring**: a `thread_budgets` table beside the
   goals table in `goals.sqlite` (`threadId`, `tokenBudget`, `tokensUsed`),
   owned by a small `SubagentBudgetLedger` (sibling of `GoalStore`; ephemeral
   threads mirror in memory like `GoalExtension.ephemeralGoals`). Spawn
   (`spawnChild`, one validation site) records the budget for the child;
   `ThreadService.executeActiveTurn` tallies `totalTokens` into the ledger at
   the same commit point as `goals.addUsage`. Thread deletion removes the
   record (join the existing descendant-teardown list). The child has NO tool
   surface over the ledger — the breaker is host-imposed and child-unliftable;
   the child's own `create_goal`/`update_goal` behave exactly as on main.
   Applies uniformly to collaboration and isolated-Skill children.
3. **Admission gate** (`ThreadService`, the single Turn-admission choke
   point): if the target Thread HAS a budget-ledger record (only host-budgeted
   children ever do — root threads and self-made Goals are structurally out of
   scope), the record is exhausted, AND the trigger is NOT `{ kind: 'user' }`,
   refuse admission with a typed `SubagentBudgetExhaustedError` carrying
   `Subagent token budget exhausted (<used> of <budget> tokens); the child
   refuses new work. Interrupt, review its output, or spawn a fresh child.`
   Refusal semantics preserve the existing soft-refusal invariant:
   `tryStartTurnIfIdle` converts it to `null` exactly like `ThreadBusyError`
   (automations stay pending; goal continuation simply does not run), while
   the collaboration paths (`followupCollaborationTask`,
   `sendCollaborationMessage`) surface the message verbatim to the parent as
   a tool error. `sendCollaborationMessage` checks the gate BEFORE draining
   the mailbox so queued messages survive a refusal. A user-triggered Turn is
   never gated (bright line; test), and a user Turn on an exhausted child
   still runs with the ledger continuing to tally. The bright line is an
   admission-level invariant (defense-in-depth), NOT a product journey:
   children have no composer, so user-facing recovery from exhaustion is
   parent respawn/synthesis plus the transcript artifact (PM ruling
   2026-07-30; see `agent-subagent-interaction.md`). Per A12 this is an
   admission-boundary invariant — fail-closed is correct here.
4. **Concurrency & failure-path contract** (gate pass 2 rulings, normative):
   accrual runs INSIDE the completion `threadMutex` callback before
   `activeTurns.delete`/idle status, so admission racers always see
   post-accrual state; failure finalize paths (`failActiveTurn`) accrue
   recorded usage too (hard-crash in-flight loss is a documented residual,
   shrunk by PR B); the mailbox is snapshot+deleted synchronously BEFORE the
   admission await and re-inserted at the head on refusal; steering an ACTIVE
   child Turn is never gated (the sanctioned overshoot mitigation) — the gate
   guards new-work admission only; `SubagentBudgetExhaustedError` propagates
   typed (own module) — `GoalExtension.onThreadIdle` catches it to defer with
   the real message (narrow diagnostic-only Goal-file allowance) and
   `AutomationDispatcher` marks the run failed with the accurate message;
   an exhausted budgeted sender cannot spawn, and a budgeted spawner's
   children default to `min(globalDefault, spawner remaining)` (subtree
   accounting stays deferred; residual documented). The ledger shares the
   goals.sqlite connection, lives with the host-owned stores (not
   `extensions/goal/`), accrues only for child threads, and derives its write
   target from the record's location.
5. **Visibility** (`ThreadService.listCollaborationAgents` +
   `collaborationWaitResult`): populate `tokensUsed`/`tokenBudget` from the
   budget ledger (0/null when absent). No renderer work required.
6. **Global default** (`agentSettings.ts` runtime settings): new
   `subagentTokenBudget: number | null` with default `1_500_000`; `null`
   disables. Applied in `spawnCollaborationAgent` when the spawn carries no
   `max_total_tokens` — uniformly for collaboration AND isolated-Skill
   children (one breaker, no special cases). The spawn parameter overrides;
   the setting is the floor of the decision ladder.
7. **Spec** (same PR): `docs/spec/agent-subagent-threads.md` gains a "Budgets"
   subsection (sizing policy, spawn parameter, default, Goal reuse,
   admission-gate rule, bright line); `docs/spec/agent-tool-design.md`
   collaboration table row updated.

Not touched in PR A (tripwire): `src/main/agent/runtime/kernel/**` and
`src/main/agent/runtime/PiTurnExecutor.ts` (the loop surface the tripwire
exists to protect); `GoalStore.ts` semantics; any codec beyond the two schema
additions. The former `ToolRuntime` `spawn_agent` carve-out retired in
`toolruntime-handler-contribution`; collaboration handlers now come from their
owning domain module.

## Design — PR B: mid-Turn enforcement (after `native-turn-kernel`)

One complete feature: the budget caps the Turn in flight, not just between
Turns. Depends on the kernel because its natural insertion point is the loop's
model-call boundary; building it pre-kernel would mean one more stream-wrapper
— the exact pattern `native-turn-kernel` exists to eliminate.

1. **Port** (`runtime/types.ts`): optional
   `remainingTokenBudget?: () => number | null` on `TurnExecutionContext` —
   `null` = unlimited; computed by ThreadService from the budget ledger as
   `tokenBudget - tokensUsed` at Turn start (committed usage; the in-flight
   Turn's own usage is the kernel's to add).
2. **Kernel check** (`kernel/kernel.ts`, start of each iteration before
   projection): if `remaining !== null` and
   `normalizer-accumulated turn usage >= remaining`, stop: settle the Turn as
   `'interrupted'` with error
   `Token budget exhausted mid-Turn (<total> of <budget> tokens)` — reusing
   the existing interrupted path (no new `TurnStatus`). The subsequent ledger
   commit marks the record exhausted, and PR A's gate takes over from there. The first model call is never blocked (a fresh Turn with
   an already-exhausted budget is PR A's admission gate's job, not the
   kernel's).
3. **Soft landing at 80%**: the same per-call check, on first crossing 80%
   of the budget, triggers `onBudgetWarning(actuals)` (a
   `TurnExecutionContext` callback beside the port); ThreadService delivers
   ONE budget notice through the EXISTING steering path — a real, canonical,
   diagnostics-captured steering input carrying ACTUAL figures (never the
   reconstructed threshold): `[Budget notice] ~80% of the token budget is
   consumed (<used> of <budget>). Synthesize your findings and conclude now.`
   Once per Turn. The callback is ADVISORY under A12: its delivery failure is
   caught, logged, and never changes turn status.
4. **Diagnostics**: the settle records a normal interrupted outcome; no new
   activity type. The budget numbers appear in the error string only.
5. **Tests**: kernel unit test with a scripted gateway (two calls, budget
   exhausted after the first → exactly one provider call, Turn interrupted,
   goal flips after commit); ThreadService integration test for the
   PR A + PR B interplay.

## Design — PR C: budget conservation + structural gates (after `threadservice-decomposition`)

**Normative contract (gate pass 2026-07-30, 10 findings — these rules replace
any conflicting earlier wording):**

1. **One resolution authority.** A single ancestor-walk function is the ONLY
   way anything (spawn binding, admission gate, mid-turn port, accrual, views)
   answers "which pool covers this thread". Member rows record caps, not an
   alternative pool binding; a recorded binding that disagrees with the walk
   degrades (re-bind + audit log) — pool-mismatch throws are reserved for the
   CREATE write boundary (A12).
2. **Gate and debit share one predicate.** A thread is pool-covered iff the
   resolution finds a pool; then it is BOTH gated and accrued. No
   gated-but-never-debits state can exist.
3. **Single pool per tree, by construction.** Pool creation happens only when
   the walk finds NO ancestor pool; otherwise the spawn joins the existing
   pool. An explicit `max_total_tokens` where no ancestor pool exists CREATES
   a pool of that size anchored at the child (descendants join it) — closing
   the uncapped-descendant escape; with an ancestor pool it is a per-child
   cap within that pool.
4. **Live pool view under concurrency.** The mid-turn port never uses a
   turn-start snapshot: remaining = persisted pool usage (re-read per call)
   minus the in-memory in-flight tally that every active Turn in the tree
   updates at its model-call boundaries. Sibling overrun is bounded by one
   model call per sibling, not by N x pool.
5. **All accrual paths guarded (A12).** Ledger errors on the accrual/read
   path log + audit and never change turn status.
6. **Structural gates scope: collaboration children only.** Isolated-skill
   children are exempt from both the depth-2 and count-16 gates (leaf-only,
   host-created, bounded). The count stays lifetime + MAX-monotonic for
   collaboration spawns.
7. **Grant fixed at pool creation, documented.** A tree's pool budget is the
   setting value when the pool is created; setting changes govern NEW trees
   (setting description says so). User control over a live tree is interrupt.
8. **Views mirror the enforced binding.** Cap-only members report cap
   usage/cap; pool members report pool totals; a view may never contradict a
   refusal message.
9. **Typed error codes across the seam.** `Turn.error.code` carries stable
   codes (`subagent_budget_exhausted`, `subagent_structural_limit`); the
   renderer classifies by code, never by copy regex.


One complete feature: close the mint. PR A/B bound the SLOPE of runaway spend
(per-child breakers, mid-Turn stop); PR C bounds the TOTAL by construction and
adds the two legibility gates, superseding the min(default, spawner-remaining)
patch.

1. **Tree pool (conservation).** The ledger re-keys from per-child records to
   ONE pool per root-most spawning thread: when an unbudgeted thread first
   spawns, it receives the pool record (default 1,500,000; the pool covers
   DESCENDANT usage only — the spawner's own user-driven Turns never debit or
   gate against it, preserving the bright line). Every descendant resolves its
   pool by walking `parentThreadId` to the nearest pool holder; accrual debits
   the pool; `assertSubagentBudgetAvailable` reads the pool. By induction,
   subtree spend <= the root grant regardless of tree shape — the
   grandchild-evasion residual disappears and the min() patch retires.
   `max_total_tokens` on spawn becomes an optional PER-CHILD CAP within the
   pool (a child refuses further non-user work once its own contribution
   reaches the cap) — no sub-pools, no refunds. `CollaborationAgentView`
   fields are reinterpreted without schema change: `tokenBudget` = pool total,
   `tokensUsed` = pool spent (per-child contribution stays internal); spec and
   tool descriptions updated to match.
2. **Structural gates (legibility, admission-time, constants not settings):**
   spawn refuses when the child would exceed depth 2 (taskPath segments:
   `/root/a/b` is the deepest allowed spawner=a, child=b... concretely: a
   thread at depth 2 cannot spawn) or when the spawner's lifetime spawn count
   would exceed 16 (counted from spawn edges, A11-style). Both refusals use
   `SubagentBudgetExhaustedError`-adjacent typed errors with actionable
   messages naming the limit. Constants live beside the ledger; changing them
   is a one-line diff plus a PM nod.
3. **User-visible copy translation (renderer).** Wherever a budget-typed
   failure reaches a user surface (mid-Turn interrupted error text from PR B,
   automation failure records), the renderer maps it to translated copy
   (task reached its resource limit; results preserved) — token numbers never
   render. Model-facing text unchanged.
4. **Tests:** conservation (N children share one pool; pool exhaustion refuses
   across the whole tree; spawner's own user Turns unaffected), per-child cap
   within pool, depth refusal at 2, count refusal at 16, view
   reinterpretation, copy mapping. Real run: a two-level fan-out sharing one
   pool, exhaustion mid-tree, user bright line intact.

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

Non-blocking, deferred by design: (a) per-Role/Skill defaults once the Goal
ledger has real distribution data; (b) surfacing budget state in the subagent
task panel UI beyond the Goal pane (renderer polish, fast-track);
(c) cacheRead down-weighting in the budget measure. Former open question on a
global default was resolved by the 2026-07-30 Sizing policy: shipped in PR A,
ON by default. Isolated-Skill children take the same default (resolved).

## Checklist

- [ ] PR A: schema + spawn wiring + admission gate + visibility + global
      default (1.5M, ON, null disables) + spec + tests
- [ ] PR A real-run: exceed, refusal, user bright line
- [ ] PR B (after native-turn-kernel): budget port + kernel check + 80%
      soft-landing steering notice + tests
- [ ] PR C (after threadservice-decomposition): tree-pool conservation +
      depth-2/count-16 gates + renderer copy translation + tests
- [ ] PR B real-run: mid-Turn interruption
