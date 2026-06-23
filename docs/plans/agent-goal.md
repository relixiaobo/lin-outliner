# Agent Goal — autonomous self-continuing runs (and ephemeral executor teams)

## Goal

Let a user (mid-conversation) hand a long-running objective to an agent and have
it pursue that objective autonomously across many turns until the objective is
**verified** complete — not until the model decides to stop. When the objective
is large, the pursuing agent assembles a **temporary, role-diverse team** of
helper runs and dissolves it on completion.

Concretely:

- A user chatting in a DM can say "now go do X until it's done"; the agent the
  user is already talking to (today: Neva) keeps working in the background,
  re-engaging itself turn after turn, and notifies back when the objective is met,
  blocked, or out of budget.
- The same mechanism, when the objective warrants it, spawns specialized child
  runs (researcher / implementer / verifier) that do the work while the pursuing
  agent acts as the **referee** that integrates results and audits completion.

The design deliberately reuses what already exists (delegation child runs,
completion notification, run usage accounting, Channel delivery, the permission
gate) and isolates the one genuinely new behavior: **a run that self-continues
until a completion audit passes.**

## Non-goals

- **No new top-level primitive.** Goal is not an 8th primitive and not a `Skill`.
  It is a *run behavior* + a launching skill + run-resident state. (See *The model*
  for why a skill cannot supply the loop.)
- **No standing/persistent team object.** A team is the set of a goal run's child
  runs, grouped and dissolved by the goal — never a durable roster like a Channel.
- **No large built-in role library in this plan.** The multi-role *mechanism*
  already exists (`fresh` child runs keyed by `agent_type`). A minimal seed set of
  roles is the only authored content here; a rich library is follow-up.
- **No global retirement of the `background` run kind in one shot.** The framing
  (`background` ≡ "a run pursuing a goal") is recorded as the target model; the
  actual derivation cleanup lands incrementally and is not a precondition.
- **No schedule-driver work.** Time-triggered runs stay a separate trigger flavor;
  this plan is the completion-driven (goal) flavor only.
- **No silent autonomy escalation.** The model may *propose* a goal; *committing*
  one (spending budget on autonomous action) routes through the existing ask-gate.

## Shape

**(b) A set of independent complete features**, ordered by genuine dependency.
Each is independently shippable and verifiable:

- **Feature A — DM goal (single agent).** A user sets a goal in a DM; the pursuing
  agent self-continues to a verified completion within an optional budget. Useful
  alone; it is the most common case (mid-conversation hand-off).
- **Feature B — Goal-as-team (referee + executors).** When a goal is large, the
  pursuing run spawns role-diverse `fresh` child runs and acts as referee. Builds
  on A + existing delegation.

(Feature A is the foundation per A7, but is itself a complete feature, not a
scaffold for B.)

## The model

The framing the whole design rests on. It reduces concepts; it does not add a
primitive.

### Run × Driver

Every execution is a **Run** (one episode; a Run contains one or more *turns*,
each a prompt→reply cycle, each containing tool `step`s). What *produces* a Run is
its **driver**:

- `interactive` — a user (or another principal) addressed a principal. Foreground.
- `goal` — a self-continuing run pursuing an objective. Background.
- `schedule` — a clock fired. Background. (out of scope here.)

"Foreground vs background" is **derived** from the driver (is the live user the
producer?), not a stored axis. `turn`, `Task`, and the `background` kind all fall
out of (driver × lineage); none is a separate concept.

### A goal is a self-continuing background run, not a skill

A `Skill` is reusable instruction *content* injected into a turn. It can tell a
model "do not stop early," but it cannot re-invoke the model after a turn ends —
and the whole point of "keep going until done" is that the loop lives **outside a
single turn**. So a goal cannot *be* a skill. The loop lives **inside a run**: a
goal run, on reaching what would be a turn boundary, runs a completion audit; if
not done (and budget/health allow), it compacts and continues; otherwise it
terminates. The skill's job is only *when* and *how* to launch one.

This dissolves the earlier "Driver layer" idea: there is no separate machinery
above runs that emits them. There is one new **run behavior** (self-continue-until-
audit) plus a launching skill plus the existing notification path.

### Roles via existing delegation

Child runs already distinguish roles (`src/main/agentDelegation.ts`):

- `fork` (no `agent_type`) — the same agent continues with the conversation
  context; inherits the parent's identity and memory owner.
- `fresh` (`agent_type` set) — a specialized agent definition with its own
  identity, model, skills, and memory line.

The executor team is exactly **a goal run's `fresh` child runs of varied
`agent_type`**. The mechanism exists; only a seed role set is authored here.

## Design

### Where goal state lives

On the run, not on the conversation. A goal run carries:

- `objective` (string; seeded from the conversation at launch — see *Warm start*).
- `status` — the run's lifecycle, with `complete` **gated by the completion
  audit**: `running | paused | blocked | budget_limited | usage_limited | complete`.
- `budget` (optional) — a token/time ceiling; consumption is a **fold over the
  run's own usage events** (the run ledger already records token usage). Absent =
  unbounded (the common mid-chat case; cf. Codex's client path ships no budget).

No new `conversation.goal.*` events are required: the run *is* the goal. Pause is a
parked run; resume reuses the existing run-resume (`AgentSend`) path. This keeps
the goal first-class and persisted (its own event-sourced ledger) without adding a
sibling store.

### The self-continuation loop (the one new behavior)

```
run a turn toward the objective
on turn boundary:
  account usage (fold) → over budget?           → status = budget_limited, stop
  usage-limit error?                            → status = usage_limited, stop
  user paused / cleared?                         → status = paused, stop
  completion audit: is every requirement proven? → status = complete, stop & notify
  blocked audit: same blocker N consecutive turns? → status = blocked, stop & notify
  otherwise                                      → compact context, continue (next turn)
```

- **Completion audit.** The terminal `complete` decision is gated by a
  requirement-by-requirement audit that refuses "looks done." Port Codex's
  `continuation.md` discipline verbatim as the audit/continuation instruction
  content (it is the load-bearing anti-early-exit text). It is injected each
  continuation turn; it is *content* (skill-shaped, overridable), executed by the
  run.
- **Context discipline.** First turn is **warm-started** from the originating
  conversation (the chat *is* the briefing). Later turns work from current evidence
  (worktree / outline / external state), not stale chat memory, with compaction
  between turns. (Reuse the existing run compaction.)

### Launching: skill + command + escalation

Two invocation surfaces over **one core command** (A4):

- **User:** `/goal <objective>` (and a one-tap "make this a goal" on the current
  thread). Primary entry.
- **Agent:** a `set_goal` / `update_goal` tool. `update_goal(complete|blocked)` is
  used by the pursuing run within the loop. `set_goal` (starting a new pursuit) is
  a **volitional commitment** and therefore routes through the ask-gate — the model
  may *propose* ("pursue this as a goal?"), the user *commits*. (Matches the
  architecture's "epistemic curation autonomous, volitional commitment escalates,"
  and Codex's own "create a goal only when explicitly requested" rule.)

A **launching skill** carries the *when/how*: recognize a long autonomous task,
shape the conversation into an objective, decide whether a budget is warranted,
and when to propose vs act. The skill teaches; it does not run the loop.

### Entry: DM-emergent, mid-conversation

The dominant path is a mid-DM hand-off: an `interactive` thread transitions to a
`goal` driver. Run/Conversation are stable; only the driver flips. The first goal
turn is the user's "go" message. The pursuing agent is the one already in the DM
(continuity — no hand-off to a stranger). It detaches to the background; the user
may keep watching, steer, pause, or leave.

### Delivery and UI (reuse Channel)

A running goal in a DM thread reuses Channel's delivery discipline:

- **Whole-utterance + result-first fold** for milestones/results in the thread;
  the detailed per-turn process lives in the run's activity drill-in.
- **Steering** mid-run reuses `objective_updated`-style injection: a user message
  during pursuit either adjusts the objective or is plain chat.
- **Backgrounded** goals surface in the task panel (= the projection of an active
  goal run) and raise badge-only attention on completion; the terminal notification
  reuses the existing "background run completed → notify idle parent" path.

### Goal-as-team (Feature B)

When the objective is large, the goal run is the **referee**:

```
goal run (referee: holds objective + budget + audit + continue/stop)
  ├─ decide_next → spawn fresh child runs (varied agent_type) = executor team
  ├─ executors do work, do NOT self-audit, report back over the existing bus
  ├─ referee integrates results, runs the completion audit
  └─ audit passes → terminate team (existing stop-scope) → notify; team dissolves
```

- **Team membership is derived**, not stored: tag each executor child run with the
  goal run id; the team = `child runs WHERE goalRunId = G`. Dissolution is free
  (stop the in-flight children; ledgers self-clean). No team object, no roster, no
  TeamDelete dance.
- **Referee independence is a spectrum**, scaled to stakes:
  `self-audit (small) → referee-audits-executors (default) → dedicated fresh judge
  (high-stakes)`. Do not force a team for small goals — Feature A's single agent is
  both executor and referee for those.
- **Seed roles** (the only authored content): `referee` = Neva (existing);
  `researcher`, `implementer`, `verifier` as `fresh` agent definitions. Mechanism
  reused; roles authored.

### Reuse map

| Need | Existing piece | New? |
|---|---|---|
| Spawn a background pursuit / executors | delegation `fork`/`fresh` child runs | reuse |
| Multi-role executors | `agent_type` → agent definition, own memory line | reuse |
| Completion → notify originating thread | "background run completed → notify idle parent" | reuse |
| Budget accounting | fold over the run's usage events | reuse (new fold) |
| Milestone/steer/peek delivery | Channel whole-utterance + result-first + drill-in | reuse |
| Commit escalation | permission ask-gate | reuse |
| Goal state | run status + run-resident objective/budget | mostly reuse |
| **Self-continue-until-audit run behavior** | — | **new** |
| Completion/continuation audit text | port Codex `continuation.md` | new content |
| Launching skill (when/how) | Skill primitive | new content |

The genuinely new mechanism is a single run behavior; the rest is content +
composition of existing primitives.

## Open questions

1. **Continuation granularity.** (A) one long goal run that appends turns to its
   own ledger, vs (B) a new run per continuation round linked by goal id.
   Recommendation: **B as default** (each round bounded, independently compactable
   and observable; matches Codex's fresh-task-per-turn), with delegation resume as
   the (A) special case. Needs ratification — it shapes the ledger model.
2. **Proactivity threshold.** How eagerly may the agent *propose* a goal? Default:
   propose freely, commit only via ask-gate.
3. **Budget defaults.** Ship budget-optional (unbounded default) for the mid-chat
   case, or always require a ceiling? Recommendation: optional.
4. **Team topology.** Star (delegation; executors mutually invisible, use
   consultation) vs mesh (a goal-scoped ephemeral Channel; executors `@` each
   other). Recommendation: **star first**; mesh deferred.
5. **`background` kind retirement scope.** Reframe-only in spec now, or actually
   collapse the derivation? Recommendation: spec-reframe now, derivation cleanup
   incremental and out of this plan's critical path.
6. **Where `/goal` and the one-tap affordance live in the composer** — relates to
   existing slash/command surfaces; settle at build time (reversible).

## Risks

- **Protocol surface (A4/A10).** Touches `src/core/commands.ts` and
  `src/core/types.ts` (the `set_goal`/`update_goal` command + run status/objective
  fields + the goal-run trigger). Land the interface as a coordinated,
  interface-first step before building the loop on top.
- **Autonomy safety.** A self-continuing, budget-spending run is the highest-blast
  capability in the agent surface. The commit-escalation gate and the budget/
  usage/blocked stops are load-bearing; the completion audit must be the gate on
  `complete`, never the model's unaided judgment.
- **Context blow-up on long pursuits.** Mitigated by per-turn compaction +
  evidence-first later turns; verify with a long-running goal in the dev app.
- **Concept creep.** Keep goal as a run behavior + skill; resist re-inflating it
  into a standing object or a new primitive.

## Collision self-check

- `gh pr list`: open PRs #319 / #320 are Dream memory precision (cc-2) — no
  overlap with runs/delegation/commands.
- `docs/TASKS.md`: no goal-driver / self-continuing-run item in flight. "goal"
  mentions are the conversation `title/goal` field and goal-oriented skills —
  unrelated.
- Files this plan will touch (runtime/delegation/commands/skills/renderer) are not
  claimed by an open PR. Protocol-surface files (`commands.ts`/`types.ts`) need the
  interface-first coordination step above.

Result: **no overlap.**

## Build checklist

### Feature A — DM goal (single agent)

- [ ] Interface-first: `set_goal`/`update_goal` command + run status/objective/
      budget fields + the goal trigger on a Run (`commands.ts`/`types.ts`),
      coordinated.
- [ ] Self-continue-until-audit run behavior in the runtime (loop, stops, budget
      fold).
- [ ] Port `continuation.md` as the audit/continuation instruction content.
- [ ] Warm start from the originating conversation; per-turn compaction; evidence-
      first later turns.
- [ ] `/goal` command + one-tap "make this a goal"; `set_goal` agent tool with
      commit-escalation; `update_goal(complete|blocked)`.
- [ ] Launching skill (when/how) authored.
- [ ] Delivery/UI: reuse Channel whole-utterance + result-first fold + drill-in;
      task-panel projection of the active goal; terminal notification; steering.
- [ ] Verify: set a goal mid-DM in the dev app; confirm it self-continues, audits,
      respects budget/pause/stop, and notifies. (light + dark for any new UI.)

### Feature B — Goal-as-team (referee + executors)

- [ ] Goal run as referee: `decide_next` → spawn `fresh` executor child runs;
      integrate; audit.
- [ ] Derived team: tag executor children with goal-run id; team view = grouping;
      dissolution via existing stop-scope on completion.
- [ ] Referee-independence spectrum (self → referee → dedicated judge), scaled to
      stakes; default referee-audits-executors.
- [ ] Seed roles authored: `researcher`, `implementer`, `verifier` (referee =
      Neva).
- [ ] Verify: a large goal fans out a role-diverse team, integrates, audits, and
      dissolves the team on completion.

### On ship

- [ ] Fold *The model* (Run × Driver; goal = self-continuing run; team = derived)
      into `docs/spec/agent-architecture.md`; note `background`-kind reframe.
- [ ] Mark the `docs/TASKS.md` item `done`; move this plan to `docs/plans/archive/`.
