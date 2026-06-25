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

## Architecture at a glance

**Outside — one self, one black box.** The owner hands a contract down and ever
only three things come back up.

```
        ┌─────────────────────────────────────────────────────┐
        │  NEVA — the one persistent self                      │
        │  HMI (you talk here) · memory owner · supervisor     │
        └─────────────────────────────────────────────────────┘
              │                                      ▲
              │  ↓ CONTRACT                          │  ↑ RETURNS (only ever 3)
              │    objective + criteria              │    • verified result
              │    + scope + budget + type           │    • escalation (blocked)
              │                                      │    • status (on query)
              ▼                                      │
        ╔═══════════════════════════════════════════════════════╗
        ║  THE BLACK BOX  =  one Goal                            ║
        ║  an autonomous control loop · detached from the chat   ║
        ║  self-audits · owner is ON the loop, never IN it       ║
        ╚═══════════════════════════════════════════════════════╝
```

**Inside — one control loop, two kinds of block.**

```
  reference = objective + criteria   ← fixed by the contract (no moving goalposts)
       │
       ▼
  ┌─────────────────────── one control cycle ──────────────────────┐
  │                                                                │
  │   PLAN ──► ACT ──► SENSE ──► AUDIT ──► DECIDE                   │
  │  decompose  run    gather    SENSOR     │                      │
  │     ▲     workers  artifacts  block     │                      │
  │     │       │              (clean +     │                      │
  │     │       │            adversarial)   │                      │
  │     └───────┴── adjust / reassign ◄──────┤                     │
  └──────────────────────────────────────────┼─────────────────────┘
                                             │
                        DECIDE branches → ───┤
                          verified         ──► COMPLETE → result   ↑ up
                          not, budget>0    ──► loop again (adjust)
                          needs owner/scope──► BLOCKED  → escalate  ↑ up
                          budget=0 / cancel──► STOPPED  → notify    ↑ up

  Two functional blocks the loop operates (both stateless; read Neva's memory,
  own none — see Team formation):
    WORKER   = actuator.  config = (function · context · capability∩scope · model)
                          context ∈ { full = inherit chat | brief | none }
    VERIFIER = sensor.    independent BY CONSTRUCTION — a fresh run, input is
                          ONLY artifacts + criteria, adversarial framing.
                          it is the COMPLETION GATE; done is never self-declared.
```

**The boundary — what crosses it (and the tool behind each).**

```
direction          what crosses the boundary                tool
─────────────────  ───────────────────────────────────────  ─────────────────────
↓ set a Goal       objective + criteria + scope + budget     set_goal / spawn(objective,
                   + type                                     {context, scope, budget…})
↓ mid-flight       status query                              AgentStatus
                   steer (amend objective)                   AgentSend (amendment)
                   cancel / abandon                          AgentStop
                   reassign                                  stop Run, Goal re-spawns
                   set_budget                                (new)
↑ returns          verified result | escalation              delivered to the
                   | status | terminal notify                 conversation
```

**Recursion — a black box within a black box.** A worker whose subtask is itself
goal-shaped becomes another box (a sub-Goal) running the SAME loop — self-similar,
governed by three things that flow with the nesting.

```
    Goal ┐
      ├─ worker block
      ├─ worker block
      ├─ SUB-GOAL ┐              three governors flow with the nesting:
      │    ├─ worker block         • ONE shared tree budget — sliced down,
      │    ├─ SUB-GOAL ┐             folds back up (depth can't outrun spend)
      │    │    └─ ...  │           • scope only NARROWS down (need more → escalate)
      │    └─ sensor    │           • a SENSOR block at EVERY level
      └─ sensor block ──┘         + soft depth limit (budget = hard backstop)
```

> **The box never hands verification back to the owner** — it self-checks via an
> independent sensor block; the owner sees only a result, an escalation, or status.
> That is what separates it from open-loop-with-a-lie.

## Non-goals

- **No new execution primitive.** `Run` is unchanged and stays single-attempt.
  Persistence is the **Goal's control loop**, not a `Run` continuation mode.
- **`Goal` is not a `Run`.** A Goal is durable intent that outlives, and survives
  the failure of, any single Run (an assignment outlives the employee). It carries
  **no execution machinery** — no scheduler of its own, no tools, no second
  `TaskOutput`; all work happens in Runs.
- **No projection objects.** `Turn / Task / Team / Channel / Step / kind` are
  views over the fact objects, never stored entities.
- **One persistent self (one-Neva), stated positively.** The system has exactly
  one identity — Neva: the user's interlocutor (HMI), the memory owner (where all
  learning accrues), and the durable workflow state. Workers and the verifier are
  **not selves and not "second agents"** — they are stateless functional blocks
  Neva operates (they read her memory as a resource, own none; `agent_type` /
  file-backed agents stay gone). Differentiation is by **function / context /
  capability / model — never identity**. (Reintroducing persistent specialized
  agents reverses the post-#300 invariant — out of scope.)
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

**`Agent` is the single persistent self (Neva).** A Run's worker/verifier are
**functional blocks**, not Agents — stateless, identity-less, owning no memory of
their own (see *Team formation*).

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
  → act    (spawn a Run = one attempt; may fan out to parallel worker blocks)
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
  **independent verifier Run** — a **sensor block**: a *fresh run* (clean, isolated
  context — **not** a context-inheriting fork) that sees **only** the artifacts +
  the owner's fixed acceptance criteria + an anti-early-exit rubric + an adversarial
  *"prove it is NOT done"* framing — never the worker's own reasoning. Verified →
  `complete`; not → the gap returns to the worker.
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

### Team formation — functional blocks, not a cast of selves

Inside the loop there is **no team of agents**, only functional blocks Neva
operates; the one identity is Neva (above). A human team differentiates *by person*
because a person bundles identity+memory+capability+reasoning into one atom — LLMs
**unbundle** these, so importing "different member = different identity" imports a
constraint we don't have (and is why "all Neva" *and* "different identities" both
feel wrong: a block is neither). So:

- **A worker is a stateless actuator block** = (function, isolated context,
  capability ∩ scope, model). No self, no memory of its own; it reads Neva's memory
  as a resource and writes none. (Exactly a Temporal *activity*: stateless, the
  workflow holds the state.) It is a **fork** in the code sense
  (`agentDelegation.ts:594`, fork-only), but the load-bearing facts are the four
  knobs below, not "it is Neva."
- **The verifier is a sensor block** — independent *by construction*: a separate
  block whose input is **only** artifacts + criteria (never the actuator's internal
  state), with adversarial framing. Its distinctness is functional, not an identity.

**The only differentiation knobs are function / context / capability / model — not
identity**, ranked by how much independence each buys:

| Knob | What it buys | Use |
|---|---|---|
| **context isolation** | the block can't be biased by what it shouldn't see | structural; **required** for the verifier (`context: 'none'`) |
| **model** | decorrelates errors at the reasoning *substrate* | the real, optional independence upgrade (esp. high-stakes verify) |
| **framing** | steers behavior (e.g. adversarial audit) | part of a block's prompt/config |
| **persona / name** | ≈0 epistemic value | **cosmetic — a UI role label only**, never a stored identity |

Role labels (`researcher` / `implementer` / `verifier`) are **function tags for the
UI**, not entities — the "tasks" view renders a goal's blocks by function, never as
"N Nevas".

**No owner approval gate.** The owner controls the **outcome and the bounds**
(criteria + scope + budget + the verifier gate + escalation), never the process —
they do not ratify which blocks run.

**Recursion is allowed.** A goal-shaped subtask is promoted to a **sub-Goal** — the
same unit one level down, with its own loop and its own sensor block. Kept safe by
three governors, not an approval gate:
1. **one shared tree budget** — the parent allocates a slice; the whole subtree
   folds back into the single ceiling, so depth cannot outrun spend;
2. **scope only narrows** — a sub-Goal inherits a subset; needing *more* authority
   **escalates** up, never self-grants;
3. **an independent sensor block at every level** — completion is never
   self-declared at any depth.
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
| spawn / manage runs | `spawn(objective, {context?, detach?, scope?, allowedTools?})`, `AgentStatus`, `AgentSend`, `AgentStop`, `set_budget` | `context` = the fork/fresh axis (see below); `Agent`+(would-be `set_goal`) merge into `spawn`; **`AgentStatus`/`AgentSend`/`AgentStop` already model tools** (`agentDelegation.ts:51-52,687,1252,1266`) — only `set_budget` + `context` are new + objective-amendment semantics on `AgentSend` |
| goal self-management | `request_complete()` (→ triggers the independent verifier) · `report_blocked(reason)` | new; visible only inside the loop |
| ask user | `ask_user_question` | unchanged tool; gated to `attended` |
| load procedure | `skill` | unchanged; teaches *when* to set a Goal |

Owner controls map to existing commands: `status` ← `agent_child_run_status` /
`AgentStatus`; `steer` ← `AgentSend` (a send to a persistent Goal is an
objective-amendment event); `cancel`/`abandon` ← `AgentStop`; `reassign` = stop
current Run, Goal spawns a new one; `set_budget` is new. All require **owning the
target** (ancestor / same conversation).

The `context` knob makes the fork/fresh axis explicit. A code **fork inherits the
whole conversation** (`agentDelegation.ts:1288` clones every parent message; `:1353`
"inherits the current conversation context"), so it is `context: 'full'`. `'brief'`
passes a distilled brief; `'none'` is a clean slate. The **verifier block is always
`none`** (independence); a worker picks `full` only when the goal directly continues
the thread, else `'brief'` / `'none'` to scope down and save tokens.

## Theory & prior art (design against these)

| Theory | Maps to | Borrowed mechanism |
|---|---|---|
| **Durable execution / Temporal** | workflow = Goal/controller; activity = Run | signals = steer; queries = status; retry policy = reassign; cancellation; **deterministic loop ↔ effectful attempt** (Goal loop replayable from the ledger; Runs do the dirty work → clean crash/restart resume) |
| **BDI + goal lifecycle** | committed intention vs plan execution | **achievement vs maintenance** goal types; goal state machine; commitment/reconsideration |
| **OTP supervision trees** | Goal = supervisor; child Run = worker | restart strategy on executor failure; task outlives the worker |
| **HTN planning (hierarchical task networks)** | the `plan` step decomposes a compound objective into sub-tasks / sub-Goals | recursive method decomposition → the nested unit; compound task ↔ sub-Goal, primitive task ↔ a worker Run |
| **Contract Net Protocol** | the loop (manager) announces a subtask and awards it to a forked worker (contractor) | task announce → award allocation; the referee assigns and the award's least-privilege capability ∩ scope **is** the worker block's config (we borrow allocation, not competitive bidding) |
| **Principal–agent** | owner = principal; a worker block = agent (a role, not a self) | audit = anti-moral-hazard; **independent verification**; scope = bounded discretion |
| **Control theory / MAPE-K / cybernetics** | Goal = setpoint+controller; audit = sensor+comparator | the closed loop; **sensor ≠ actuator** |
| **Event sourcing / CQRS** | facts = write model; Turn/Task/Team = read models | projections are read-only views, never write models |

## Shape

**(b) A set of independent complete features**, ordered by dependency:

- **Feature A — Goal with independent verification (single worker).** A user sets a
  Goal; the control loop pursues it via Neva-fork Runs; **completion is gated by an
  independent verifier Run**; terminal outcomes notify. Complete and useful alone.
- **Feature B — Goal-as-team (with recursion).** When the objective is large, the
  loop's `plan` step decomposes and fans out to **stateless worker blocks**
  (function + isolated `context` + capability ∩ scope + model; referee = the loop),
  with the same independent **sensor block** (verifier) gate; a goal-shaped subtask
  is promoted to a **sub-Goal** (the nested unit), bounded by the shared tree budget
  + narrow-only scope + a sensor block at every level. Builds on A + existing fork
  delegation.

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
7. **Per-block model selection.** May a worker block (or the verifier) pick a
   cheaper/stronger model per subtask, and is that an owner bound or a loop
   decision? **Recommend** loop-chosen by default; the verifier's different-model
   upgrade (the real independence lever) is owner-gated for high stakes.
8. **`context` default.** Default a worker block to `full` (continue the thread) or
   `brief` (scoped slate)? **Recommend** `brief` for detached goals, `full` only
   when the goal is an explicit continuation; the verifier is always `none`.

(Decided, not open: workers/verifier are **functional blocks, not identities** (one
persistent self = Neva); team formation needs **no owner approval**; recursion into
sub-Goals **is allowed**, governed by the shared tree budget + narrow-only scope +
a sensor block at every level.)

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
- [ ] **Independent verifier Run** gating `complete`: a fresh-run **sensor block**
      (clean/isolated context, not a context-inheriting fork), artifacts + fixed
      criteria + adversarial rubric only; port `continuation.md` as that rubric.
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

- [ ] Loop `plan` decomposes; `act` fans out **stateless worker blocks** (function
      + `context` + capability ∩ scope + model; no self, no own memory — read Neva's,
      write none); referee = the loop. No owner approval gate.
- [ ] `spawn` gains the `context: 'full' | 'brief' | 'none'` knob (a code fork =
      `full`); the verifier block is pinned to `none`.
- [ ] Derived team: tag worker Runs with the Goal/root id; the view groups blocks by
      **function label** (never "N Nevas"); dissolution via existing stop-scope.
- [ ] Scope inheritance down the tree (narrow-only; expand → escalate); shared tree
      budget with a soft depth limit; an independent sensor block at every level.
- [ ] **Recursion:** promote a goal-shaped subtask to a sub-Goal (its own loop +
      sensor block), governed by the shared tree budget.
- [ ] Verify: a large Goal fans out worker blocks, recurses on a goal-shaped subtask,
      integrates, is independently verified at each level, and dissolves on completion.

### On ship

- [ ] Fold the **concept model** (7 facts, 0 projections; Goal ▷ Run ▷ RunEvent;
      control-loop framing; independent verifier; the **at-a-glance diagrams**) into
      `docs/spec/agent-architecture.md`; note the `kind`-demotion and the
      `background`-kind reframe.
- [ ] Mark the `docs/TASKS.md` item `done`; move this plan to `docs/plans/archive/`.
