# Agent Goal — autonomous self-continuing runs (and ephemeral executor teams)

## Goal

Let a user (mid-conversation) hand a long-running objective to an agent and have
it pursue that objective autonomously across many rounds until the objective is
**verified** complete — not until the model decides to stop. When the objective
is large, the pursuing agent assembles a **temporary, role-diverse team** of
helper runs and dissolves it on completion.

Concretely:

- A user chatting in a DM can say "now go do X until it's done"; the agent the
  user is already talking to (today: Neva) keeps working in the background,
  re-engaging itself round after round, and notifies back when the objective is
  met, blocked, out of budget, or stopped.
- The same mechanism, when the objective warrants it, spawns specialized child
  runs (researcher / implementer / verifier) that do the work while the pursuing
  run acts as the **referee** that integrates results and audits completion.

The design reuses what already exists (spawned child runs, completion
notification, run usage accounting, Channel delivery, the permission gate, the
`agent_child_run_*` control commands) and isolates the **one genuinely new
atom**: a run whose *continuation* is **persistent** — it self-continues until a
completion audit passes, instead of ending when the model stops.

## Non-goals

- **No new top-level primitive.** Goal is not an 8th primitive and not a `Skill`.
  It is a *continuation mode* of a Run (`persistent`) + a launching skill + run-
  resident objective state. (See *The model* for why a skill cannot supply the loop.)
- **No second "goal" tool family parallel to delegation.** Spawning a goal and
  delegating a sub-task are the *same operation* — spawn a run pursuing an
  objective — differing only by two parameters (`persistent?`, `detach?`). The
  surface unifies on one `spawn`; `Agent` / `set_goal` are at most ergonomic
  aliases over it (see *Tool surface*).
- **No standing/persistent team object.** A team is the set of a persistent run's
  child runs, grouped and dissolved by it — never a durable roster like a Channel.
- **No large built-in role library in this plan.** Within the **one-Neva
  invariant** (post-#300: the `Agent` tool is fork-only — a fork is Neva in an
  isolated context, never a second agent), a "role" is a **Neva fork with a
  narrowed tool/permission profile** (`restrictAgentDefinitionTools` +
  `allowedTools`), not a separate agent. A minimal seed set of fork profiles is
  the only authored content here; a rich library is follow-up.
- **No global retirement of the `background` run kind in one shot.** The framing
  (`background` ≡ "a detached run pursuing an objective") is recorded as the
  target model; the derivation cleanup lands incrementally and is not a precondition.
- **No schedule-driver work.** Time-triggered runs stay a separate **trigger**
  source (a standing cron births runs); trigger is provenance, not a tool-gating
  fact. This plan is the completion-driven (persistent) flavor only.
- **No silent autonomy escalation.** The model may *propose* a goal; *committing*
  one (detaching a budget-spending autonomous pursuit with its own scope) routes
  through the existing ask-gate, in the attended turn.

## Shape

**(b) A set of independent complete features**, ordered by genuine dependency.
Each is independently shippable and verifiable:

- **Feature A — DM goal (single agent).** A user sets a goal in a DM; the pursuing
  run self-continues to a verified completion within an optional budget. Useful
  alone; it is the most common case (mid-conversation hand-off).
- **Feature B — Goal-as-team (referee + executors).** When a goal is large, the
  pursuing run spawns role-diverse narrowed Neva forks and acts as referee. Builds
  on A + existing delegation.

(Feature A is the foundation per A7, but is itself a complete feature, not a
scaffold for B.)

## The model

The framing the whole design rests on. It *reduces* concepts; it does not add a
primitive.

### One execution unit: the Run

Everything that runs is a **Run**, fully described by three recorded facts plus
one derived one:

| Fact | Values | Recorded / derived |
|---|---|---|
| **Principal** | which agent (Neva / researcher / implementer …) | recorded |
| **objective** | what it pursues — **universal**: even a plain turn has one ("answer the user") | recorded |
| **lineage** | standalone \| child-of(parent); a persistent root + its children form a *team* | recorded |
| **continuation** | `single-shot` (stop when the model stops) \| **`persistent`** (self-continue until a completion audit passes) | recorded |
| *attended* | is this the foreground interactive conversation turn? | **derived** |

The spawner also chooses a **disposition** for any run it creates:
**`await`** (block until the child reaches a terminal state) or **`detach`**
(walk away; be notified on completion). `await`/`detach` is a pre-existing caller
choice, *orthogonal* to continuation.

**`persistent` is the single new atom.** Everything else labelled "goal",
"team", "delegation", "turn", "background" is a **projection** over the facts
above:

| Projection | = |
|---|---|
| a *turn* | root run, `single-shot`, awaited by the user |
| a *delegation* | child run, `single-shot`, awaited by its parent |
| a *goal* | a run with `persistent` continuation (+ usually `detach` + a scope) |
| a *team* | the child subtree under a `persistent` run |
| *referee / executor* | the persistent root / its children (lineage names, not an enum) |
| the old *`background` kind* | a `detach`ed run (single-shot = errand; persistent = goal) |

### goal and delegation are the same operation

You call `Agent` *for* some objective; the persistent run audits *against* some
objective; a turn responds *to* one. Objective is universal — so it cannot be
what distinguishes a "goal" from a "delegation". The only differences are the two
parameters `persistent?` and `detach?`. Therefore there is **one spawn
operation**, not a delegation tool plus a goal tool. "Setting a goal" =
`spawn(objective, { persistent, detach, scope })`. (See *Tool surface*.)

### Why a goal cannot be a skill

A `Skill` is reusable instruction *content* injected into a turn. It can tell a
model "do not stop early," but it cannot re-invoke the model after a turn ends —
and the whole point of "keep going until done" is that the loop lives **outside a
single turn**. So a goal cannot *be* a skill. The loop is the `persistent`
continuation of a run; the skill's job is only *when* and *how* to launch one.

### Roles within the one-Neva invariant

Post-#300 the `Agent` tool is **fork-only** (`src/main/agentDelegation.ts:593`,
`contextMode = 'fork'`): a fork is **Neva in an isolated context**, inheriting the
parent's executing and memory-owner identity (`:605-608`) — never a second agent,
no `agent_type`, no own memory line. The only narrowing knob is
`restrictAgentDefinitionTools(createForkAgentDefinition(), params.allowedTools)`
(`:594`).

So a **role is a Neva fork with a narrowed tool/permission profile** (an
`allowedTools` preset) — the *same* Principal in an isolated context, not a new
Principal and not a new axis. The executor team is exactly **a persistent run's
narrowed Neva forks**. The mechanism exists; only a seed set of fork profiles is
authored here. (Reintroducing specialized executor agents would reverse the
one-Neva invariant — explicitly out of scope for this plan.)

## Tool surface

### Organizing principle

Tools are **precondition-gated**, not assembled per-role. Each tool declares a
precondition over a run's four facts; a run computes its visible set once:

```
visibleTools(run) = catalog.filter(t => t.precondition(run.principal, run.attended, run.lineage, run.continuation))
```

No role enum, no driver switch, no "capability layer". Adding a schedule trigger
or a new executor role changes only which facts a run has — never the filter.
`createAgentTools` (`src/main/agentRuntime.ts`, called by `buildTools` — the
actual tool-assembly point) moves from "return a fixed list" to "filter the
catalog".

### Catalog (six categories)

| Cat | Tools | Precondition | vs today |
|---|---|---|---|
| **A — sense** | `file_read`, `web_search`, `web_fetch`, `past_chats` | Principal has read/web family | unchanged |
| **B — mutate doc** | node create/move/edit … | Principal has write family **and** action ∈ permission scope | unchanged |
| **C — spawn / manage runs** | `spawn(objective, {…})`, `runs_status(…)`, **run-control** (`cancel` · `steer` · `resume` · `set_budget`) | Principal has spawn family; the `detach`+`persistent`+*new-scope* path **also requires `attended`**; run-control requires *owning the target* (ancestor / same conversation) | `Agent`+`set_goal` **merge**; `AgentStatus`/`AgentSend`/`AgentStop` already model tools — only `set_budget` is new + goal semantics on `steer` |
| **D — drive a persistent run** | `request_complete()` → triggers audit; `report_blocked(reason)` | `continuation == persistent` (this run is itself persistent) | folded from would-be `update_goal` |
| **E — ask the user** | `ask_user_question` | **`attended`** (strictly the foreground conversation turn) | tool unchanged; gated by `attended` |
| **F — load procedure** | `skill` | none | unchanged; it teaches *when* to spawn persistent/detached |

The current set (file_read / web / node / skill / `ask_user_question` /
`Agent`+`AgentStatus`+`AgentSend`+`AgentStop` / past_chats) is **fully
preserved**. Net change: C merges spawn + adds `set_budget`; D is folded out of
the persistent mode; A/B/E/F unchanged.

### The unified spawn (the heart)

```
spawn(objective, {
  persistent?: <completion condition>,  // omit = single-shot; set = self-continue until the audit on this passes
  detach?:     boolean,                 // false = await in-turn; true = walk away, notify on completion
  scope?:      <permission scope>,      // required when detach && persistent (authorize the unattended pursuit up front)
  allowedTools?: <narrowed tool set>,   // omit = full Neva fork; set = a role-narrowed fork (existing allowedTools)
})
```

- **delegation** = `spawn(obj)` — single-shot, await (today's `Agent`).
- **awaited goal** = `spawn(obj, { persistent })` — "keep going until done, I'll
  watch" (e.g. refactor-until-green).
- **detached goal** = `spawn(obj, { persistent, detach, scope })` — "pursue this,
  notify me" (e.g. monitor competitor X).
- **team** = a persistent run's `spawn`ed children, grouped by its run id.

`runs_status` = await / poll / list spawned runs, including detached ones still
running and the whole team subtree. **Naming** (`spawn` vs keeping `Agent` /
`set_goal` as aliases) is a reversible surface choice; the *underlying operation
is one*. The recommendation is to expose it honestly as one parameterized
`spawn` so two names cannot re-imply two mechanisms.

### Driving a persistent run (self-management)

A `persistent` run manages its own objective pursuit. Its objective and remaining
budget are **injected into its context each round** (no read tool needed). It
emits only state-transition signals:

- `request_complete()` — "I believe the objective is met" → **triggers the
  completion audit**. It is a *request*, never a fiat (see *self-continuation loop*).
- `report_blocked(reason)` — escalate: a directional decision it must not make
  autonomously, a needed scope expansion, or a planned human checkpoint
  (e.g. "approve before sending").

The other two terminal exits — `budget-exhausted` and `stopped` — are set by the
engine, not by a tool (see *loop*).

### Run-control on existing runs (the grounded delta)

Run-control is **mostly already shipped as model tools**: `AgentStatus`
(`agent_child_run_status`), `AgentSend` (`agent_child_run_send`), and `AgentStop`
(`agent_child_run_stop`) are registered in the catalog and the system prompt
already guides their use (`src/main/agentDelegation.ts:51-52,687,1252,1266`). So
the delta is **small**: one genuinely new tool (`set_budget`) plus *goal
semantics* layered on the existing ones, and generalizing their callable range to
the **owner** of the target run (its ancestor, or the conversation it surfaces in):

| Goal use | maps to | what is new |
|---|---|---|
| cancel a run | `AgentStop` | nothing — terminal `stopped`; dissolves a team subtree |
| steer a run | `AgentSend` | **goal semantics**: a send to a persistent run is an *objective-amendment event* (event-sourced, not a hidden side-channel) |
| resume a paused/blocked run | `AgentSend` | nothing — re-engage after the user resolves it |
| adjust the goal-tree budget | — | **new** `set_budget` |

This is also what lets the **attended conversation** introspect and steer a
detached goal ("how's the monitor going?" / "also watch Y" / "stop watching X").

### Visibility matrix (run-kind × tool — all derived)

| run | A sense | B doc | C spawn | C detached goal | C run-control | D self-mgmt | E ask | F skill |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **foreground turn** (attended, single-shot) | ✓ | ✓ | ✓ | ✓ (attended) | own targets | ✗ (not persistent) | ✓ | ✓ |
| **persistent run** (goal root) | ✓ | ✓ | ✓ | only if attended | own targets | ✓ | ✗ (unattended) | ✓ |
| **executor child** (single-shot, leaf) | ✓ (narrow) | per Principal | restricted / ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |

Every cell is `precondition(Principal, attended, lineage, continuation)`, not a
hard-coded role. (Executors are typically given a narrow profile *without* spawn
to bound depth — a profile choice, not an architectural rule.)

## Design

### Where goal state lives

On the run, not on the conversation. A persistent run carries:

- `objective` (seeded from the conversation at launch — see *Warm start*).
- `status` — the run lifecycle. Transient: `running | paused`. **Four terminal
  exits**, only the first a "success": `complete` (audit passed) · `blocked`
  (needs the user) · `budget-exhausted` (token/time/usage allowance gone) ·
  `stopped` (cancelled by user/parent). Three of four escalate/notify.
- `budget` (optional) — a token/time ceiling **scoped to the whole goal-tree**
  (the root run + its entire child subtree share one ceiling), a **fold over the
  subtree's usage events**. Absent = unbounded (the common mid-chat case; cf.
  Codex's client path ships no budget).

No new `conversation.goal.*` events: the run *is* the goal. Pause is a parked run;
resume reuses the existing run-resume (`agent_child_run_send`) path. Goal state is
event-sourced over the run ledger — no sibling store, no goal table.

### The self-continuation loop (the one new behavior — four exits)

```
run a round toward the objective
on round boundary:
  account goal-tree usage (fold) → over budget?            → budget-exhausted, stop & notify
  usage-limit error?                                        → budget-exhausted, stop & notify
  user/parent cancelled?                                    → stopped, stop
  user paused?                                              → paused, park
  completion audit (on request_complete): every requirement proven? → complete, stop & notify
  report_blocked, or same blocker N rounds?                 → blocked, stop & notify
  otherwise                                                 → compact context, continue (next round)
```

- **Completion audit.** The terminal `complete` decision is gated by a
  requirement-by-requirement audit that refuses "looks done." Port Codex's
  `continuation.md` discipline verbatim as the audit/continuation instruction
  content (the load-bearing anti-early-exit text). Injected each continuation
  round; it is *content* (skill-shaped, overridable), executed by the run.
- **Context discipline.** The first round is **warm-started** from the originating
  conversation (the chat *is* the briefing). Later rounds work from current
  evidence (worktree / outline / external state), not stale chat memory, with
  compaction between rounds. (Reuse existing run compaction.)
- An **open-ended** objective (e.g. "keep monitoring X") never satisfies its
  audit by design — it exits only via `budget-exhausted` or `stopped`, surfacing
  milestones as it goes. `complete` is not the only terminal.

### Scope: inherits down lineage; only expansion escalates

A child runs **within the scope its parent already holds** — so an unattended
persistent run may `spawn` sub-work freely *inside its scope* (no fresh
authorization). Needing **more** authority is the only thing that escalates:
the run `report_blocked`s and the user re-authorizes in the conversation. This
resolves "can a goal spawn a sub-goal?" — yes, while it stays within scope.

### `ask` is strictly the attended turn

`attended` is **exactly** the foreground interactive conversation turn. Any
spawned run (awaited *or* detached) is never `attended` → never calls
`ask_user_question` → it self-resolves reversible locals and `report_blocked`s on
directional ones.

- **await** path: the parent (e.g. Neva) is still `attended` and may **relay** —
  surface the child's block as its own `ask_user_question`, get the answer,
  `resume`/re-`spawn`. Asking always goes *through* the attended turn.
- **detach** path: no attended ancestor → the block escalates asynchronously; the
  user resolves it in a fresh conversation turn.

This keeps the *subagents-never-ask-user* rule intact: questions flow only through
the conversation turn; spawned runs block-and-escalate, they never ask inline.

### Launching: skill + command + commit-as-authorization

Two invocation surfaces over **one core command** (A4):

- **User:** `/goal <objective>` (and a one-tap "make this a goal" on the current
  thread). Primary entry.
- **Agent:** `spawn(…, { persistent, detach })`. Starting a **detached** pursuit
  is a *volitional commitment*: the act of authorizing its `scope` **is** the
  ask-gate, and happens in the attended turn — the model may *propose* ("pursue
  this as a goal?"), the user *commits* + authorizes scope. (Matches "epistemic
  curation autonomous, volitional commitment escalates," and Codex's "create a
  goal only when explicitly requested.")

A **launching skill** carries the *when/how*: recognize a long autonomous task,
shape the conversation into an objective, decide whether a budget is warranted,
and when to propose vs act. The skill teaches; it does not run the loop.

### Entry: DM-emergent, mid-conversation

The dominant path is a mid-DM hand-off: a `single-shot`/attended thread spins off
a `persistent`/detached run. Run/Conversation are stable; the pursuing agent is
the one already in the DM (continuity — no hand-off to a stranger). It detaches to
the background; the user may keep watching, steer, pause, or leave.

### Delivery and UI (reuse Channel)

A running goal in a DM thread reuses Channel's delivery discipline:

- **Whole-utterance + result-first fold** for milestones/results in the thread;
  the detailed per-round process lives in the run's activity drill-in.
- **Steering** mid-run = `steer` (append an objective-amendment event); a user
  message during pursuit either amends the objective or is plain chat.
- **Backgrounded** goals surface in the task panel (= the projection of a
  persistent run) and raise badge-only attention on a terminal exit; the
  notification reuses the existing "background run completed → notify idle parent"
  path. All three escalating exits (blocked / budget-exhausted / stopped) notify,
  not just `complete`.

### Goal-as-team (Feature B)

When the objective is large, the persistent run is the **referee**:

```
persistent run (referee: holds objective + goal-tree budget + audit + continue/stop)
  ├─ spawn narrowed Neva forks (per-role allowedTools) = executor team (within scope)
  ├─ executors do work single-shot, do NOT self-audit, report back over the existing bus
  ├─ referee integrates results, runs the completion audit
  └─ audit passes → cancel/finish the team (existing stop-scope) → notify; team dissolves
```

- **Team membership is derived**, not stored: each executor child run is tagged
  with the persistent run's id; the team = `child runs WHERE rootRunId = G`.
  Dissolution is free (stop in-flight children; ledgers self-clean). No team
  object, no roster, no TeamDelete dance.
- **Referee independence is a spectrum**, scaled to stakes:
  `self-audit (small) → referee-audits-executors (default) → dedicated fresh judge
  (high-stakes)`. Do not force a team for small goals — Feature A's single agent
  is both executor and referee.
- **Seed roles** (the only authored content): the referee is the persistent run
  itself (full Neva); `researcher`, `implementer`, `verifier` are **named
  `allowedTools` presets for Neva forks** (e.g. researcher = read/web only),
  not separate agent definitions.

### Reuse map

| Need | Existing piece | New? |
|---|---|---|
| Spawn a pursuit / executors | delegation `fork` child runs (`Agent`, fork-only) | reuse (generalized to `spawn`) |
| Role-shaped executors | Neva forks narrowed via `restrictAgentDefinitionTools` + `allowedTools` | reuse (one-Neva) |
| Observe spawned runs | `AgentStatus` (`agent_child_run_status`) | reuse (→ `runs_status`) |
| Cancel / steer / resume a run | `AgentStop` / `AgentSend` (already model tools) | reuse (+ goal semantics on `steer`) |
| Completion → notify originating thread | "background run completed → notify idle parent" | reuse |
| Budget accounting | fold over the goal-tree usage events | reuse (new fold) |
| Milestone/steer/peek delivery | Channel whole-utterance + result-first + drill-in | reuse |
| Commit escalation | permission ask-gate (= scope authorization) | reuse |
| Goal state | run status + run-resident objective/budget | mostly reuse |
| **`persistent` continuation (self-continue until audit)** | — | **new (the one atom)** |
| Completion/continuation audit text | port Codex `continuation.md` | new content |
| Launching skill (when/how) | Skill primitive | new content |
| `set_budget` | — | new (small) |

The genuinely new mechanism is a single continuation mode; the rest is content +
composition of existing primitives.

## Scenario analysis

Eleven scenarios spanning the axes, run through the model. They **could not
overturn** the core (one spawn / objective universal / `persistent` the only new
atom / one filter), but they **forced six patches**, all downstream of
`persistent` or of the existing run lifecycle — no new atom.

| # | Scenario | continuation | disposition | attended | forced refinement |
|---|---|---|---|---|---|
| 1 | "compare libs A/B/C" | single-shot | await | ✓ | in-turn fan-out (team-in-a-turn) |
| 2 | "monitor competitor X" | persistent | detach | ✗ | never `complete`; exits via budget/stop (G2) |
| 3 | "refactor to green, I'll watch" | persistent | **await** | watching | awaited persistent; block surfaces in conversation |
| 4 | "migrate 200 call sites, ping me" | persistent | detach | ✗ | bounded long pursuit; audit = all green |
| 5 | set a goal, then keep chatting | — | concurrent | turn ✓ / goal ✗ | conversation introspects via `runs_status` |
| 6 | "also watch Y" / "stop watching X" | — | on a *running* run | ✓ | **G1 run-control (cancel/steer)** |
| 7 | mid-migration ambiguous design fork | persistent | detach | ✗ | **block→resume; cannot ask (E-strict)** |
| 8 | executor needs to sub-spawn | persistent | — | ✗ | **G3 scope inherits / G4 budget per-tree** |
| 9 | "every morning, summarize" | single-shot ×N | detach | ✗ | **G5 schedule = trigger/provenance** |
| 10 | "draft, but confirm before sending" | persistent | detach | ✗ | block doubles as human-in-loop checkpoint |
| 11 | an executor crashes | — | — | ✗ | referee handles via `runs_status`; no new tool |

The six patches:

- **G1 — C needs run-control over *existing* runs**, not just spawn + observe.
  Grounded: `agent_child_run_stop`/`_send`/`_status` already exist; expose
  cancel/steer/resume as model tools + add `set_budget`.
- **G2 — four terminal exits**, not just `complete`: `complete` · `blocked` ·
  `budget-exhausted` · `stopped`; three escalate.
- **G3 — scope inherits down lineage; only expansion escalates** (lets an
  unattended persistent run sub-spawn within scope).
- **G4 — budget is per goal-tree**, consumed by the whole subtree, not per-run.
- **G5 — trigger (who lit the fuse) is provenance**, not a tool-gating fact;
  schedule lives outside the run model as a standing trigger source.
- **G6 — `steer` = append an objective-amendment event** to the run (not a hidden
  side-channel à la Codex), consistent with "objective is an event fold."

Plus the pinned decision: **`ask` is strictly the attended conversation turn**;
spawned runs block-and-escalate; the attended parent relays in the `await` case.

## Open questions

Directional calls for PM ratification (recommendation given):

1. **`ask` reach.** Strict (only the attended conversation turn asks; spawned runs
   block-and-escalate) vs bubble (a question rises to the nearest attended
   ancestor). **Recommend strict** — preserves *subagents-never-ask-user* and is
   simpler.
2. **Run-control exposure.** Expose `cancel`/`steer`/`resume` as model tools *and*
   UI actions, or UI only? **Recommend both** (Neva can act on "stop watching X").
   The `steer` semantics — amend the objective vs add a constraint — must be
   pinned.
3. **Budget.** Ship budget-optional (unbounded default, mid-chat case) and what is
   the **over-budget default action** — `blocked` awaiting extension, or deliver
   partial? **Recommend optional + block-and-ask-to-extend.**
4. **Team topology.** Star (delegation; executors mutually invisible, use
   consultation) vs mesh (a goal-scoped ephemeral Channel; executors `@` each
   other). **Recommend star first**; mesh deferred.
5. **Continuation granularity (impl of `persistent`).** (A) one long run appending
   rounds to its own ledger vs (B) a new run per round linked by root id.
   **Recommend B** (each round bounded, independently compactable/observable;
   matches Codex's fresh-task-per-turn). Shapes the ledger model.
6. **`background` kind retirement scope.** Spec-reframe now, or collapse the
   derivation? **Recommend reframe now**, derivation cleanup incremental and off
   this plan's critical path.
7. **Composer placement** of `/goal` and the one-tap affordance — settle at build
   time (reversible).

## Risks

- **Protocol surface (A4/A10).** Touches `src/core/commands.ts` /
  `src/core/types.ts` (the `spawn` persistent/detach/scope params, run terminal
  status + objective/budget fields, `set_budget`, and `AgentSend`'s
  objective-amendment semantics — `AgentStop`/`AgentSend`/`AgentStatus` already
  exist as tools). Land the interface as a coordinated, **interface-first** step
  before building the loop.
- **Autonomy safety.** A self-continuing, budget-spending run is the highest-blast
  capability in the agent surface. The commit-as-scope-authorization gate, the
  four-exit stops, and `ask`-strict are load-bearing; the completion audit must be
  the gate on `complete`, never the model's unaided judgment.
- **Context blow-up on long pursuits.** Mitigated by per-round compaction +
  evidence-first later rounds; verify with a long-running goal in the dev app.
- **Concept creep.** Keep goal as a continuation mode + skill; resist re-inflating
  it into a standing object, a new primitive, or a second spawn tool.

## Collision self-check

- `gh pr list` (2026-06-24): only #332 (codex-2, native focus / agent transcript
  polish) is open — no overlap with runs/delegation/commands.
- `docs/TASKS.md`: no persistent-run / goal-driver item in flight. "goal" mentions
  are the conversation `title/goal` field and goal-oriented skills — unrelated.
- Files this plan will touch (runtime/delegation/commands/skills/renderer) are not
  claimed by an open PR. Protocol-surface files (`commands.ts`/`types.ts`) need the
  interface-first coordination step above.

Result: **no overlap.**

## Build checklist

### Feature A — DM goal (single agent)

- [ ] Interface-first: generalize `Agent`→`spawn` (`persistent`/`detach`/`scope`/
      `allowedTools` params), run terminal status (`complete`/`blocked`/
      `budget-exhausted`/`stopped`) + objective/budget fields, `set_budget`, and
      `AgentSend`'s objective-amendment semantics (`commands.ts`/`types.ts`),
      coordinated. (`AgentStop`/`AgentSend`/`AgentStatus` already exist.)
- [ ] `persistent` continuation in the runtime: the four-exit loop, goal-tree
      budget fold, per-round compaction.
- [ ] Port `continuation.md` as the audit/continuation instruction content.
- [ ] Warm start from the originating conversation; evidence-first later rounds.
- [ ] `createAgentTools` (via `buildTools`) → precondition filter over (Principal,
      attended, lineage, continuation); `ask_user_question` gated to `attended`.
- [ ] `/goal` command + one-tap "make this a goal"; spawn-with-commit = scope
      authorization in the attended turn; D-tools `request_complete`/`report_blocked`.
- [ ] Launching skill (when/how) authored.
- [ ] Delivery/UI: reuse Channel whole-utterance + result-first fold + drill-in;
      task-panel projection; all four terminal exits notify; steering via `steer`.
- [ ] Verify: set a goal mid-DM in the dev app; confirm it self-continues, audits,
      respects budget/pause/stop/block, and notifies. (light + dark for new UI.)

### Feature B — Goal-as-team (referee + executors)

- [ ] Persistent run as referee: spawn narrowed Neva forks as executors;
      integrate; audit.
- [ ] Derived team: tag executor children with the root run id; team view =
      grouping; dissolution via existing stop-scope on completion.
- [ ] Scope inheritance down the subtree; goal-tree budget shared.
- [ ] Referee-independence spectrum (self → referee → dedicated judge), scaled to
      stakes; default referee-audits-executors.
- [ ] Seed fork profiles (`allowedTools` presets) authored: `researcher` /
      `implementer` / `verifier`; referee = the persistent run (full Neva).
- [ ] Verify: a large goal fans out a role-diverse team, integrates, audits, and
      dissolves the team on completion.

### On ship

- [ ] Fold *The model* + *Tool surface* (Run = Principal+objective+lineage+
      continuation; `persistent` the one atom; one `spawn`; precondition-filtered
      tools; goal/team as projections) into `docs/spec/agent-architecture.md`;
      note the `background`-kind reframe.
- [ ] Mark the `docs/TASKS.md` item `done`; move this plan to `docs/plans/archive/`.
