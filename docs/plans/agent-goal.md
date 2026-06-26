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
| **scope** | a child inherits a **narrowed subset** of the parent's scope (set at spawn); needing more is **never granted in place** — stop + re-spawn wider (⊆ parent), or **escalate** | authority only ever shrinks downward — no global scope table |
| **verification** | the **parent** verifies its **direct** child before accepting | "verified at every level" falls out of every edge doing it |

A child that needs more does **not** consult a global ceiling — it **stops with that note
in its output** and its parent reads it. The two resources resolve **differently**, by
design: more **budget** is a `run_amend` (headroom, in place); more **scope** is **never
granted in place** — the parent must `run_stop` + re-`spawn` with a wider (still ⊆ its own)
scope, or, if the need exceeds the parent's own scope, escalate. Root-level scope expansion
returns to the **attended ask-gate** (the user re-authorizes), per *No silent autonomy*.
**Depth needs no separate cap:** each nesting
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
- **`role`** (controller | worker | verifier) is a **display label**, not a gate.
  *controller* = has children, *worker* = leaf — a **post-hoc** description, never the basis
  for the `spawn` gate (a tracked Run has no children before its first `spawn`; gating spawn
  on "is-a-controller" would deadlock it — see *Preconditions*). The `spawn` gate is the
  **`agent.delegate.spawn` capability** in `scope`. And **`verifier` must be persisted**, not
  derived: a verifier is a leaf a controller spawned to audit a submission, so it is
  **structurally identical to a leaf worker** (`parentRunId` + no children); its
  load-bearing safety contract (`context:'none'`, read-only, no actuation, output consumed
  as a `VerifierVerdict`) has to **survive a restart**, which a pure tree-position
  derivation cannot guarantee. So a Run carries a persistent **`purpose: 'work' | 'verify'`**
  (execution metadata, **not** a new fact object), set by the runtime at spawn; `verifier`
  is read from it. Identity is still never stored — `purpose` is a safety class, not a self.

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
  budget-slice + persistent `disposition` + persistent `purpose` (work / verify) + a second
  status axis `objectiveStatus` + the controller behavior on internal nodes); **RENAME the `Agent`
  delegate tool → `spawn`**; rename the owner/parent controls to the uniform
  `run_status` / `run_steer` / `run_amend` / `run_stop`; **derive then physically remove `kind`** (gated
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

> **Evidence-pack contract (the load-bearing input — pinned, not build-time).** The pack
> is assembled from **three sources**, so it never depends on a worker's word: (1) **node /
> doc** changes from the run's **command RunEvents** (already event-sourced, authoritative);
> (2) **direct file** changes from the `file.edit` / `file.write` / `file.delete`
> tool-call records (the existing action-kind profiles); (3) **indirect file** changes —
> when a worker writes via `shell` / a script, the tool trace does **not** name what
> changed, so the runtime captures a **before/after diff over the run's allowed file
> area** (a working-set snapshot bracketing the run). The verifier receives a **normalized
> changeset** `{ nodes, files+diffs, tool_call↔tool_result refs, run ids, full trace }`.
> Any change the runtime **cannot attribute** (outside the allowed area, or untracked) is
> surfaced **as unattributed**, never silently dropped — an unverifiable change is a `fail`,
> consistent with "uncertain evidence = not achieved".

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
  **unchanged** as a field. Process/ledger semantics: is this Run's own work in progress,
  done, errored, aborted? **Process/ledger consumers** (running/active-run detection,
  projections) keep reading it unchanged; the **two consumers that conflate `running` with
  "a step is in flight" — Dream/reflective skip and UI-busy — migrate** to the
  in-flight-step / `objectiveStatus` signal (enumerated under *A controller's
  `executionStatus`* below). Not "every consumer is untouched".
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

   blocked / budget_exhausted ──(owner un-blocks: run_amend budget · ask-gate scope)──► active
                                  (same runId; executionStatus stays `running`, never resurrected)
```

The **four terminal outcomes** that matter to the owner are the **root** controller's
`objectiveStatus`: `verified` (success) / `blocked` / `budget_exhausted` / `stopped`.
Only `verified` is success. These are terminal on the **objective axis** — the owner-facing
notify endpoints — but **`blocked` / `budget_exhausted` are NOT terminal on the execution
axis**: the run stays `running` (parked awaiting the owner) and is resumable, so the owner
can un-block it (extend budget / re-authorize) on the *same* run. A worker that fails
verification ends with `executionStatus: completed` but is simply not accepted upward — the
failure is the controller's `objectiveStatus`, never a corrupted execution state.

#### A controller's `executionStatus` — closing the process/objective mapping

A controller is **one** event-sourced Run (never re-spawned), so its `executionStatus`
tracks **the lifecycle of that run as a whole**, and the objective detail rides
`objectiveStatus`:

| Controller is… | `executionStatus` | `objectiveStatus` |
|---|---|---|
| pursuing its objective (running a step **or parked** waiting on children/verifier) | `running` | `active` / `verifying` |
| **parked awaiting the owner** (blocked, or a soft budget pause — **resumable**) | `running` | `blocked` / `budget_exhausted` |
| objective verified | `completed` | `verified` |
| a **hard backstop** fired (max-wall-clock / max-attempts) — terminal | `completed` | **`budget_exhausted`** (set explicitly) |
| owner `run_stop` (incl. owner give-up) | `cancelled` | **`stopped`** (set explicitly) |
| the controller run itself crashed/errored | `failed` | (last value — error path) |

> **Invariant — no `completed`/`cancelled` with a non-terminal objective.** Whenever
> `executionStatus` goes terminal, `objectiveStatus` is **first resolved to a terminal
> value** (`verified` / `blocked` / `budget_exhausted` / `stopped`) — it is **never left at
> `active` / `verifying`**. So a hard backstop sets `budget_exhausted` (not "last value"),
> and owner give-up is a `run_stop` → `stopped`. (`failed` is the crash/error path —
> recovered on restart, not an owner notify endpoint, so "last value" is acceptable there.)

The subtle row is **blocked / soft budget pause = parked *awaiting the owner***: structurally
the same as parked-awaiting-children, so it stays **`running`**, not `completed`. This is
load-bearing for the never-re-spawned / stable-`runId` invariant — **un-block is an
`objectiveStatus: blocked → active` transition on the *same* run**, never a `completed →
running` resurrection (which the ledger treats as terminal), and it is what makes a
`run_amend`-budget on a blocked goal physically possible (you cannot amend a `completed`
run). **`budget_exhausted` is disambiguated by the execution axis:** `+ running` = soft
pause, resumable on an owner budget extension; `+ completed` = a hard backstop tripped,
terminal. An abandoned blocked goal is eventually collected by the **max-wall-clock
backstop** → `completed` (terminal), its `objectiveStatus` resolved to `budget_exhausted`.

So `executionStatus: running` for a controller means **"this objective is live"** (pursuing
*or* parked, awaiting children or the owner). **"Is a step in flight *right now*"** is a
*transient* condition (any in-flight child/verifier step), **derivable, never a persisted
ledger state** — there is no new enum value. Consumers split cleanly:

- **active-run detection** reads `executionStatus = running` → unchanged (a parked
  controller IS active — tracked + restored on restart). A blocked controller stays in this
  set *awaiting the owner* (it is not force-advanced — that is the `objectiveStatus`'s job).
- **Dream/reflective skip** must **switch to the in-flight-step signal**, not raw
  `running` — else a long parked controller would suppress reflection indefinitely.
- **UI busy/spinner** reads `objectiveStatus` (`active`/`verifying`) **plus** the
  in-flight-step flag — never raw `running` — so a parked controller shows "working on a
  goal", not a spinning "thinking now".

These three are the consumers the build-order step 1 migration must touch; everything else
keeps reading `executionStatus` as today.

### Livelock guard — convergence is designed, locally

Worker↔verifier oscillation (submit → reject → re-spawn → reject …) must not silently
burn a parent's slice. Each verifier rejection yields a **gap-signature** (normalized
failing criterion + gap). A parent watches **its own** child's signatures: if the same
one recurs for **N consecutive attempts with no progress**, the parent sets that branch
`blocked` (escalate) instead of re-spawning again — a purely local decision, no
cross-level scan. Budget is the backstop; the gap-signature is the primary
non-convergence exit. This guard is also what makes removing the upward `report_blocked`
tool safe: a worker that is *genuinely* stuck but does not surface it gracefully
degrades into a repeating gap, which trips here at `N` — bounded waste, never a silent
stall (see the cost note under *Reused autonomy rules*).

### Budget is local admission control at each edge

Budget (token/time) is enforced **per edge, before the spend**: when a parent spawns a
child Run (worker or verifier), it **reserves a fixed slice of *its own* budget** for
that child; the child spends only within its slice and sub-reserves from it for any
children of its own. A child that needs more **budget** does not read a global pool — it
**terminates leaving that note in its output**; its parent reads it and either grants more
headroom (a `run_amend` for a live controller child, or a re-`spawn` with a bigger slice
for a terminated worker) or escalates. If a reservation can't be met, that branch goes `budget_exhausted` (or
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
- **Scope** is granted at the root, **inherits down the tree** (narrow-only), and is set
  only **at spawn**. It is **never widened in place** (no `run_amend` for scope): more
  authority within the parent's own scope = stop + re-spawn wider; beyond it = escalate;
  a **root** scope expansion returns to the **attended ask-gate** for re-authorization.
- **Budget** is a per-edge slice the parent reserves (above); the tree total is the
  emergent sum, not a pool any level reads.

> **The cost of having no upward tool — named honestly.** `done` and `blocked` are *not*
> symmetric in their failure mode. `done`'s hazard is a **false positive** (a worker
> claims "complete" to stop working) — which is exactly why an independent verifier
> exists. `blocked`'s real hazard is a **false negative** (a worker is genuinely stuck —
> missing credentials / scope — and hands up a poor result instead of signalling).
> Removing the structured `report_blocked` creates *no new* false-positive risk, but it
> does remove the worker's cheap **first-round** path to surface "I need X": the
> controller must now infer it from the worker's terminal note. **Known cost:** a
> truly-blocked worker escalates only after its gap repeats — `fail, gap='no auth'` →
> re-spawn → same gap → … → the **livelock guard** trips at `N` → `blocked` → owner
> notified. So a real block can burn up to `N` retries (+ their budget) before
> escalating, where `report_blocked` would have escalated on round 1. **Why we accept
> it:** the degradation is **graceful, never silent** — a missed soft-report is always
> caught by the livelock guard (gap-signature repeat) or the budget backstop, so the
> worst case is *wasted retries, never a stalled tree*. The worker's terminal-note
> output-contract keeps the common case to ≈1 round; `N` + budget is the bounded tail.

## Tool surface

Tools are **precondition-gated**, replacing today's two-stage assembly
(presence-based inclusion in `createAgentTools` + name allow/deny in
`filterAgentTools`) with one predicate model. A **catalog wrapper**
`{ tool, precondition }` carries the predicate — it does **not** add a field to the
vendor `AgentTool` type, nor touch each tool factory:

```
visibleTools(run) = catalog.filter(entry => entry.precondition(principal, attended, lineage))
```

`role` is computed inside the predicate: **controller vs worker** from `lineage` (has
children vs leaf), but **`verifier` from the persisted `purpose`** field — a verifier is
structurally identical to a leaf worker, so its read-only / no-actuation contract cannot be
re-derived from tree position and must be stored (set by the runtime at spawn, recoverable
across restart).

> **Scope reuses the existing capability taxonomy — no parallel enum.** Both this
> catalog and `scope`-narrowing speak the **existing `AgentToolActionKind`**
> (`agentPermissionModel.ts`, ~40 fine-grained kinds) that already drives the A3
> permission gate, `isReadOnlyActionKind`, and the research read-only set — *not* a new
> coarse `'read' | 'write' | …` enum. A coarse vocabulary would be both **parallel**
> (needing a hand-maintained, drift-prone mapping to action-kinds) and **lossy** (a single
> `'read'` cannot express "may read the project area but not sensitive paths", a
> distinction the gate already makes). So `scope ⊆ caller's` is set intersection over
> action-kinds, and every scope→gate decision stays authoritative on that one taxonomy.
> The `run_amend` control (the new command) adds one new kind, **`agent.delegate.amend`**,
> alongside the existing `agent.delegate.spawn / status / send / stop`.

| Category | Tools | Note vs today |
|---|---|---|
| sense | `file_read`, `web_search`, `web_fetch`, `past_chats` | unchanged |
| mutate doc / local | node + file write family | unchanged (in-scope only) |
| spawn / manage runs (↓ all downward) | `spawn(...)`, `run_status`, `run_steer`, `run_amend`, `run_stop` | **`Agent` → `spawn`**; recursion = a Run calls `spawn`; `criteria` is **required unless `verify:false`** (no silent unverified downgrade); controls are uniformly **`run_*`** (renamed from `AgentStatus`/`AgentSend`/`AgentStop`); **new:** the `context` knob, plus the steer/amend split — `run_steer` (soft, no verdict impact) vs `run_amend` (hard: objective / criteria / **budget**; subsumes `set_budget`) |
| run feedback (↑) | **— no tool** | the child→parent signal is the run's **own termination + output** (the "wire"); the parent senses it (completion notification) and classifies via the verifier + re-plan. **Removes `request_complete` / `report_blocked`** — a child never self-declares done or blocked (a self-classifying sensor is the very thing the verifier removes) |
| ask user | `ask_user_question` | unchanged tool; precondition-gated to `attended` |
| load procedure | `skill` | unchanged |

Because everything is a Run, `spawn` + `run_status/run_steer/run_amend/run_stop` is
internally consistent (no `goal_*` vs `run_*` split). The existing commands
`agent_child_run_status/send/stop` (`commands.ts`) already share the `run` stem and cover
status / steer (the old `send`) / stop; **`run_amend` is the one new command surface**
(amend objective / criteria / budget), which the protocol step adds.

The `context` knob makes the fork/fresh axis explicit: a code **fork inherits the
whole conversation** (`context: 'full'`); `'brief'` passes a distilled brief; `'none'`
is a clean slate. The **verifier Run is runtime-pinned to `none`**; a worker picks
`full` only when its objective directly continues the thread, else `'brief'` /
`'none'`.

Owner/parent controls require **owning the target** (ancestor / same conversation):
`status` ← `run_status`; **soft** `steer` (a hint, no verdict impact) ← `run_steer`;
**hard** `amend` / `extend budget` (objective / criteria / budget; invalidates verdicts on
objective/criteria) ← `run_amend`; `cancel`/`abandon` ← `run_stop`; `reassign` = stop a
child Run, the parent re-spawns.

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
UI**, derived from tree position (with `verifier` read from the persisted `purpose`) — the
"tasks" view renders a Run's children by function, never as "N Nevas".

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
                           //   required for a verified objective — the only unverified path is an
                           //   explicit `verify:false` spawn, never a silent omission
  provenance               // EXISTING `trigger` (already pure provenance); add no `goal` variant
  disposition              // NEW persistent field: attended | detached — the home for turn↔background
                           //   once `kind` is derived (currently only a `spawn` param / debug `kind`)
  parentRunId?             // exists today; a Run knows only ONE level up. No rootRunId —
                           //   "everything under root R" is a walk over parentRunId / childRunIds,
                           //   or a pure denormalized index added later only if that query gets hot
  purpose                  // NEW persistent exec metadata: 'work' | 'verify' (default 'work'). 'verify' is set by the
                           //   runtime at spawn and CANNOT be re-derived — a verifier is structurally a leaf worker;
                           //   its context:'none' / read-only / no-actuation contract must survive restart
  role                     // controller | worker | verifier — controller/worker DERIVED (children vs leaf);
                           //   VERIFIER is read from `purpose`, not tree position
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
- **Amendment invalidation:** an owner `run_amend` to a Run's objective/criteria
  **invalidates any prior or in-flight verifier verdict** for it; amending while
  `verifying` **aborts the current verifier**. A `verified` verdict never carries across
  a criteria change. (A `run_steer` message never invalidates a verdict — that is the
  whole reason the two are separate tools.)

**Tool contracts (params + returns) — pinned now, not at build time.** The new/changed
tools' exact shapes (the unchanged sense/mutate/`skill`/`ask_user_question` tools keep
their current contracts). `RunId = string`; every result is the existing
`ToolEnvelope<…>` (`{ ok, data | error }`), shown here as the `data` payload.

```
// create — Neva spawns the root goal, or a controller spawns a child. The model sees ONE
// flat params object (objective + the named opts below), not a positional arg + opts.
spawn({
  objective:  string,                          // WHAT to pursue, in prose. NOT the acceptance test — that is `criteria`.
  criteria?:  string[],                        // the acceptance contract the parent verifies it against (root = the user's).
                                               //   REQUIRED unless verify:false; each item = one independently-checkable condition.
  verify?:    boolean,                         // default TRUE. Pass false ONLY for a throwaway, fire-and-forget single pass
                                               //   (then no criteria, no verifier). Omitting criteria while verify:true is an
                                               //   ERROR, never a silent downgrade to unverified.
  scope?:     ScopeSpec,                       // capability ∩ resource scope; must be ⊆ caller's (narrow-only). Default = caller's.
  budget?:    Budget,                          // the slice the parent reserves for this child. REQUIRED at a detached root
                                               //   (the top ceiling); on a child it defaults to a parent-chosen slice of its headroom.
  context?:   'full' | 'brief' | 'none',       // how much conversation the child inherits: 'full' = whole thread (continuation),
                                               //   'brief' = distilled brief, 'none' = clean slate. Default: 'brief' if detach, else 'full'.
  detach?:    boolean,                         // default false. true = detached (tracked, runs past the turn, notifies on outcome);
                                               //   false = inline (resolves within the turn).
  model?:     string,                          // optional; a known model alias (e.g. opus / sonnet / haiku), validated against the
                                               //   registry. Omit to let the loop choose (the default).
}) -> { runId: RunId, objectiveStatus?: ObjectiveStatus }   // the handle; objectiveStatus present iff TRACKED
                                                            //   (criteria given / verify true) — initial value 'active', NOT 'verified'

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
// run_steer — SOFT: inject guidance into a running Run WITHOUT moving its goalposts.
//   Changes nothing on the contract and NEVER invalidates a verifier verdict.
run_steer(runId: RunId, message: string)
  -> { runId: RunId, objectiveStatus?: ObjectiveStatus }

// run_amend — HARD: change a running Run's contract or headroom. Use sparingly.
//   Amending objective/criteria bumps criteriaRevision and INVALIDATES any prior or in-flight
//   verdict (amending while `verifying` aborts the current verifier); amending budget does NOT
//   (it is admission-control headroom, not a goalpost). Subsumes the old set_budget.
run_amend(runId: RunId, changes: { objective?: string, criteria?: string[], budget?: Budget })
  -> { runId: RunId, objectiveStatus?: ObjectiveStatus, budget?: { reserved, spent } }

run_stop(runId: RunId, opts?: { reason?: string })
  -> { runId: RunId, objectiveStatus: 'stopped' }          // stops the Run and its subtree

// shared shapes
Budget    = { tokens?: number, wallClockMinutes?: number }    // natural units — ms would invite magnitude errors
ScopeSpec = {
  capabilities: AgentToolActionKind[],   // the allowed action-kinds — REUSES the EXISTING fine-grained
                                         //   taxonomy in agentPermissionModel.ts (file.read.allowed_file_area /
                                         //   file.read.sensitive_local_path / file.edit.* / shell.* / agent.delegate.* /
                                         //   web.* / agent.skill.invoke …), NOT a new coarse enum. Must be ⊆ caller's.
  resources?:  { docs?: DocId[], paths?: string[] },   // optional further narrowing of the concrete allowed area (default: caller's)
}   // narrow-only. The scope→A3-gate boundary runs entirely on AgentToolActionKind, so the
    // permission gate's allow/deny + isReadOnlyActionKind stay the single authority — no parallel taxonomy

// verifier result (internal — produced by the verifier Run, consumed by the controller)
VerifierVerdict = { verdict: 'pass' | 'fail', gaps: { signature, criterion, detail }[] }
```

**Preconditions** (the catalog filter): **`spawn` is gated on the `agent.delegate.spawn`
capability being in the Run's `scope`** — **not** on a structural "is-a-controller (has
children)" check. That distinction matters: a freshly-created tracked controller has **no
children before its first `spawn`**, so a children-based gate would deadlock it into
`worker` and deny it `spawn` (a bootstrap loop). Capability-gating sidesteps it entirely —
Neva grants `agent.delegate.spawn` to any Run meant to decompose; `controller` vs `worker`
remains a **post-hoc display label** (has children vs leaf), never the gate. The other
controls — `run_status` / `run_steer` / `run_amend` / `run_stop` — require **owning the
target** (Neva over a root; a controller over its child); `ask_user_question` requires
**`attended`**. There is
**no upward tool to gate** — the child→parent feedback is the run's own termination +
output, which the parent senses; "stopping" needs no capability. So **every gated tool is
downward** (controller → its plant). The **verifier** gets none of them — its `purpose:
'verify'` scope omits `agent.delegate.spawn` and the whole write family (sensor ≠ actuator);
it only reads its runtime-pinned evidence pack and returns a `VerifierVerdict`, the **base
case**, so verification never itself bottoms out into more verification (no infinite regress).

### Tool descriptions (model-facing) — authored now, not deferred

The prompt text each new/changed tool ships with (lifted into its `prompt.ts` at build).
Each follows one template: a line of *what*, then *when to use* / *when NOT*, then
per-param guidance. (The unchanged sense / mutate / `skill` / `ask_user_question` tools
keep today's text.)

**`spawn`** — *Hand an objective to a fresh Run that pursues it autonomously and is
independently verified.*
- *When:* a self-contained objective worth delegating — a long goal the user hands off, or
  a sub-objective you (a controller) want done **and checked** before folding it into your
  own result.
- *When NOT:* a one-line lookup you can do yourself this turn (just do it); work you must
  keep in your own context (don't delegate understanding).
- *Params:* `objective` is the **what**, in prose; `criteria` is the **acceptance test** (a
  list of independently-checkable conditions) — **always provide it** unless you
  deliberately want an unverified throwaway, then pass `verify:false`. `detach` for a goal
  that outlives this turn; narrow `scope` to the least authority the work needs; set
  `budget` at a detached root.
- *Example:* `spawn({ objective: "Migrate the auth module off the deprecated SDK",
  criteria: ["every call site uses the new client", "the test suite passes", "no reference
  to the old package remains"], detach: true, budget: { wallClockMinutes: 90 } })`.

**`run_status`** — *Read one Run's current state and its direct children (one level).*
- *When:* you own a Run and want its progress / verdict / budget, or the runIds of its
  children to drill down.
- *When NOT:* to "check on" a detached child out of impatience — you are notified on its
  outcome; poll only with a reason.
- *Returns:* both status axes, budget, one level of children (recurse via their runIds),
  the latest gap, and the result once verified.

**`run_steer`** — *Inject a hint into a running Run without changing its goal.*
- *When:* nudge approach or priority ("prefer the existing util", "start with the API
  layer") while leaving the objective and acceptance test exactly as they were.
- *When NOT:* to change what "done" means — that is `run_amend`. A steer **never**
  invalidates a verdict.

**`run_amend`** — *Change a running Run's contract (objective / criteria) or its budget.*
- *When:* the requirement genuinely changed, or a Run needs more **budget** headroom.
- *Not scope:* `run_amend` does **not** carry scope — widening scope in place is forbidden.
  More scope = `run_stop` + re-`spawn` with a wider (still ⊆ parent) scope, or escalate;
  root-level scope expansion returns to the attended ask-gate.
- *When NOT:* for a mere hint (use `run_steer`). **Amending objective or criteria
  invalidates any verifier verdict and re-opens verification** — deliberate, not
  micro-management. Amending budget alone does not invalidate a verdict.

**`run_stop`** — *Cancel a Run and its whole subtree.*
- *When:* the objective is abandoned / superseded / going wrong; or to reassign (stop the
  child, then re-`spawn`). Give a `reason` so the record explains why.
- *When NOT:* to pause for input — there is no pause; either steer/amend and let it
  continue, or stop it.

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
   step: enrich `Run` (objective / criteria / scope / budget; persistent `purpose` (work /
   verify); `executionStatus` kept + `objectiveStatus` new + the controller process↔objective
   mapping); `spawn(objective, {criteria, …})` (the
   `Agent`→`spawn` rename + `verify` default + the `context` knob); the
   `run_status/run_steer/run_amend/run_stop` controls (`run_steer` = the old `send`;
   **`run_amend` is the new command surface**); the precondition-catalog tool layer
   (built on the **existing `AgentToolActionKind`**, not a new enum — `scope` speaks the
   same taxonomy). (Touches `commands.ts` / `types.ts` / `agentEventLog.ts` /
   `agentPermissionModel.ts` — the action-kind profile keys follow the tool rename
   (`Agent`→`spawn`, `AgentSend`→`run_steer`) and gain `agent.delegate.amend`.)
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
4. **Delivery / UI** — no explicit Goal entry point. Users describe the work in
   ordinary prose; the model-side `goal-launching` workflow decides when to spawn a
   detached verified Run. Neva remains the root supervisor holding the user's
   objective; the "tasks" panel renders root Runs (children grouped by function
   label, never "N Nevas"); the four root outcomes notify; steering via
   `run_steer` / `run_amend`.

## Open questions

Genuinely open, all build-time-reversible:

1. **Team topology among siblings.** Star (children mutually invisible, consult the
   parent) vs mesh (a goal-scoped ephemeral Channel). **Recommend** star first.
2. **`context` default for a worker.** `full` (continue the thread) vs `brief` (scoped
   slate). **Recommend** `brief` for detached objectives, `full` only on an explicit
   continuation. (A verifier is always `none`.)
3. **Livelock N and budget defaults** — the gap-repeat threshold and the default tree
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
  steps are bounded LLM calls checkpointed as RunEvents. Its `executionStatus = running`
  means "objective live" (even while parked); the process↔objective mapping + the three
  consumers that must change (Dream-skip, UI-busy; active-run unchanged) are pinned above.
- **`verifier` is persisted** via `purpose: 'work' | 'verify'` (exec metadata, not a fact
  object) — a verifier is structurally a leaf worker, so its safety contract can't be
  re-derived from tree position. controller/worker stay derived.
- **Scope is set at spawn, never widened in place** — more scope = stop + re-spawn (⊆
  parent) or escalate; root expansion → attended ask-gate. `run_amend` carries
  objective/criteria/budget only, **not** scope.
- **`spawn` + uniform `run_status/run_steer/run_amend/run_stop`**; recursion = a Run calls
  `spawn`. **All are downward (controller → its plant).** `criteria` is required unless an
  explicit `verify:false`; `run_steer` (soft) and `run_amend` (hard, invalidates verdicts)
  are split so a nudge can't accidentally move the goalposts.
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
  axes, `spawn` params, the `run_*` controls incl. the **new `run_amend` command**) and the model-facing
  `Agent`→`spawn` rename (tool-name constant + prompt text). Land the interface as the
  first build-order step.
- **Autonomy safety.** A self-recursing, budget-spending tree is the highest-blast
  capability. Load-bearing guards, all in this cut: commit-as-scope-authorization, the
  Run terminal outcomes, ask-strict, the **parent-verifies-child rule** (runtime-spawned,
  runtime-assembled evidence, no actuation), the **livelock guard**, and **budget
  admission control + runtime hard backstops** (wall-clock / attempts / concurrency)
  independent of the loop's own accounting. (Depth is **not** an independent backstop —
  it is bounded by budget locality; an explicit `max-depth` is only a legibility
  soft-stop.)
- **Verifier cost & calibration.** Affordable (fires on submissions); but same-model
  default is de-biasing, not decorrelation — document the limit so the different-model
  upgrade is reached for when stakes warrant.
- **Concept creep.** Keep the Run thin (no Goal object, no execution-machinery bloat);
  keep the control loop thin (no workflow DSL); resist re-materializing `Task` / `Team` as
  objects. The engineering contracts above are the line.

## Collision self-check

- `gh pr list` (2026-06-25, latest): **no open PRs** (the plan PRs #340 / #341 are merged;
  #338 closed). Nothing in flight touches runs / delegation / commands.
- `docs/TASKS.md`: the **agent-goal** item is pre-implementation; no other run-tree /
  control-loop item in flight.
- Protocol-surface files (`types.ts` / `agentEventLog.ts` / `commands.ts`) + the
  `Agent`→`spawn` / `run_*` renames land in the interface build-order step first.

Result: **no overlap.**

## Build checklist (one PR, build-order within it)

- [ ] **Protocol & naming interface (first)** — land persistent `disposition: attended |
      detached`; migrate `kind`'s ~17 consumers to `provenance + lineage + disposition`,
      then remove `kind`; enrich `Run` (objective / criteria / scope / budget; persistent
      `purpose` work/verify; `anchor` reused; `executionStatus` kept + `objectiveStatus` new
      + the controller process↔objective mapping; migrate Dream-skip + UI-busy to it); `provenance`
      = the existing `trigger`; derived `role`; `spawn({objective, criteria?, verify?, scope?,
      budget?, context?, detach?, model?})` (rename `Agent`→`spawn`; `criteria` required unless
      `verify:false`); controls `run_status` / `run_steer` (old `send`) / **`run_amend` (new
      command)** / `run_stop`; the precondition-catalog tool layer.
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
- [ ] **Delivery / UI** — no explicit Goal entry point; Neva as root supervisor;
      "tasks" panel renders root Runs (children by function label); the four root
      outcomes notify; steering via `run_steer` / `run_amend`. (light + dark.)
- [ ] **Launching skill** (when/how to create a detached verified Run from
      natural-language intent) authored.
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
