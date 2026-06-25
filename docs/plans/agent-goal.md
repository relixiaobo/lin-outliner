# Agent Goal — one verified edge, recursed into a self-similar Run tree

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

**The design has exactly one moving part: a single *verified edge*** (parent → child →
verifier → accept/retry). The tree is not designed — it **emerges** when that edge
nests inside itself. Every Run reasons only one level down; no code ever takes "the
tree" as input. That locality is the whole reason the model stays small while depth
stays unbounded — and it is exactly how a control system works: each loop governs only
the segment it directly touches, and global behavior is the emergent sum.

> **The whole design adds ZERO new fact objects.** "Goal/Task" is not a stored
> entity — it is the **objective of a (root or tracked) `Run`**. We enrich the
> existing `Run` (objective + acceptance criteria + scope + budget-slice + a dual
> status), formalize the recursive control behavior on the **existing run tree**
> (`parentRunId` already exists and is **all the lineage we need** — a Run reasons only
> one level up/down, so there is **no `rootRunId`**), and reuse the existing execution
> machinery (fork delegation,
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

**Every Run's result is verified by its parent before it is accepted.** A Run reaches
that result one of two ways:

- **leaf** — execute the objective directly → finish;
- **internal** — decompose → spawn child Runs → verify each child's result →
  re-spawn the failures → integrate the verified children → finish.

**A Run never declares its own success.** When a Run **finishes** (its run terminates,
leaving its result), its **parent** senses that and verifies the result (by spawning a
fresh, clean-context **verifier Run**) before accepting it — there is no "I'm done" tool;
the child only stops. The **root** is verified by Neva against the user's fixed criteria.
Verified results fold up; **the root verified = the whole task complete.**

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

### The unit is the edge — design one hop, the tree emerges

The control unit is not "the tree" — it is **one verified hop (one edge)**: a parent
spawns a child against `criteria`, the child submits, the parent verifies it via a
fresh verifier Run, and accepts or re-spawns. That single triangle **is** the entire
mechanism:

```
        ┌─────────────────────────────────────────────┐
        │ PARENT Run — "do X until it meets criteria"  │
        └─────────────────────────────────────────────┘
              │ ① spawn(X, { criteria })          ◄ parent sets the setpoint
              ▼
        ┌──────────────┐
        │ CHILD Run    │  works on X
        └──────────────┘
              │ ② run terminates (+ output)       ◄ child just STOPS; it never "claims done"
              ▼                                       (parent senses the termination — the wire)
        ┌──────────────┐
        │ VERIFIER Run │  fresh context:'none'; audits raw evidence vs criteria
        └──────────────┘
              │ ③ verdict
        ┌─────┴─────┐
        ▼           ▼
      pass        fail + gap
        │           │
     accept,     ④ re-spawn the child with the gap
     fold up        (retry loop, until budget / attempts run out)
```

**Recursion is not a second mechanism — it is the same edge nested.** A child that
finds its objective too large gets no new tools; it runs the *same* edge over its
sub-objectives, becoming the parent of its own triangle:

```
   parent
     │ spawn(X, {criteria_X})
     ▼
   child  ◄── X is large, so the child becomes a parent and runs the same edge:
     │
     ├─ spawn(X.a, {criteria_a}) ─▶ child.a ─▶ [child verifies a]
     ├─ spawn(X.b, {criteria_b}) ─▶ child.b ─▶ [child verifies b]
     │
     │  only once a, b pass does the child finish (its run terminates)
     ▼
   parent senses it → parent's verifier audits X
```

So the whole tree is **the same triangle stacked** — there is no "tree code", only
"edge code", invoked at each level by whoever is the parent there:

```
                  NEVA (root owner)
                    │
                    △   ◄ edge: Neva verifies R against the *user's* criteria
                    │
                    R
                  / │ \
                 △  △  △   ◄ edge: R verifies its three direct children
               R.a R.b R.c
               / \
              △   △   ◄ edge: R.a verifies its two direct children
          R.a.1 R.a.2
```

**Every Run reasons only one level down.** `R` does not know `R.a.1` exists — only its
direct children `R.a / R.b / R.c`; `R.a.1` is `R.a`'s concern. No Run holds a model of
the whole tree, and **no function ever takes "the tree" as input.** This locality is
what keeps the model small while depth stays unbounded: local rules at each edge,
global structure emergent (cascaded-SCADA / VSM recursion, proven in industry).

### Three governors, each enforced locally at the edge

The recursion is kept safe **at each edge**, never by a tree-wide supervisor. Each
governor is a one-level-local rule; its tree-wide property is the **emergent** sum:

| Governor | Local rule at one edge | Emergent tree-wide property |
|---|---|---|
| **budget** | the parent reserves a fixed **slice** for each child; a child spends only within its slice, never a sibling's | "tree budget" = the recursive sum of slices — held by nobody, read by no one |
| **scope** | a child inherits a **narrowed subset** of the parent's scope; needing more **escalates** | authority only ever shrinks downward — no global scope table |
| **verification** | the **parent** verifies its **direct** child before accepting | "verified at every level" falls out of every edge doing it |

A child that needs more budget or scope does **not** consult a global ceiling — it
**stops with that note in its output**; its parent reads it and either re-slices locally
(a `run_send` amend, then re-spawns) or escalates further. **Depth needs no separate cap:** each nesting
reserves from a finite parent slice, so infinite depth would need infinite budget,
which local admission already forbids — an explicit depth limit is only a legibility
soft-stop, not an independent safety mechanism.

## Non-goals

- **No new fact object.** `Goal` is **not** added to `types.ts`. The durable intent
  lives as a **controller `Run`'s** `objective` + `criteria`; the durability that
  "outlives a single attempt" is the **controller persisting and re-spawning its failed
  workers** (the controller itself is never re-spawned, so its `runId` is the stable
  identity), not a separate object.
- **No second scheduler / workflow DSL / Goal-runtime.** We do **not** add a
  scheduler, a workflow DSL, a separate Goal object, or Alma-style
  `harness/sprint/mission` orchestration. **We do add one new execution *mode* on
  `Run`** — the **controller** (a resumable, runtime-owned supervision loop). Stated
  openly: this is an **explicit reversal** of the old version's "persistence is the
  Goal's loop, not a Run continuation mode" — here persistence **is** a Run controller
  mode. That is the one genuinely new runtime mechanism; the trade is that it lives on
  `Run`, not on a new object.
- **Achievement only.** A Run audits an **end-state**; passing → `complete`. There is
  **no `maintenance` type and no `type` field** — "monitor X forever" needs a
  wake-up/trigger source, which is the schedule-driver work held out of scope below.
- **No projection objects.** `Turn / Task / Team / Channel / Step / kind` are views
  over the facts, never stored entities — `kind` **becomes derived** (its physical
  removal is gated on landing `disposition` + migrating its consumers, sequenced as the
  **first build-order step** of this one PR — see *Shape*).
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
| **Run** | What did the agent attempt — and, recursively, what did its children attempt? | exists (`AgentRunTrigger` + `parentRunId` lineage + `anchor: AgentRunAnchor`); **enriched here** (objective / criteria / scope / budget / dual status — no new lineage field) |
| **RunEvent** | What happened inside a Run? | exists |

These are the write-model facts of execution + communication; they are **not** the
spec's seven *primitives* (`agent-architecture.md`), which also count **Memory /
Skill / Permission gate** on an orthogonal axis. (Content world, also orthogonal:
`Document` / `Node` / `Command`.)

### `objective` is the why; `trigger` stays provenance

`Run.trigger` (`AgentRunTrigger`) is **already pure provenance** today
(message / node / parent-run / schedule / manual / system) — it never encoded "what
the Run drives toward". So the change here is small and honest: **add no `goal`
trigger variant**, optionally rename the field to `provenance` for clarity, and carry
the why in the **new `objective` field**. (Not "un-conflating" — `trigger` was never
the why; `objective` is simply new.) Some objectives are tracked (a controller),
most are not.

### Projections dissolve — no projection concepts

| Old projection word | Becomes | It is just |
|---|---|---|
| `kind` (turn/background/…) | **deleted (derived)** | derived from `provenance` + lineage + **`disposition`** |
| `Task` | = a **root/tracked Run** | the "tasks" panel renders root Runs |
| `Team` | = a Run's **child Runs** | the run tree under a Run |
| `Channel` | = **Conversation** | a (multi-member) Conversation |
| `Turn` | = render(Message + its Run) | a rendering-layer term only |
| `Step` | = render(RunEvents) | a rendering-layer term only |

So the core write model has **6 fact objects, 0 new, 0 projection concepts**; every UI
view is a rendering of a fact object.

> **`kind` removal has a precondition and real blast radius.** `delegation` /
> `scheduled` / `reflective` derive from lineage + provenance, but **`turn` vs
> `background` = attended vs detached**, which is in *neither* trigger nor lineage —
> the old version carried a `disposition(await|detach)` Run field for exactly this.
> So physical removal **requires first landing `disposition: attended | detached` as a
> persistent Run field**, then migrating `kind`'s ~17 load-bearing consumers
> (`agentEventStore.ts` delegation/conversation indexing, the `reflective` Dream-skip
> in `agentRuntime.ts`, the `turn` count in `agentDebugView.ts`). It is **orthogonal
> to the goal capability**, so it ships **as the first build-order step** of this one PR
> (the risky interface settled before the goal loop) — see *Shape*.

### Keep / drop / rename verdicts

- **Core noun names stay** — no fact-object rename.
- **The real changes:** **enrich `Run`** (objective + acceptance criteria + scope +
  budget-slice + persistent `disposition` + a second status axis
  `objectiveStatus` + the controller behavior on internal nodes); **RENAME the `Agent`
  delegate tool → `spawn`**; rename the owner/parent controls to the uniform
  `run_status` / `run_send` / `run_stop`; **derive then physically remove `kind`** (gated
  on `disposition` + consumer migration). `trigger` stays as-is (already pure provenance).
  **Do NOT add** a `Goal` object, a `type` field, a `trigger: goal`, a `GoalStatus`, a
  `supersedesRunId` / `objectiveGroupId`, or `Execution` / `Invocation` / `Round` /
  `Capability Lease` / `Workspace`.
- **Automation words are the teaching lens, not identifiers.**

## How it runs

### The one rule: a parent verifies its child (recursively)

> When a Run's attempt **finishes** (its run terminates, leaving its result on the
> wire), its **parent** verifies it **before** accepting it, by spawning a fresh
> **verifier Run**. Completion is never self-declared, at any level — the child only
> **stops**; the parent decides. There is no "I'm done" tool to call.

The **verifier is the one exception to the rule — the base case**: its verdict is
consumed directly and it is **not itself re-verified** (otherwise the recursion would
never bottom out). A verifier is a leaf by construction.

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
it is why **no new scheduler and no separate object** are needed — the new execution
mode is just durable `Run` state the runtime steps (the controller of *The frame*),
not a standalone runtime.

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
  `active | verifying | verified | blocked | budget_exhausted | stopped`. The control /
  verification lifecycle of the objective this Run owns. **`active` is the hub state** —
  a tracked Run that has accepted its objective and is still working toward its
  submission (a controller: decomposing / dispatching / waiting on workers /
  integrating / re-planning; a leaf: executing). Its mere presence (non-null) means
  "this is a tracked objective", which is how the panel / owner controls tell an active
  controller from an untracked Run **without** leaning on `executionStatus`.

```
  executionStatus:  running ──► completed / failed / cancelled        (existing, untouched)
  objectiveStatus:  active ◄─────────────────────┐
                      │ child run terminates       │ verifier fails, budget remains
                      │   (parent SENSES it)       │ (controller re-plans / re-spawns worker)
                      ▼                           │
                   verifying ──────────────────────┘
                      │ parent's verifier passes ──► verified ──► folds up
                      ├─ controller classifies (needs owner/scope · gap repeats N×) ──► blocked
                      ├─ budget reserve denied & over ceiling ──► budget_exhausted
                      └─ owner/parent stop ──► stopped
```

The **four terminal outcomes** that matter to the owner are the **root** controller's
`objectiveStatus`: `verified` (success) / `blocked` / `budget_exhausted` / `stopped`.
Only `verified` is success. A worker that fails verification ends with
`executionStatus: completed` but is simply not accepted upward — the failure is the
controller's `objectiveStatus`, never a corrupted execution state.

### Livelock guard — convergence is designed, locally

Worker↔verifier oscillation (submit → reject → re-spawn → reject …) must not silently
burn a parent's slice. Each verifier rejection yields a **gap-signature** (normalized
failing criterion + gap). A parent watches **its own** child's signatures: if the same
one recurs for **N consecutive attempts with no progress**, the parent sets that branch
`blocked` (escalate) instead of re-spawning again — a purely local decision, no
cross-level scan. Budget is the backstop; the gap-signature is the primary
non-convergence exit.

### Budget is local admission control at each edge

Budget (token/time) is enforced **per edge, before the spend**: when a parent spawns a
child Run (worker or verifier), it **reserves a fixed slice of *its own* budget** for
that child; the child spends only within its slice and sub-reserves from it for any
children of its own. A child that needs more does not read a global pool — it
**terminates leaving that note in its output**; its parent reads it and either re-slices
(a `run_send` amend + re-spawn) or escalates. If a reservation can't be met, that branch goes `budget_exhausted` (or
`blocked` awaiting extension); on completion the reservation **settles** against real
usage. Because each child is bounded by its own slice (not a shared pool), concurrent
fan-out cannot overshoot — a sibling's idle budget is not borrowable without an
explicit re-slice. The **root's** slice is the only top-level ceiling; every level below
is recursive sub-allocation, so the "tree budget" is emergent, not a counter anyone
reads. Independent **runtime hard backstops**, regardless of the loop's own accounting:
**max wall-clock, max-attempts, max-concurrent-children** (depth is bounded by budget
locality — an explicit `max-depth` is only a legibility soft-stop).

### Resume, not deterministic replay

The tree is **event-sourced and resumable**, but **not** Temporal-style deterministic
replay — the controllers' steps (decompose / decide / verifier verdict) are LLM calls
and are nondeterministic. The discipline: **each controller decision is checkpointed
as a RunEvent before its side effects**, so on crash/restart the recorded prefix is
authoritative (replayed as *facts*, not recomputed) and only the next undetermined
decision is freshly computed. Neva resumes supervising the persisted root.

### Reused autonomy rules

- **Ask only in the attended conversation turn.** No Run asks — it self-resolves
  reversible locals; on a directional choice or scope expansion it **stops with a note
  in its output**, and its parent (sensing the termination) classifies the result as
  `blocked` and escalates async (resolved in a fresh attended turn; an awaited parent
  may relay). (Preserves *subagents-never-ask-user*.)
- **Scope** is granted at the root, **inherits down the tree** (narrow-only); needing
  more authority escalates (`blocked`).
- **Budget** is a per-edge slice the parent reserves (above); the tree total is the
  emergent sum, not a pool any level reads.

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
| spawn / manage runs (↓ all downward) | `spawn(objective, {criteria?, scope?, budget?, context?, detach?})`, `run_status`, `run_send`, `run_stop` | **`Agent` → `spawn`**; recursion = a Run calls `spawn`; `criteria` present → a verified contract, absent → an unverified single pass; the controls are uniformly **`run_*`** (renamed from `AgentStatus`/`AgentSend`/`AgentStop`); **new:** the `context` knob + `run_send` amend (objective / criteria / **budget** — `set_budget` folds in here) |
| run feedback (↑) | **— no tool** | the child→parent signal is the run's **own termination + output** (the "wire"); the parent senses it (completion notification) and classifies via the verifier + re-plan. **Removes `request_complete` / `report_blocked`** — a child never self-declares done or blocked (a self-classifying sensor is the very thing the verifier removes) |
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
`status` ← `run_status`; `steer` / `amend` / `extend budget` ← `run_send` (a send is a
soft steer or a hard amend of objective / criteria / budget); `cancel`/`abandon` ←
`run_stop`; `reassign` = stop a child Run, the parent re-spawns.

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

**Recursion is the mechanism, kept safe by the three *local* governors (see "Three
governors, each enforced locally"), not an approval gate.** Each parent reserves a
budget **slice** per child, grants a **narrowed** scope subset, and **verifies** its
direct child — all one-level-local rules. The tree-wide guarantees (bounded spend,
shrinking authority, verified-at-every-level) are the **emergent** sum, with no
tree-wide supervisor and no owner approval gate. Depth is bounded by budget locality;
a soft depth limit is legibility only.

## Engineering contracts

The precise shapes the one cut commits to.

**Enriched `Run` record** (`src/core/types.ts` / `agentEventLog.ts`):

```
Run {
  runId                    // primary key; for a controller this IS the stable task identity
  anchor: AgentRunAnchor   // EXISTING discriminated union (conversation | principal); a tracked /
                           //   detached root is conversation-anchored for delivery + owner controls,
                           //   reflective stays principal-anchored
  objective: string        // the why (= this level's "goal"); always present
  criteria?: string[]      // the contract its parent verifies it against (root = the user's);
                           //   absent → an unverified single pass
  provenance               // EXISTING `trigger` (already pure provenance); add no `goal` variant
  disposition              // NEW persistent field: attended | detached — the home for turn↔background
                           //   once `kind` is derived (currently only a `spawn` param / debug `kind`)
  parentRunId?             // exists today; a Run knows only ONE level up. No rootRunId —
                           //   "everything under root R" is a walk over parentRunId / childRunIds,
                           //   or a pure denormalized index added later only if that query gets hot
  role                     // controller | worker | verifier — DERIVED from tree position, not stored
  scope                    // capability ∩ scope; inherits down, narrow-only
  budget { reserved, spent } // this Run's OWN slice; the parent reserves it at spawn (local admission)
  executionStatus          // running | completed | failed | cancelled — EXISTING, unchanged
  objectiveStatus?         // NEW (controller / tracked only): active | verifying | verified
                           //   | blocked | budget_exhausted | stopped; non-null ⟺ tracked
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
  `verifying` **aborts the current verifier**. A `verified` verdict never carries across
  a criteria change.

**Tool contracts (params + returns) — pinned now, not at build time.** The new/changed
tools' exact shapes (the unchanged sense/mutate/`skill`/`ask_user_question` tools keep
their current contracts). `RunId = string`; every result is the existing
`ToolEnvelope<…>` (`{ ok, data | error }`), shown here as the `data` payload.

```
// create — a Run spawns a Run (root or child). criteria present ⇒ tracked + verified.
spawn(objective: string, opts?: {
  criteria?:  string[],                       // acceptance contract (⇒ objectiveStatus, verifier gate)
  scope?:     ScopeSpec,                       // capability ∩ scope; must be ⊆ caller's (narrow-only)
  budget?:    { tokens?: number, wallClockMs?: number },  // the slice the parent reserves; REQUIRED at a detached root (the top ceiling)
  context?:   'full' | 'brief' | 'none',       // default 'brief' detached / 'full' explicit continuation
  detach?:    boolean,                         // detached (tracked, notifies) vs inline
  model?:     string,                          // optional per-block model (loop-chosen by default)
}) -> { runId: RunId, objectiveStatus?: ObjectiveStatus }   // the handle; tracked-only objectiveStatus

// NO upward tool. The child→parent feedback is the run's OWN lifecycle: when its run reaches a
// terminal executionStatus (completed | failed) it leaves its result + a note on the "wire"; the
// parent SENSES that (completion notification), runs the verifier on raw evidence, and classifies
// the outcome itself — pass → fold up; fail+gap → re-spawn the worker, or controller → blocked +
// notify owner. A child never self-declares done or blocked. (Removes request_complete / report_blocked.)

// owner/parent controls — require OWNING the target (ancestor / same conversation)
run_status(runId: RunId) -> {
  runId, role: Role, objective: string,
  executionStatus: ExecutionStatus,            // running | completed | failed | cancelled
  objectiveStatus?: ObjectiveStatus,           // active | verifying | verified | blocked | budget_exhausted | stopped
  budget: { reserved: number, spent: number },
  children?: { runId, role, objectiveStatus, executionStatus }[],   // a controller's subtree (one level)
  latestGap?: { signature: string, detail: string },
  result?: Json,                               // present iff objectiveStatus = verified
  blockedReason?: string,                      // present iff blocked
}
run_send(runId: RunId, opts: {                 // steer (soft) OR amend (hard) — one "modify a running tree" verb
  message?: string,                            // soft steer: inject guidance; does NOT invalidate verdicts
  amend?:   { objective?: string, criteria?: string[], budget?: { tokens?, wallClockMs? } },
}) -> { runId: RunId, objectiveStatus?: ObjectiveStatus, budget?: { reserved, spent } }
  // amend.objective/criteria bump criteriaRevision + invalidate verdicts; amend.budget does NOT
  // (it is admission-control headroom, not a goalpost). `set_budget` is folded in here.
run_stop(runId: RunId, opts?: { reason?: string })
  -> { runId: RunId, objectiveStatus: 'stopped' }          // stops the Run and its subtree

// verifier result (internal — produced by the verifier Run, consumed by the controller)
VerifierVerdict = { verdict: 'pass' | 'fail', gaps: { signature, criterion, detail }[] }
```

**Preconditions** (the catalog filter), keyed on **`role`** (derived from lineage, never
stored): `spawn` needs spawn capability (a controller / decomposing Run, and Neva at the
root); `run_status` / `run_send` / `run_stop` require **owning the target** (Neva over a
root; a controller over its child); `ask_user_question` requires **`attended`**. There is
**no upward tool to gate** — the child→parent feedback is the run's own termination +
output, which the parent senses; "stopping" needs no capability. So **every gated tool is
downward** (controller → its plant). The **verifier** gets none of them — not `spawn`, not
the downward control family (sensor ≠ actuator); it only reads its runtime-pinned evidence
pack and returns a `VerifierVerdict`, the **base case**, so verification never itself
bottoms out into more verification (no infinite regress).

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
within the PR** (A7), not separate releases. The PM has **ratified the single-PR shape**
over the gate's split recommendation; the accepted trade is a large blast radius,
**mitigated by landing the risky orthogonal interface (disposition + `kind` migration,
the renames) as the first build-order step** so the protocol/naming churn is settled
before the goal loop is layered on. Build-order:

1. **Protocol & naming interface (first, A4/A10).** Land the persistent
   `disposition: attended | detached` field and **migrate `kind`'s ~17 consumers**
   (delegation/conversation indexing, `reflective` Dream-skip, `turn` debug count) to the
   `provenance + lineage + disposition` derivation, **then remove `kind`**. In the same
   step: enrich `Run` (objective / criteria / scope / budget;
   `executionStatus` kept + `objectiveStatus` new); `spawn(objective, {criteria, …})` (the
   `Agent`→`spawn` rename + the `context` knob); the `run_status/run_send/run_stop`
   rename (`run_send` carries the amend incl. budget); the precondition-catalog tool
   layer. (Touches `commands.ts` / `types.ts` / `agentEventLog.ts`.)
2. **Control + verifier, capped at depth/fan-out = 1 (early end-to-end point).** Build
   and **verify the whole loop end-to-end at the minimal tree** — root controller → one
   worker → `context:'none'` **verifier Run** (runtime-assembled evidence pack +
   `continuation.md` rubric, read-only, no actuation) → re-spawn-the-failed-worker /
   controller-re-plans-in-place → the `objectiveStatus` transitions → livelock guard →
   budget admission control + hard backstops → event-sourced resume → the four terminal
   outcomes. Capping depth/fan-out = 1 gives an early end-to-end verification point for
   the highest-blast capability **inside the single PR** (a safety cushion suggested by
   the gate), before recursion is unlocked.
3. **Uncap → arbitrary depth.** Remove the depth/fan-out cap (a worker may itself be a
   controller — the *same edge code*, nothing new); recursion to arbitrary depth, kept
   safe by the three **local** governors (slice reservation, narrowing scope, parent
   verifies child) — no tree-wide supervisor, no owner approval gate.
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
  only leaf workers re-spawn.** Lineage is `parentRunId` (one level up) + `childRunIds`
  (one level down) only — **no `rootRunId`**, no `supersedesRunId` / `objectiveGroupId`.
- **Two status axes:** `executionStatus` (existing, untouched) + `objectiveStatus` (new,
  controller/tracked only: `active | verifying | verified | blocked | budget_exhausted |
  stopped`; `active` is the hub state, non-null ⟺ tracked). No overloaded single enum, no
  separate `GoalStatus`.
- **Controller Run = runtime-owned supervisor state**, not a long-lived process; its
  steps are bounded LLM calls checkpointed as RunEvents.
- **`spawn` + uniform `run_status/run_send/run_stop`**; recursion = a Run calls `spawn`.
  **All four are downward (controller → its plant).**
- **No upward tool.** The child→parent feedback is the run's own termination + output,
  sensed by the parent (no `request_complete` / `report_blocked`). A child never
  self-declares done or blocked; the parent classifies via the verifier + re-plan (a
  self-classifying sensor is exactly what the verifier exists to remove).
- **Achievement only; no `maintenance`, no `type` field.**
- **Verifier default = same model, fresh `none` context, adversarial framing**;
  different-model is the owner-gated high-stakes opt-in.
- **Budget mandatory + admission-controlled**; over-ceiling → `blocked` (or
  `budget_exhausted`). Unbounded is not a default.
- **`kind` becomes derived** (physical removal gated on landing `disposition` +
  migrating consumers, sequenced as the first build-order step of the single PR);
  `trigger` stays provenance (add no `goal` variant — it is already pure provenance).
- Workers/verifiers are **Runs, not identities** (one-Neva); team formation needs **no
  owner approval**.

## Risks

- **Protocol + prompt surface (A4/A10).** Touches `src/core/types.ts` /
  `agentEventLog.ts` / `commands.ts` (the `Run` enrichment, the dual status
  axes, `spawn` params, the `run_*` renames incl. `run_send` amend) and the model-facing
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

- [ ] **Protocol & naming interface (first)** — land persistent `disposition: attended |
      detached`; migrate `kind`'s ~17 consumers to `provenance + lineage + disposition`,
      then remove `kind`; enrich `Run` (objective / criteria / scope / budget; `anchor`
      reused; `executionStatus` kept + `objectiveStatus` new); `provenance`
      = the existing `trigger`; derived `role`; `spawn(objective, {criteria, scope?, budget?,
      context?, detach?})` (rename `Agent`→`spawn`); rename controls to `run_status` /
      `run_send` (carries amend incl. budget) / `run_stop`; the precondition-catalog tool layer.
- [ ] **Control + verifier @ depth/fan-out = 1 (early end-to-end)** — leaf worker vs
      persistent controller (runtime-owned supervisor state); controller re-spawns a failed
      worker / re-plans in place on its own failure; the `objectiveStatus` transitions;
      attempts tracked via `childRunIds` + controller RunEvents; event-sourced resume
      (decisions checkpointed before side effects). **Verify end-to-end here** before
      uncapping.
- [ ] **Parent-verifies-child** — runtime-spawned `context:'none'` verifier Run;
      runtime-built evidence pack (changed nodes/files, tool refs, run ids, full trace) +
      read-only inspection tools, no actuation; port `continuation.md`; verifier result
      schema → `latestGap`. Root verified by Neva against the user's criteria.
- [ ] **Livelock guard** — gap-signature; `N` consecutive no-progress repeats → `blocked`.
- [ ] **Budget** — local admission control at each edge (parent reserves a child's slice
      before spawn, settles on completion) + runtime hard backstops (wall-clock /
      max-attempts / max-concurrent; depth is bounded by budget locality).
- [ ] **Uncap → arbitrary depth** — remove the depth/fan-out cap (a worker may itself be
      a controller, the *same edge code*); recursion to arbitrary depth, kept safe by the
      three **local** governors (slice reservation / narrowing scope / parent-verifies-child)
      — no tree-wide supervisor, no owner approval gate.
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
