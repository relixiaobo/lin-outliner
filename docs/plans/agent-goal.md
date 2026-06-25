# Agent Goal — a self-similar Run tree, independently verified at every level

## Goal

Let a user hand a long-running **objective** to Neva and have it pursued
**autonomously** until the objective is **independently verified** complete — not
until the model decides to stop. The objective runs as a **recursive tree of Runs**:
each Run either **decomposes** into child Runs or **executes** directly, every Run's
result is **verified by its parent** before it folds upward, and the **root** is
verified against the user's **fixed criteria**. Mid-flight the owner can watch
progress, steer, reassign, or abandon; on a terminal outcome the result is delivered
back to the conversation.

Stated precisely, this is a **nested supervisory control system** that is
**self-similar**: there is **one unit — the `Run`** — and it recurses. A Run whose
objective is large becomes a controller over child Runs; a Run whose objective is
small executes it. The same unit covers arbitrary depth.

> **The whole design adds ZERO new fact objects.** "Goal/Task" is not a stored
> entity — it is the **objective of a (root or tracked) `Run`**. We enrich the
> existing `Run` (objective + acceptance criteria + scope + budget-slice + a dual
> status), formalize the recursive control behavior on the **existing run tree**
> (`parentRunId` already exists; `rootRunId` is a **new** denormalized field — see
> below), and reuse the existing execution machinery (fork delegation,
> `agent_child_run_*` controls, completion notification, usage accounting, the
> permission gate) for everything else.
>
> The durable-intent concept (identity, budget, criteria, amendment, attempt history)
> is **not eliminated — it is merged onto a `Run` in *controller* role**: a controller
> Run is **persistent and never re-spawned**, so its `runId` *is* the stable task
> identity. There is no new table, but controller Runs are first-class (persistent,
> identity-bearing, dual-status) — that discipline is the price of one object type.

## The model in one picture

```
user's goal/task ──────────────►  NEVA  (the root's parent: holds the user's
                                          objective + criteria; the one persistent self)
                                    │ spawn(objective, criteria)
                                    ▼
                              Run (root) ── large → control loop over children
                                ├─ Run sub1 ── large → control loop over children
                                │     ├─ Run sub1.1 ─ leaf: execute
                                │     ├─ Run sub1.2 ─ leaf: execute
                                │     └─ Run sub1.3 ─ leaf: execute
                                ├─ Run sub2 ── small → leaf: execute
                                └─ Run sub3 ── small → leaf: execute
```

**Every Run makes exactly one verified submission to its parent.** It reaches that
submission one of two ways:

- **leaf** — execute the objective directly → submit;
- **internal** — decompose → spawn child Runs → verify each child's submission →
  re-spawn the failures → integrate the verified children → submit.

**A Run never declares its own success.** When a Run submits, its **parent** verifies
the submission (by spawning a fresh, clean-context **verifier Run**) before accepting
it. The **root** is verified by Neva against the user's fixed criteria. Verified
results fold up; **the root verified = the whole task complete.**

## The frame — a nested supervisory control system

Map the design onto the classical control loop (sensor → comparator → controller →
actuator → plant → feedback). Because the unit is self-similar, **the same mapping
holds at every level**:

| Control loop | Ours (at any level) |
|---|---|
| setpoint / reference | the Run's **objective + acceptance criteria** |
| controller | the Run's **parent** (decomposes, decides, re-spawns) |
| actuator | the **Run** itself (one attempt at its objective) |
| plant / process | the world: codebase / documents / external state |
| sensor + comparator | the **verifier Run** the parent spawns to audit the submission |
| feedback path | results + RunEvents flowing up the tree |
| disturbance | failures, blockers, changing requirements |

The superstructure beyond a thermostat is standard supervisory-control (SCADA): the
event ledger is the historian; the Conversation + owner controls are the operator
HMI; scope + the permission gate are the safety interlock; the run tree **is**
cascade/hierarchical control; Neva overseeing many detached root Runs is supervisory
control.

**The one genuinely novel hard part:** our sensor can *lie*. A thermocouple reports
honestly; an LLM asked "am I done?" has moral hazard — it will declare done to stop
working (principal–agent). A loop whose actuator reports its own success is not a
closed loop, it is open-loop with a lie. Hence the load-bearing rule, applied at
**every** level of the tree:

> **The verifier MUST be independent of the worker. A Run's submission is verified by
> its parent (via a fresh verifier Run), never self-declared.**

### Outside — one self, one black box

The owner hands a contract to Neva and only ever three things come back up.

```
        ┌─────────────────────────────────────────────────────┐
        │  NEVA — the one persistent self                      │
        │  HMI (you talk here) · memory owner · root supervisor │
        └─────────────────────────────────────────────────────┘
              │                                      ▲
              │  ↓ CONTRACT                          │  ↑ RETURNS (only ever 3)
              │    objective + criteria              │    • verified result
              │    + scope + budget                  │    • escalation (blocked)
              │                                      │    • status (on query)
              ▼                                      │
        ╔═══════════════════════════════════════════════════════╗
        ║  THE BLACK BOX  =  a root Run + its subtree            ║
        ║  an autonomous control tree · detached from the chat   ║
        ║  self-audits at every level · owner is ON it, never IN ║
        ╚═══════════════════════════════════════════════════════╝
```

> The box never hands verification back to the owner — it self-checks via independent
> verifier Runs at every level; the owner sees only a result, an escalation, or
> status. That is what separates it from open-loop-with-a-lie.

### Nesting — the whole system is one unit, recursively

The control unit is self-similar: a Run whose objective is goal-shaped becomes a
controller over child Runs, each of which is the same unit again. The minimal
structure never changes; only the depth does. So `turn / goal / sub-goal / team /
worker` are **the same unit (a Run) at different levels**, which is why the model
stays small while depth stays unbounded (cascaded-SCADA / VSM recursion, proven in
industry).

Two signals run along the nesting and are the whole inter-level contract:
**down** = objective + acceptance criteria + `scope` (may only narrow) + a `budget`
slice; **up** = a result that has passed *that level's* independent verifier, or an
escalation when the level needs to exceed its contract. The honesty rule (verifier ≠
worker) recurses with the structure — every parent verifies its children — and one
**shared tree budget** is the single ceiling that bounds the recursion.

```
    Run(root) ┐
      ├─ worker Run                three governors flow with the nesting:
      ├─ worker Run                  • ONE shared tree budget — sliced down,
      ├─ Run(internal) ┐              folds back up (depth can't outrun spend)
      │    ├─ worker Run│            • scope only NARROWS down (need more → escalate)
      │    └─ ...       │            • the PARENT verifies each child, at EVERY level
      └─ (parent verifies each) ┘   + soft depth limit (budget = hard backstop)
```

## Non-goals

- **No new fact object.** `Goal` is **not** added to `types.ts`. The durable intent
  lives as a **controller `Run`'s** `objective` + `criteria`; the durability that
  "outlives a single attempt" is the **controller persisting and re-spawning its failed
  workers** (the controller itself is never re-spawned, so its `runId` is the stable
  identity), not a separate object.
- **No new execution primitive, no second scheduler / workflow DSL.** The control
  loop is **what an internal Run does** (iterate its children); we do not add a
  Goal-runtime, a scheduler, or Alma-style `harness/sprint/mission` orchestration.
- **Achievement only.** A Run audits an **end-state**; passing → `complete`. There is
  **no `maintenance` type and no `type` field** — "monitor X forever" needs a
  wake-up/trigger source, which is the schedule-driver work held out of scope below.
- **No projection objects.** `Turn / Task / Team / Channel / Step / kind` are views
  over the facts, never stored entities — and `kind` is **physically removed** in
  this cut.
- **One persistent self (one-Neva).** Exactly one identity — Neva: the HMI, the
  memory owner, and the **durable root supervisor** (she authorizes the root controller,
  receives its result, and re-decides at the top — she does not swap out a running root).
  Workers and verifiers are **not selves** — they
  are stateless **Runs** Neva (or a parent Run) operates; they read Neva's memory as a
  resource, own none (`agent_type` / file-backed agents stay gone). Differentiation is
  by **function / context / capability / model — never identity**. (Reverses nothing
  from the post-#300 invariant.)
- **No schedule-driver work.** Time-triggered runs stay a separate trigger source;
  trigger is provenance, not a tool-gating fact.
- **No silent autonomy.** Committing a detached, budget-spending root Run routes
  through the ask-gate, in the attended turn, where its scope is authorized.

## Concept model

### One unit: the Run

```
Run        (one attempt at an objective; leaf → execute, internal → control loop)
  emits ▼
RunEvent   (one thing that happened inside a Run)                ← unchanged
```

- **"goal/task" = a Run's `objective`.** The user's task = the **root** Run's
  objective + criteria. There is no separate Goal row.
- **Two kinds of Run, by tree position:**
  - a **controller Run** (internal / root) is a **persistent, runtime-owned
    supervisor** — it decomposes, dispatches workers, verifies their submissions,
    re-spawns the failures, integrates, and on its *own* verification failure
    **re-plans in place**. It is **never re-spawned**, so its `runId` is the stable
    task identity (the budget ceiling, owner-control target, panel entry, amendment
    target, attempt-history owner).
  - a **worker Run** (leaf) is an **ephemeral single attempt** at one objective; on
    failure its parent **spawns a fresh worker** (a new `runId`) for that sub-objective.
- So "Run = single attempt" is a property of **workers**; a **controller** persists and
  loops over its workers. The only loop is **a controller iterating its workers** —
  never a hidden continuation mode on a worker.
- **`role`** (controller | worker | verifier) is **derived from the Run's position in
  the tree** (a verifier is a Run a controller spawned to audit a submission), never a
  stored identity.

### The write model (the existing 6 facts; ZERO new)

| Concept | The one question it answers | Code today |
|---|---|---|
| **Conversation** | Where do user and agent talk / where is the result delivered? | exists (`conversationId`) |
| **Message** | Who said what? | exists |
| **Principal** | Who is the responsibility/identity subject? | exists |
| **Agent** | Who executes, with what persona/tools? | one-Neva = Neva |
| **Run** | What did the agent attempt — and, recursively, what did its children attempt? | exists (`AgentRunTrigger` + `parentRunId`/`rootRunId` lineage); **enriched here** |
| **RunEvent** | What happened inside a Run? | exists |

These are the write-model facts of execution + communication; they are **not** the
spec's seven *primitives* (`agent-architecture.md`), which also count **Memory /
Skill / Permission gate** on an orthogonal axis. (Content world, also orthogonal:
`Document` / `Node` / `Command`.)

### `trigger` is provenance, not "the why"

Today `Run.trigger` conflates two things: *what caused the Run* (a message, a
schedule, a parent's decomposition) and *what it is driving toward*. Split them:
**`objective` is the why (always present); `trigger`/provenance is only the cause.**
There is **no `trigger: goal`** — every Run's why is its objective; some objectives
are tracked (root / detached), most are not.

### Projections dissolve — no projection concepts

| Old projection word | Becomes | It is just |
|---|---|---|
| `kind` (turn/background/…) | **deleted (physically, this cut)** | derived from provenance + lineage |
| `Task` | = a **root/tracked Run** | the "tasks" panel renders root Runs |
| `Team` | = a Run's **child Runs** | the run tree under a Run |
| `Channel` | = **Conversation** | a (multi-member) Conversation |
| `Turn` | = render(Message + its Run) | a rendering-layer term only |
| `Step` | = render(RunEvents) | a rendering-layer term only |

So the core write model has **6 fact objects, 0 new, 0 projection concepts**; every UI
view is a rendering of a fact object.

### Keep / drop / rename verdicts

- **Core noun names stay** — no fact-object rename.
- **The real changes:** **enrich `Run`** (objective + acceptance criteria + scope +
  budget-slice + `rootRunId` + a second status axis `objectiveStatus` + the controller
  behavior on internal nodes); **RENAME the `Agent` delegate tool → `spawn`**; rename the
  owner/parent controls to the uniform `run_status` / `run_send` / `run_stop`;
  **physically remove `kind`**; demote `trigger` to provenance only. **Do NOT add** a
  `Goal` object, a `type` field, a `trigger: goal`, a `GoalStatus`, a `supersedesRunId` /
  `objectiveGroupId`, or `Execution` / `Invocation` / `Round` / `Capability Lease` /
  `Workspace`.
- **Automation words are the teaching lens, not identifiers.**

## How it runs

### The one rule: a parent verifies its child (recursively)

> When a Run submits a result, its **parent** verifies it **before** accepting it, by
> spawning a fresh **verifier Run**. Completion is never self-declared, at any level.

The verifier Run is **independent by construction** and is **itself just a Run**, so
the model stays uniform — Runs all the way down, including verifiers:

- spawned with **`context: 'none'`** (clean/isolated — never a context-inheriting
  fork); **runtime-pinned**, the model cannot relax it;
- its input is **only**: the assigned objective + the fixed `criteria` + an
  adversarial anti-early-exit rubric + a **runtime-assembled evidence pack** drawn
  from the child's Run(s) — changed nodes/files, `tool_call ↔ tool_result` refs, run
  ids, the child's full output trace — **never a worker-curated summary**;
- it gets **read-only inspection tools** to check the world itself, and **no `spawn`
  / no write tools** (a sensor cannot actuate);
- **Rubric:** port Codex's `continuation.md`
  (`codex-rs/core/templates/goals/continuation.md`) — "treat completion as unproven";
  "uncertain or indirect evidence = not achieved". Codex runs it as self-audit; we run
  it via an **independent** verifier, which control theory (sensor ≠ actuator) and
  principal–agent (moral hazard) make strictly stronger.

The **root** is verified by Neva against the user's **fixed** criteria (optionally via
a verifier Run she spawns). Moral hazard at any internal level is caught one level up,
and the chain bottoms out at the **immovable user criteria** at the root.

**Default independence = same model, fresh `none` context, adversarial framing.** This
buys de-biasing (different context, can't see the worker's reasoning), not
error-decorrelation — same substrate, correlated blind spots. The **different-model**
verifier (the real decorrelation lever) is an **owner-gated opt-in for high stakes**;
multi-voter / human-acceptance are further tiers. Affordable because a verifier fires
only on a submission, not every step.

### Persistence — controllers persist, workers re-spawn

A **controller Run is runtime-owned supervisor state, not a long-lived chat process**:
its decompose / decide / integrate / dispatch-verify steps are discrete, **bounded LLM
calls whose outputs are checkpointed as RunEvents**; between steps no process holds
context. That is what lets a controller persist (and resume after a crash) cheaply, and
it is why "no scheduler / no new primitive" holds — the controller is just durable
`Run` state the runtime steps.

So persistence has two shapes, and **nothing that carries a stable identity is ever
re-spawned**:

- a **worker** (leaf) that fails its verifier is **replaced** — its controller spawns a
  fresh worker (a new `runId`) for that sub-objective, carrying the gap as feedback. A
  worker is therefore a single attempt; the multi-attempt loop is the controller's. Only
  the controller references a worker's id, so a new id on retry costs nothing.
- a **controller** (incl. the **root**) is **never replaced** — on its own verification
  failure it **re-plans in place** (the gap feeds back, it re-decomposes / re-dispatches),
  **keeping its `runId`**. The root controller persists across the whole task; Neva
  supervises it but never swaps it out.

This is "the assignment outlives the employee" — the controller (assignment) persists,
the worker (employee) is replaced — **without a separate object**, because the persistent
thing already has a `runId`, and that id is the stable task identity.

### Two status axes on a Run (no new object, no overloaded enum)

A `Run` carries **two orthogonal status axes** — keeping the existing process enum
untouched, and expressing the new control/verification lifecycle separately:

- **`executionStatus`** — the existing `running | completed | failed | cancelled`,
  **unchanged**. Process/ledger semantics: is this Run's own work in progress, done,
  errored, aborted? Every existing consumer (running-detection, Dream skip, projections)
  keeps reading this; nothing regresses.
- **`objectiveStatus`** — **new**, on controller / tracked Runs only:
  `verifying | verified | blocked | budget_exhausted | stopped`. The control /
  verification lifecycle of the objective this Run owns.

```
  executionStatus:  running ──► completed / failed / cancelled        (existing, untouched)
  objectiveStatus:  (worker submits) ──► verifying
                                            │ parent's verifier passes ──► verified ──► folds up
                                            │ fails ──► controller re-plans / re-spawns the worker
                                            ├─ report_blocked / needs scope / gap repeats N× ──► blocked
                                            ├─ budget reserve denied & over ceiling ──► budget_exhausted
                                            └─ owner/parent stop ──► stopped
```

The **four terminal outcomes** that matter to the owner are the **root** controller's
`objectiveStatus`: `verified` (success) / `blocked` / `budget_exhausted` / `stopped`.
Only `verified` is success. A worker that fails verification ends with
`executionStatus: completed` but is simply not accepted upward — the failure is the
controller's `objectiveStatus`, never a corrupted execution state.

### Livelock guard — convergence is designed

Worker↔verifier oscillation (submit → reject → re-spawn → reject …) must not silently
burn the tree budget. Each verifier rejection yields a **gap-signature** (normalized
failing criterion + gap). If the same signature recurs for **N consecutive attempts
with no progress** on a sub-objective, the parent sets that branch `blocked`
(escalate) instead of re-spawning again. Budget is the backstop; the gap-signature is
the primary non-convergence exit.

### Budget is admission control, not a post-hoc fold

Budget (token/time) is a single ceiling **per tree**, enforced as **pre-spend
admission control**: before spawning any child Run (worker or verifier), the parent
**reserves** a slice from the tree budget; if the reservation is denied and the tree
is over ceiling, the branch goes `budget_exhausted` (or `blocked` awaiting
extension). On completion the reservation is **settled** against real usage.
Concurrent fan-out competes for one ceiling through the same gate, so parallelism
cannot overshoot. Independent **runtime hard backstops**, regardless of the loop's own
accounting: **max wall-clock, max-attempts, max-depth, max-concurrent-children**.

### Resume, not deterministic replay

The tree is **event-sourced and resumable**, but **not** Temporal-style deterministic
replay — the controllers' steps (decompose / decide / verifier verdict) are LLM calls
and are nondeterministic. The discipline: **each controller decision is checkpointed
as a RunEvent before its side effects**, so on crash/restart the recorded prefix is
authoritative (replayed as *facts*, not recomputed) and only the next undetermined
decision is freshly computed. Neva resumes supervising the persisted root.

### Reused autonomy rules

- **Ask only in the attended conversation turn.** No Run asks — it self-resolves
  reversible locals and `report_blocked` on directional choices or scope expansion.
  (Preserves *subagents-never-ask-user*.) A detached branch's block escalates async,
  resolved in a fresh turn; an awaited parent may relay.
- **Scope** is granted at the root, **inherits down the tree** (narrow-only); needing
  more authority escalates (`blocked`).
- **Budget** is per tree (above).

## Tool surface

Tools are **precondition-gated**, replacing today's two-stage assembly
(presence-based inclusion in `createAgentTools` + name allow/deny in
`filterAgentTools`) with one predicate model. A **catalog wrapper**
`{ tool, precondition }` carries the predicate — it does **not** add a field to the
vendor `AgentTool` type, nor touch each tool factory:

```
visibleTools(run) = catalog.filter(entry => entry.precondition(principal, attended, lineage))
```

`role` (worker / verifier) is **derived inside the predicate** from `lineage`, never
a persisted axis.

| Category | Tools | Note vs today |
|---|---|---|
| sense | `file_read`, `web_search`, `web_fetch`, `past_chats` | unchanged |
| mutate doc / local | node + file write family | unchanged (in-scope only) |
| spawn / manage runs | `spawn(objective, {criteria?, scope?, budget?, context?, detach?})`, `run_status`, `run_send`, `run_stop`, `set_budget` | **`Agent` → `spawn`**; recursion = a Run calls `spawn`; `criteria` present → a verified contract, absent → an unverified single pass; the controls are uniformly **`run_*`** (renamed from `AgentStatus`/`AgentSend`/`AgentStop`, which become `run_status`/`run_send`/`run_stop`); **new:** `set_budget`, the `context` knob, `run_send` objective-amendment semantics |
| run self-management | `request_complete()` (→ parent's verifier) · `report_blocked(reason)` | new; submit / escalate |
| ask user | `ask_user_question` | unchanged tool; precondition-gated to `attended` |
| load procedure | `skill` | unchanged |

Because everything is a Run, `spawn` + `run_status/run_send/run_stop` is internally
consistent (no `goal_*` vs `run_*` split). The underlying commands
`agent_child_run_status/send/stop` (`commands.ts`) already share the `run` stem, so the
tool rename does not require a command-layer rename.

The `context` knob makes the fork/fresh axis explicit: a code **fork inherits the
whole conversation** (`context: 'full'`); `'brief'` passes a distilled brief; `'none'`
is a clean slate. The **verifier Run is runtime-pinned to `none`**; a worker picks
`full` only when its objective directly continues the thread, else `'brief'` /
`'none'`.

Owner/parent controls require **owning the target** (ancestor / same conversation):
`status` ← `run_status`; `steer` ← `run_send` (a send is an objective-amendment
event); `cancel`/`abandon` ← `run_stop`; `reassign` = stop a child Run, the parent
re-spawns; `set_budget` is new.

## Team formation & recursion — functional blocks, not a cast of selves

Inside the tree there is **no team of agents**, only **Runs** Neva (and parent Runs)
operate; the one identity is Neva. A human team differentiates *by person* because a
person bundles identity + memory + capability + reasoning into one atom — LLMs
**unbundle** these, so "different member = different identity" imports a constraint we
don't have. So:

- **A worker is a stateless actuator Run** = (function, isolated context, capability ∩
  scope, model). No self, no own memory; it reads Neva's memory as a resource, writes
  none. (Exactly a Temporal *activity*.) It is a **fork** in the code sense, but the
  load-bearing facts are the four knobs, not "it is Neva."
- **The verifier is a sensor Run** — independent *by construction*: input is only
  evidence + criteria, with adversarial framing and no actuation tools.

**The only differentiation knobs are function / context / capability / model — not
identity:**

| Knob | What it buys | Use |
|---|---|---|
| **context isolation** | the Run can't be biased by what it shouldn't see | structural; **required** for a verifier (`context:'none'`, runtime-pinned) |
| **model** | decorrelates errors at the reasoning *substrate* | the real, optional independence upgrade; **owner-gated** for high-stakes verify |
| **framing** | steers behavior (e.g. adversarial audit) | part of a Run's prompt/config |
| **persona / name** | ≈0 epistemic value | **cosmetic — a UI role label only**, never a stored identity |

Role labels (`researcher` / `implementer` / `verifier`) are **function tags for the
UI**, derived from tree position — the "tasks" view renders a Run's children by
function, never as "N Nevas".

**No owner approval gate.** The owner controls the **outcome and the bounds** (criteria
+ scope + budget + the verifier gate + escalation), never the process — they do not
ratify which Runs spawn.

**Recursion is the mechanism, kept safe by three governors, not an approval gate:**
1. **one shared tree budget** — the parent reserves a slice; the subtree folds into the
   single ceiling, so depth cannot outrun spend;
2. **scope only narrows** — a child inherits a subset; needing *more* authority
   **escalates**, never self-grants;
3. **the parent verifies every child** — completion is never self-declared at any
   depth.
A **soft depth limit** keeps the tree legible; the budget (and `max-depth`) is the hard
backstop.

## Engineering contracts

The precise shapes the one cut commits to.

**Enriched `Run` record** (`src/core/types.ts` / `agentEventLog.ts`):

```
Run {
  runId                    // primary key; for a controller this IS the stable task identity
  conversationId           // home for delivery + owner controls
  objective: string        // the why (= this level's "goal"); always present
  criteria?: string[]      // the contract its parent verifies it against (root = the user's);
                           //   absent → an unverified single pass
  provenance               // was `trigger`: message | schedule | parent-decomposition (NOT "goal")
  parentRunId?             // exists today
  rootRunId?               // NEW (denormalized; derivable from the parent chain), stored + indexed
                           //   for the hot tree / budget / panel queries; points at the root controller
  role                     // controller | worker | verifier — DERIVED from tree position, not stored
  scope                    // capability ∩ scope; inherits down, narrow-only
  budget { reserved, spent } // tree ceiling; admission-controlled (the root controller holds it)
  executionStatus          // running | completed | failed | cancelled — EXISTING, unchanged
  objectiveStatus?         // NEW (controller / tracked only): verifying | verified | blocked
                           //   | budget_exhausted | stopped
  childRunIds: RunId[]      // workers + verifiers it spawned (a worker's id may change across attempts)
  latestGap?: { signature, detail }  // last verifier gap; drives the livelock guard
  result?                  // terminal payload on `objectiveStatus: verified`
  createdAt, updatedAt
}
```

- **No `Goal` object, no `type` field, no stored `kind`, no `trigger: goal`.** The
  durable-intent semantics (identity, budget, criteria, amendment, attempt history) ride
  a **controller Run**, which is persistent and never re-spawned, so its `runId` is the
  stable task key — no separate grouping object (`supersedesRunId` / `objectiveGroupId`)
  is needed, because a controller is never replaced.
- **Two status axes, not one overloaded enum:** `executionStatus` (the existing process
  enum, untouched) + `objectiveStatus` (new, controller/tracked only). This preserves
  every existing consumer of run status and keeps "Goal" out of the execution enum.
- The controller's **control-loop state** (which sub-objectives are pending/done, retry
  counts, per-sub-objective `latestGap`) lives in the controller's **RunEvents**, not a
  new object.
- **Verifier evidence** is runtime-assembled (above); the verifier result schema is
  `{ verdict: pass | fail, gaps: [{ signature, criterion, detail }] }`, mapped to
  `latestGap` + the livelock counter.
- **Amendment invalidation:** an owner `run_send` amendment to a Run's objective/criteria
  **invalidates any prior or in-flight verifier verdict** for it; amending while
  `verifying` **aborts the current verifier**. A `complete` verdict never carries across
  a criteria change.

## Theory & prior art (design against these)

| Theory | Maps to | Borrowed mechanism |
|---|---|---|
| **Durable execution / Temporal** | the run tree = workflow; a worker Run = activity | signals = steer; queries = status; retry = re-spawn; cancellation; **event-sourced resume** — *resume, not deterministic replay* |
| **OTP supervision trees** | a parent Run = supervisor; child Run = worker | restart strategy on failure; the objective outlives the worker (re-spawn) |
| **HTN planning** | the decompose step = method decomposition | compound objective ↔ internal Run; primitive objective ↔ leaf Run |
| **Contract Net Protocol** | a parent announces a sub-objective, awards it to a forked child | task announce → award; the award's least-privilege capability ∩ scope **is** the child's config |
| **Principal–agent** | parent = principal; child Run = agent (a role, not a self) | audit = anti-moral-hazard; **independent verification**; scope = bounded discretion |
| **Control theory / MAPE-K / cybernetics** | objective = setpoint; the parent's verifier = sensor + comparator | the closed loop, **recursively**; **sensor ≠ actuator** |
| **Event sourcing / CQRS** | facts (Run/RunEvent) = write model; Task/Team = read models | projections are read-only views, never write models |

## Shape

**(a) ONE complete feature in one PR.** "foundation → consumers" is **build-order
within the PR** (A7), not separate releases. Build-order:

1. **Interface** — enrich `Run` (objective / criteria / scope / budget; `rootRunId` new
   field; `executionStatus` kept + `objectiveStatus` new; `provenance` replacing
   `trigger`'s why-role; `role` derivation); `spawn(objective, {criteria, …})` (the
   `Agent`→`spawn` rename + the `context` knob); the `run_status/run_send/run_stop`
   rename; `set_budget`; the precondition-catalog tool layer. (Touches `commands.ts` /
   `types.ts` — coordinate per A4/A10.)
2. **Recursive control + verifier** — leaf worker vs persistent controller (runtime-owned
   supervisor state); the controller verifies each worker via a runtime-spawned
   `context:'none'` **verifier Run** (runtime-assembled evidence pack + `continuation.md`
   rubric, read-only, no actuation); re-spawn the failed worker / controller re-plans in
   place; the `objectiveStatus` transitions; the livelock guard; budget admission control
   + hard backstops; event-sourced resume.
3. **Depth + governors** — recursion to arbitrary depth; scope-narrows-only; shared tree
   budget folding; a verifier at every level; no owner approval gate.
4. **Delivery / UI** — `/goal` + one-tap "make this a goal"; Neva as the root supervisor
   holding the user's objective; the "tasks" panel renders root Runs (children grouped by
   function label, never "N Nevas"); the four root outcomes notify; steering via
   `run_send`.

## Open questions

Genuinely open, all build-time-reversible:

1. **Team topology among siblings.** Star (children mutually invisible, consult the
   parent) vs mesh (a goal-scoped ephemeral Channel). **Recommend** star first.
2. **`context` default for a worker.** `full` (continue the thread) vs `brief` (scoped
   slate). **Recommend** `brief` for detached objectives, `full` only on an explicit
   continuation. (A verifier is always `none`.)
3. **Composer placement** of `/goal` and the one-tap affordance — settle at build time.
4. **Livelock N and budget defaults** — the gap-repeat threshold and the default tree
   budget / hard-backstop values; tune against the dev probe.

**Decided (not open):**
- **ZERO new fact objects (no new table)** — `Goal` is a Run's `objective`; the
  durable-intent semantics ride a **controller Run** (first-class: persistent,
  identity-bearing, dual-status).
- **One self-similar unit (Run); the parent verifies the child, recursively.**
- **Controller Runs persist (never re-spawned; their `runId` is the stable identity);
  only leaf workers re-spawn.** `rootRunId` is a new denormalized field; no
  `supersedesRunId` / `objectiveGroupId` needed.
- **Two status axes:** `executionStatus` (existing, untouched) + `objectiveStatus` (new,
  controller/tracked only). No overloaded single enum, no separate `GoalStatus`.
- **Controller Run = runtime-owned supervisor state**, not a long-lived process; its
  steps are bounded LLM calls checkpointed as RunEvents.
- **`spawn` + uniform `run_status/run_send/run_stop`**; recursion = a Run calls `spawn`.
- **Achievement only; no `maintenance`, no `type` field.**
- **Verifier default = same model, fresh `none` context, adversarial framing**;
  different-model is the owner-gated high-stakes opt-in.
- **Budget mandatory + admission-controlled**; over-ceiling → `blocked` (or
  `budget_exhausted`). Unbounded is not a default.
- **`kind` physically removed; `trigger` demoted to provenance.**
- Workers/verifiers are **Runs, not identities** (one-Neva); team formation needs **no
  owner approval**.

## Risks

- **Protocol + prompt surface (A4/A10).** Touches `src/core/types.ts` /
  `agentEventLog.ts` / `commands.ts` (the `Run` enrichment, `rootRunId`, the dual status
  axes, `spawn` params, the `run_*` renames, `set_budget`) and the model-facing
  `Agent`→`spawn` rename (tool-name constant + prompt text). Land the interface as the
  first build-order step.
- **Autonomy safety.** A self-recursing, budget-spending tree is the highest-blast
  capability. Load-bearing guards, all in this cut: commit-as-scope-authorization, the
  Run terminal outcomes, ask-strict, the **parent-verifies-child rule** (runtime-spawned,
  runtime-assembled evidence, no actuation), the **livelock guard**, and **budget
  admission control + runtime hard backstops** (wall-clock / attempts / depth /
  concurrency) independent of the loop's own accounting.
- **Verifier cost & calibration.** Affordable (fires on submissions); but same-model
  default is de-biasing, not decorrelation — document the limit so the different-model
  upgrade is reached for when stakes warrant.
- **Concept creep.** Keep the Run thin (no Goal object, no execution-machinery bloat);
  keep the control loop thin (no workflow DSL); resist re-materializing `Task` / `Team` as
  objects. The engineering contracts above are the line.

## Collision self-check

- `gh pr list` (2026-06-25): only **#338** (codex, schema-definition / trash actions)
  open — no overlap with runs / delegation / commands.
- `docs/TASKS.md`: the **agent-goal** item is `draft`; no other run-tree / control-loop
  item in flight.
- Protocol-surface files (`types.ts` / `agentEventLog.ts` / `commands.ts`) + the
  `Agent`→`spawn` / `run_*` renames land in the interface build-order step first.

Result: **no overlap.**

## Build checklist (one PR, build-order within it)

- [ ] **Interface** — enrich `Run` (objective / criteria / scope / budget; `rootRunId`
      new field; `executionStatus` kept + `objectiveStatus` new; `provenance` replacing
      `trigger`'s why-role; derived `role`); `spawn(objective, {criteria, scope?, budget?,
      context?, detach?})` (rename `Agent`→`spawn`); rename controls to `run_status` /
      `run_send` / `run_stop`; `set_budget`; the precondition-catalog tool layer.
- [ ] **Recursive control** — leaf worker vs persistent controller (runtime-owned
      supervisor state); controller re-spawns a failed worker / re-plans in place on its
      own failure; the `objectiveStatus` transitions; attempts tracked via `childRunIds` +
      controller RunEvents; event-sourced resume (decisions checkpointed before side
      effects).
- [ ] **Parent-verifies-child** — runtime-spawned `context:'none'` verifier Run;
      runtime-built evidence pack (changed nodes/files, tool refs, run ids, full trace) +
      read-only inspection tools, no actuation; port `continuation.md`; verifier result
      schema → `latestGap`. Root verified by Neva against the user's criteria.
- [ ] **Livelock guard** — gap-signature; `N` consecutive no-progress repeats → `blocked`.
- [ ] **Budget** — admission control (reserve before spawn, settle on completion) +
      runtime hard backstops (wall-clock / max-attempts / max-depth / max-concurrent).
- [ ] **Depth + governors** — recursion to arbitrary depth; scope-narrows-only; shared
      tree budget folding; a verifier at every level; no owner approval gate.
- [ ] **Delivery / UI** — `/goal` + one-tap; Neva as root supervisor; "tasks" panel
      renders root Runs (children by function label); the four root outcomes notify;
      steering via `run_send`. (light + dark.)
- [ ] **Launching skill** (when/how to set a goal) authored.
- [ ] **Verify in the dev app** — set a goal mid-DM; confirm it self-decomposes into a Run
      tree, each child is independently verified by its parent before folding up, the
      livelock guard and budget admission fire, the four root outcomes notify, and a
      deep subtree integrates and completes only when the root verifies against the user's
      criteria.

### On ship

- [ ] Fold the **concept model** (one self-similar Run; the parent-verifies-child rule;
      the **at-a-glance diagrams**; `kind` removal; `trigger`→provenance) into
      `docs/spec/agent-architecture.md`; note that **no new fact object** was added.
- [ ] Mark the `docs/TASKS.md` item `done`; move this plan to `docs/plans/archive/`.
