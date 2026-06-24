# Agent Goal — a nested, autonomous control loop for long-running objectives

## Goal

Let a user hand a long-running **objective** to the agent and have it pursued
**autonomously**, across many execution attempts, until the objective is
**independently verified** complete — not until the model decides to stop.
Mid-flight the owner can watch progress, steer, reassign, or abandon; on a
terminal outcome the result is delivered back to the conversation.

Stated precisely, this is a **nested supervisory control system**: the user gives a
setpoint (the Goal), an autonomous control loop drives toward it (plan → act →
sense → audit → repeat), and the loop self-terminates on verified completion or
escalates. The loop is **self-similar** — a goal-shaped subtask becomes a sub-Goal
with the same loop one level down, so one minimal unit covers arbitrary depth. The design adds exactly **one new fact object — `Goal`** — and reuses
the existing execution machinery (Runs, fork delegation, completion notification,
usage accounting, the `agent_child_run_*` controls, the permission gate) for
everything else.

## Non-goals

- **No new execution primitive.** `Run` is unchanged and stays single-attempt.
  Persistence is the **Goal's control loop**, not a `Run` continuation mode.
- **`Goal` is not a `Run`.** A Goal is durable intent that outlives, and survives
  the failure of, any single Run (an assignment outlives the employee). It carries
  **no execution machinery** — no scheduler of its own, no tools, no second
  `TaskOutput`; all work happens in Runs.
- **No projection objects.** `Turn / Task / Team / Channel / Step / kind` are
  views over the fact objects, never stored entities.
- **One-Neva invariant preserved.** A "role" is a **narrowed Neva fork**
  (`restrictAgentDefinitionTools` + `allowedTools`), not a second agent. No
  `agent_type`, no own memory line. (Reintroducing specialized executor agents
  would reverse the post-#300 invariant — out of scope.)
- **No second scheduler / workflow DSL.** The control loop stays thin; we do not
  rebuild Alma-style `harness/sprint/mission` orchestration.
- **No schedule-driver work.** Time-triggered runs stay a separate trigger source;
  trigger is provenance, not a tool-gating fact.
- **No silent autonomy.** Committing a detached, budget-spending Goal routes
  through the ask-gate, in the attended turn, where its scope is authorized.

## The frame — it is a nested (recursive) supervisory control system

Map the design onto the classical control loop (sensor → comparator → controller
→ actuator → plant → feedback):

| Control loop | Ours |
|---|---|
| setpoint / reference | **Goal** (objective + acceptance criteria) |
| controller | the **Goal's control loop** (plan + decide) |
| actuator | a **Run** (one attempt; may fan out to a team) |
| plant / process | the world: codebase / documents / external state |
| sensor + comparator | the **audit** — performed by an **independent verifier Run** |
| feedback path | Run results + RunEvents flowing back to the audit |
| disturbance | failures, blockers, changing requirements |

The parts beyond a thermostat are the standard **supervisory-control (SCADA)
superstructure**, not new inventions:

| SCADA superstructure | Ours |
|---|---|
| historian / data log | the event ledger (Runs + RunEvents) |
| operator HMI | the Conversation + owner controls (status / steer / cancel) |
| safety interlock | scope + the permission gate |
| cascade / hierarchical control | a Run is itself a sub-controller → loops within loops (the run tree) |
| supervisory control | the owner oversees many detached Goals |

**The one genuinely novel hard part:** our sensor can *lie*. A thermocouple reports
honestly; an LLM asked "am I done?" has moral hazard — it will declare done to stop
working (principal–agent). A loop whose actuator reports its own success is not a
closed loop, it is open-loop with a lie. Therefore the load-bearing rule:

> **The audit (sensor) MUST be independent of the worker (actuator). Completion is
> never self-declared.**

### Nesting — the whole system is one unit, recursively

The control unit is **self-similar**: an *actuator* (a Run) whose own task is
goal-shaped becomes a *controller* (a sub-Goal) with its own plan → act → sense →
audit → decide. The minimal structure never changes; only the depth does. A
"team" is one controller's actuators for a single cycle; a sub-team is the same
thing one level down. So `turn / Goal / sub-Goal / team / worker` are **the same
unit at different levels**, not distinct concepts — which is why the model stays
small while the depth stays unbounded (the cascaded-SCADA / VSM recursion, proven
in industry).

Two signals run along the nesting and are the whole inter-level contract:
**down** = acceptance criteria + `scope` (may only narrow) + a `budget` slice;
**up** = a result that has passed *that level's own independent verifier*, or an
escalation when the level needs to exceed its contract. The honesty patch
(sensor ≠ actuator) therefore recurses with the structure — every level has its
own verifier — and one **shared tree budget** is the single ceiling that keeps
unbounded recursion bounded.

## Concept model

### Two layers: intent above execution

```
Goal       (why — durable intent + acceptance contract; the controller)
  owns ▼
Run        (how — one bounded execution attempt; the actuator)
  emits ▼
RunEvent   (fact — one thing that happened inside a Run)
```

Every Run serves a *why*. The why is **materialized as a `Goal` only when it
outlives a single Run** (multi-attempt, audited, budgeted, trackable). An
ephemeral why — one message, one reply — stays in the Run's `trigger`; no Goal row
is created.

> **Goal = intent that outlives a single Run.** Dies with its Run → not a Goal
> (the Message is the why). Survives across Runs → a Goal.

### Fact objects (the whole write model)

| Concept | The one question it answers | Code today |
|---|---|---|
| **Conversation** | Where do user and agent talk / where is the result delivered? | exists (`conversationId`); spec primitive #2 |
| **Message** | Who said what? | exists |
| **Principal** | Who is the responsibility/identity subject? | spec primitive #1 |
| **Agent** | Who executes, with what persona/tools? | spec primitive; one-Neva = Neva |
| **Goal** | What did the user commit the system to, and what counts as done? | **NEW** (not in `types.ts` yet) |
| **Run** | What did the agent actually attempt, once? | spec primitive #3; `AgentRunTrigger`/lineage exist |
| **RunEvent** | What happened inside a Run? | exists (thinking / tool_call / tool_result / permission / message / child_run) |

(Content world, orthogonal: `Document` / `Node` / `Command`.)

Fields:

```
Run  { trigger, lineage(parent/root), disposition(await|detach) }
Goal { objective, acceptance criteria, scope, budget, type, state }
```

### Projections dissolve — there are no projection concepts

| Old projection word | Becomes | It is just |
|---|---|---|
| `kind` (turn/background/…) | **deleted** | derived from `trigger + lineage + disposition`; **no `goal` kind** |
| `Task` | = **Goal** | the "tasks" panel renders Goals (+ detached Runs) |
| `Team` | = **a Goal's Runs** | the run tree under a Goal |
| `Channel` | = **Conversation** | a (multi-member) Conversation |
| `Turn` | = render(Message + its Run) | a rendering-layer term only |
| `Step` | = render(RunEvents) | a rendering-layer term only |

So the core model has **7 fact objects and 0 projection concepts**; every UI view
is a rendering of a fact object.

### Keep / drop / rename verdicts

- **Names stay** — no core rename (renaming primitives is expensive and
  low-payoff; cleanliness came from correct layering, not new words).
- **The only real changes:** ADD `Goal` (+ `trigger: goal`); demote `kind` to a
  derived view (do not add a `goal` kind); stop using `'turn'` as a stored kind;
  **DROP** the would-be "persistent continuation on Run" (persistence is the
  Goal's loop). Don't introduce `Execution` / `Invocation` / `Round` /
  `Capability Lease` / `Workspace` (duplicates or unneeded).
- **Automation words are the teaching lens, not identifiers** — `Goal/Run/audit`
  are more legible to us than `setpoint/actuator/comparator`; the control-loop
  vocabulary is for explanation only.

## How a Goal runs

### The control loop (the one new behavior)

```
reference  (objective + acceptance criteria — fixed by the owner up front)
  → plan   (the loop designs/decomposes the approach)
  → act    (spawn a Run = one attempt; may fan out to a team of narrowed Neva forks)
  → sense  (gather artifacts + current world state)
  → audit  (an INDEPENDENT verifier Run checks artifacts vs the fixed criteria)
  → decide:
       verified                  → complete, deliver result up
       not, budget remains        → adjust & loop (reassign / refine / continue)
       needs owner / more scope    → escalate (blocked)
       budget gone / cancelled     → stop
```

The loop is driven by the runtime, **detached from the conversation** — the
main/foreground agent is the interface that creates the Goal and receives the
result, never the engine and never the auditor.

### Completion is independently verified, never self-declared

This is the load-bearing safety property (the "lying sensor"):

- `request_complete()` is a worker **claim**, not a fiat. It triggers an
  **independent verifier Run**: a fresh-context Neva fork that sees **only** the
  artifacts + the owner's fixed acceptance criteria + an anti-early-exit rubric +
  an adversarial *"prove it is NOT done"* framing — never the worker's own
  reasoning. Verified → `complete`; not → the gap returns to the worker.
- **Reuse Codex's `continuation.md` as the verifier's rubric.** It is an excellent
  requirement-by-requirement audit checklist ("treat completion as unproven";
  "uncertain or indirect evidence = not achieved"; "the audit must prove
  completion, not merely fail to find remaining work";
  `codex-rs/core/templates/goals/continuation.md`). **Codex runs this rubric as
  self-audit** (the same goal model calls `update_goal complete`); we run it via an
  **independent verifier**, which control theory (sensor ≠ actuator) and
  principal–agent (moral hazard) say is strictly stronger.
- **Independence scales with stakes** (redundant sensors): one fresh verifier →
  multiple voters / a different model → human final acceptance.
- **Criteria are the owner's, set up front** (in the attended turn). The loop
  checks against them; it cannot move the goalposts.

### Four terminal exits

`complete` (verified) · `blocked` (needs owner) · `budget-exhausted` · `stopped`
(cancelled). Only the first is success; the other three escalate/notify. (No
`Run` overload: a worker Run can fail/complete normally; the Goal survives and
spawns another — *reassign*.)

### Achievement vs maintenance goals (BDI)

A `type` field on the Goal, set at assignment, decides the audit semantics:

- **achievement** — audit checks the end-state; passing → `complete`.
  ("migrate all 200 call sites and keep tests green")
- **maintenance** — audit checks an invariant each cycle; **never `complete` by
  audit**; exits only on stop/budget; acts when the invariant is threatened.
  ("monitor competitor X and brief me on releases")

### Reused autonomy rules

- **ask only in the attended conversation turn.** The loop and its workers/verifier
  never ask — they self-resolve reversible locals and `report_blocked` on
  directional choices or scope expansion. (Preserves *subagents-never-ask-user*.)
  In the awaited case the attended parent may relay; detached → block escalates
  async, resolved in a fresh turn.
- **scope** is granted at assignment, **inherits down the run tree**; needing more
  authority escalates (`blocked`).
- **budget** (token/time) is **per goal-tree**, a fold over the subtree's usage.

### Team formation, temporary profiles & recursion

Worker/executor **and** verifier are all narrowed **Neva forks**
(`agentDelegation.ts:593` is fork-only; `:594` narrows via
`restrictAgentDefinitionTools` + `allowedTools`; `:605-608` inherits Neva's
identity/memory). A "team" is not a standing org — it is **one cycle's fan-out of
single-shot forks**, created by the loop's `plan`/`act` step and dissolved when the
cycle's results return. No owner approval gates it: the **owner controls the
outcome and the bounds (criteria + scope + budget + the verifier gate +
escalation), never the process** — they do not ratify who is on the team.

- **Temporary least-privilege profiles.** Each worker fork gets a profile *derived
  for its subtask*: `allowedTools` ∩ the subtask's `scope` subset, via
  `restrictAgentDefinitionTools`. The profile is computed per subtask and dies with
  the worker — there is **no fixed role library**. `researcher` / `implementer` are
  shorthand defaults for common tool subsets, not entities.
- **The verifier is the one distinct profile-kind.** Its independence is structural
  (fresh context + adversarial framing + artifacts-and-criteria only — **not** a
  different identity), so it is the single profile we name and reuse deliberately;
  a different model is its high-stakes upgrade.
- **Topology: star.** Workers are mutually invisible and consult the loop (the
  referee), which integrates. (Mesh / goal-scoped Channel stays an open question.)
- **Recursion is allowed.** A subtask that is itself goal-shaped is promoted to a
  **sub-Goal** with its own full loop and its own independent verifier — the nested
  unit. Kept safe by three governors, not by an approval gate:
  1. **one shared tree budget** — the parent allocates a slice; the whole subtree
     folds back into the single ceiling, so depth cannot outrun spend;
  2. **scope only narrows** — a sub-Goal inherits a subset; needing *more* authority
     **escalates** up, never self-grants;
  3. **an independent verifier at every level** — completion is never self-declared
     at any depth.
  A **soft depth limit** keeps the tree legible; the budget is the hard backstop.

## Tool surface

Tools are **precondition-gated**, not assembled per role. `createAgentTools`
(`src/main/agentRuntime.ts`, called by `buildTools`) moves from "return a fixed
list" to "filter the catalog":

```
visibleTools(run) = catalog.filter(t => t.precondition(principal, attended, lineage, role))
```

| Category | Tools | Note vs today |
|---|---|---|
| sense | `file_read`, `web_search`, `web_fetch`, `past_chats` | unchanged |
| mutate doc | node create/move/edit … | unchanged (write family + in-scope) |
| spawn / manage runs | `spawn(objective, {detach?, scope?, allowedTools?})`, `AgentStatus`, `AgentSend`, `AgentStop`, `set_budget` | `Agent`+(would-be `set_goal`) merge into `spawn`; **`AgentStatus`/`AgentSend`/`AgentStop` already model tools** (`agentDelegation.ts:51-52,687,1252,1266`) — only `set_budget` is new + objective-amendment semantics on `AgentSend` |
| goal self-management | `request_complete()` (→ triggers the independent verifier) · `report_blocked(reason)` | new; visible only inside the loop |
| ask user | `ask_user_question` | unchanged tool; gated to `attended` |
| load procedure | `skill` | unchanged; teaches *when* to set a Goal |

Owner controls map to existing commands: `status` ← `agent_child_run_status` /
`AgentStatus`; `steer` ← `AgentSend` (a send to a persistent Goal is an
objective-amendment event); `cancel`/`abandon` ← `AgentStop`; `reassign` = stop
current Run, Goal spawns a new one; `set_budget` is new. All require **owning the
target** (ancestor / same conversation).

## Theory & prior art (design against these)

| Theory | Maps to | Borrowed mechanism |
|---|---|---|
| **Durable execution / Temporal** | workflow = Goal/controller; activity = Run | signals = steer; queries = status; retry policy = reassign; cancellation; **deterministic loop ↔ effectful attempt** (Goal loop replayable from the ledger; Runs do the dirty work → clean crash/restart resume) |
| **BDI + goal lifecycle** | committed intention vs plan execution | **achievement vs maintenance** goal types; goal state machine; commitment/reconsideration |
| **OTP supervision trees** | Goal = supervisor; child Run = worker | restart strategy on executor failure; task outlives the worker |
| **Principal–agent** | owner = principal; Neva fork = agent | audit = anti-moral-hazard; **independent verification**; scope = bounded discretion |
| **Control theory / MAPE-K / cybernetics** | Goal = setpoint+controller; audit = sensor+comparator | the closed loop; **sensor ≠ actuator** |
| **Event sourcing / CQRS** | facts = write model; Turn/Task/Team = read models | projections are read-only views, never write models |

## Shape

**(b) A set of independent complete features**, ordered by dependency:

- **Feature A — Goal with independent verification (single worker).** A user sets a
  Goal; the control loop pursues it via Neva-fork Runs; **completion is gated by an
  independent verifier Run**; terminal outcomes notify. Complete and useful alone.
- **Feature B — Goal-as-team (with recursion).** When the objective is large, the
  loop's `plan` step decomposes and fans out to single-shot Neva-fork workers on
  **temporary least-privilege profiles** (referee = the loop), with the same
  independent verifier gate; a goal-shaped subtask is promoted to a **sub-Goal**
  (the nested unit), bounded by the shared tree budget + narrow-only scope + a
  verifier at every level. Builds on A + existing fork delegation.

## Open questions

1. **Default verifier independence.** Floor is "verifier ≠ worker" (fresh fork).
   Default to one fresh verifier, escalating to multi-voter / different-model /
   human-acceptance by stakes? **Recommend** one fresh verifier as default;
   higher tiers opt-in.
2. **Budget.** Ship budget-optional (unbounded default) and what is the
   over-budget default — `blocked` awaiting extension, or deliver partial?
   **Recommend** optional + block-and-ask-to-extend.
3. **Team topology.** Star (executors mutually invisible, consult the referee) vs
   mesh (goal-scoped ephemeral Channel). **Recommend** star first.
4. **Continuation granularity (impl of the loop).** New Run per attempt (linked by
   the Goal) vs one long Run appending attempts. **Recommend** new-Run-per-attempt
   (each bounded, replayable; matches Temporal activities and Goal ≠ Run).
5. **`kind` retirement scope.** Demote to derived in spec now; physical removal
   incremental and off the critical path.
6. **Composer placement** of `/goal` and the one-tap affordance — settle at build
   time (reversible).
7. **Per-profile model selection.** May a derived worker profile (or the verifier)
   pick a cheaper/stronger model per subtask, and is that an owner bound or a loop
   decision? **Recommend** loop-chosen by default; the verifier's different-model
   upgrade is owner-gated for high stakes.

(Decided, not open: team formation needs **no owner approval**; recursion into
sub-Goals **is allowed**, governed by the shared tree budget + narrow-only scope +
a verifier at every level.)

## Risks

- **Protocol surface (A4/A10).** Touches `src/core/commands.ts` /
  `src/core/types.ts` (the `Goal` record + `trigger: goal`, `spawn` params, run
  terminal status, `set_budget`, `AgentSend` objective-amendment semantics). Land
  the interface as a coordinated, **interface-first** step before the loop.
- **Autonomy safety.** A self-driving, budget-spending loop is the highest-blast
  capability. Load-bearing guards: commit-as-scope-authorization, the four-exit
  stops, ask-strict, and above all the **independent completion verifier** — the
  audit must never be the worker's self-judgment.
- **Verifier cost.** An independent verifier per completion-claim is affordable
  (fires only on `request_complete`, not every cycle); cheap self-assessment may
  pace mid-cycle, but the **completion gate** is always independent.
- **Concept creep.** Keep `Goal` thin (no execution machinery); keep the loop thin
  (no workflow DSL); resist re-materializing `Task` / `Team` as objects.

## Collision self-check

- `gh pr list` (2026-06-24): only #332 (codex-2, native focus / transcript polish)
  open — no overlap with runs / delegation / commands.
- `docs/TASKS.md`: no Goal / control-loop item in flight.
- Protocol-surface files (`commands.ts`/`types.ts`) need the interface-first step.

Result: **no overlap.**

## Build checklist

### Feature A — Goal with independent verification (single worker)

- [ ] Interface-first (`commands.ts`/`types.ts`, coordinated): the `Goal` record
      (objective / acceptance criteria / scope / budget / type / state) +
      `trigger: goal`; `spawn` params; run terminal status; `set_budget`;
      `AgentSend` objective-amendment semantics. (`AgentStatus`/`AgentSend`/
      `AgentStop` already exist.)
- [ ] The control loop in the runtime: plan → act → sense → audit → decide, with
      the four exits and the per-goal-tree budget fold.
- [ ] **Independent verifier Run** gating `complete`: fresh-context Neva fork,
      artifacts + fixed criteria + adversarial rubric only; port `continuation.md`
      as that rubric.
- [ ] `createAgentTools` (via `buildTools`) → precondition filter;
      `ask_user_question` gated to `attended`; goal self-management tools
      (`request_complete` / `report_blocked`) visible only inside the loop.
- [ ] `/goal` command + one-tap "make this a goal"; commit = scope authorization in
      the attended turn.
- [ ] Launching skill (when/how) authored.
- [ ] Delivery/UI: reuse Channel-style whole-utterance + result-first fold + run
      drill-in; "tasks" panel renders Goals; all four exits notify; steering via
      `AgentSend`.
- [ ] Verify in the dev app: set a Goal mid-DM; confirm it self-continues, the
      independent verifier gates completion, budget/pause/stop/block work, and it
      notifies. (light + dark for new UI.)

### Feature B — Goal-as-team

- [ ] Loop `plan` decomposes; `act` fans out single-shot Neva-fork workers on
      **temporary least-privilege profiles** (tools ∩ subtask-scope, derived per
      subtask, dissolved with the worker); referee = the loop. No owner approval gate.
- [ ] Derived team: tag worker Runs with the Goal/root id; team view = grouping;
      dissolution via existing stop-scope on completion.
- [ ] Scope inheritance down the tree (narrow-only; expand → escalate); shared tree
      budget with a soft depth limit; same independent verifier gate at every level.
- [ ] **Recursion:** promote a goal-shaped subtask to a sub-Goal (its own loop +
      verifier), governed by the shared tree budget.
- [ ] Only the **verifier** profile is named/reused; worker profiles are derived per
      subtask, not a fixed library.
- [ ] Verify: a large Goal fans out workers on derived profiles, recurses on a
      goal-shaped subtask, integrates, is independently verified at each level, and
      dissolves teams on completion.

### On ship

- [ ] Fold the **concept model** (7 facts, 0 projections; Goal ▷ Run ▷ RunEvent;
      control-loop framing; independent verifier) into
      `docs/spec/agent-architecture.md`; note the `kind`-demotion and the
      `background`-kind reframe.
- [ ] Mark the `docs/TASKS.md` item `done`; move this plan to `docs/plans/archive/`.
