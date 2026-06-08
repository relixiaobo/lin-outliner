---
status: draft
priority: P2
owner: relixiaobo
created: 2026-06-08
updated: 2026-06-08
---

# Agent / Task Model — dissolve "subagent", make the primary agent first-class

**Follow-on from [[agent-authoring]] (PR #167).** That PR unified the subagent
system prompt: a fresh subagent now reuses the main agent's shared-core prompt
instead of a bespoke minimal one, and built-in `general` collapsed to an empty
body (= "the base agent, headless"). Pulling that thread to its end exposes that
**"subagent" is no longer a real agent *type*** — and a pile of the agent
subsystem is modeled around a distinction that no longer exists. This plan
re-grounds the architecture on two clean concepts and reprocesses every part the
old conflation left messy.

This is a **plan for review** (main + PM). It changes protocol/shared surface, so
it is plan-track and interface-first; nothing is built before ratification.

## The reframe (the whole point)

The word "subagent" conflated two orthogonal things. Separate them:

| Concept | Is | Set / values |
|---|---|---|
| **Agent** = a *profile / persona* | an identity + its **capability/budget**: system prompt, `model`, `effort`, `tools`/`disallowedTools`, `permissionMode`, **`maxTurns`**, `skills`. Answers **who runs and how capable**. | { the **primary** agent, user-defined agents } |
| **Task** = a *delegated run* | the **delegation**: brief(prompt) + context **mode** + sync/async disposition + name. Answers **what to do, and does the caller wait**. | every `Agent`-tool invocation |

So what gets "spawned" is **not another agent** — it is the (same or a chosen)
agent **running a task**. The boundary is **capability vs delegation**: the runner's
budget lives on the *Agent*, the per-call choices live on the *Task*.

A Task carries only:

- **runner**: which Agent profile executes — default = the **primary** agent; or a
  named user agent (today's `subagent_type`).
- **context mode**: `fresh` (clean slate) or `fork` (inherit the caller's prepared
  context). Today's "omit `subagent_type` ⇒ fork".
- **disposition — sync or async**: does the **caller's message stream block** on
  this run? Foreground (default) `await`s the run and returns the result inline
  (`agentSubagents.ts:694`); `run_in_background` returns a handle immediately
  (`:686-691`) and the result arrives later via notify / `AgentStatus`. A
  per-delegation, caller-side choice — hence a Task property, not a profile one.
- **name / description**: for addressing + tracking the run.
- **memory owner** (derived, not a free param): `fresh` → the runner; `fork` → the
  caller (`resolveSubagentMemoryOwner`, `agentSubagentIdentity.ts:11-19`).
- → **produces**: an isolated sidechain transcript + a returned result.

**NOT on the Task — these are the Agent (runner) profile's, set once:** `model`,
`effort`, `tools` / `disallowedTools`, `permissionMode`, **`maxTurns`**, `skills`.
The Task names *which* runner, never restates *how capable* it is. (Today the
`Agent` tool also accepts per-call `model`/`effort` overrides,
`agentSubagents.ts:635-636` — a convenience, not part of the Task's essence;
**decided: dropped**, capability is profile-only.)

```
   capability / budget                 delegation (per call)
   ── AGENT (profile) ──               ── TASK (run) ──
   persona, model, effort,      runs   runner (which profile),
   tools, permissionMode,  ◄────────   mode (fresh|fork),
   maxTurns, skills                    brief, sync|async, name
                                       └► memory owner (derived), transcript, result
```

"Subagent" as a distinct *kind of agent* dissolves into "an agent running a task."

## North star — pre-launch, go cleanest

We have not launched ([[no-backward-compat-pre-launch]]), so we take the
**maximally clean cutover**, not a staged / risk-hedged one: no aliases, no
surface-only half-rename, no per-task duplication of profile config.

**The clean target: there is no special "main agent."** One uniform concept — an
**Agent profile** = a *participant* (persona + capability; a built-in default +
user-defined) — that shows up in **three run-shapes**:

- in a **DM**: a 1:1 interactive conversation with the user. Today's "main chat"
  is just the **default DM**, with the built-in default agent.
- in a **Channel**: a multi-agent interactive conversation (several profiles + the
  user).
- as a **Task**: a headless delegated run (`fresh|fork` × `sync|async`) that
  reports a result back into the conversation that spawned it.

**The foreground is a *conversation*, switched at the top** (the chat-app idiom): a
list of **DMs** and **Channels** — the user switches *which conversation they are
in*, NOT "which profile is active". "primary/main" = the default DM's agent;
"general" = the default agent run as a fresh task.

This collapses { main agent, general, user agents } into ONE concept (**profiles /
participants**) and { foreground, subagent } into *how a participant runs* (DM /
Channel / Task) — dissolving the three seams the bounded version left (the
runner×mode coupling, per-task capability, the split config surface).

**Decided (clean cutover — resolves the mechanical Open Questions):**

- Capability (`model`, `effort`, `tools`, `permissionMode`, `maxTurns`, `skills`)
  lives **only** on the profile — **drop** the `Agent` tool's per-call
  `model`/`effort` overrides (was Q6).
- **Full** rename subagent → task across types, files, storage, and the model-facing
  contract — not surface-only (was Q2 + Q5).
- **Hard-remove** `general` and the `general-purpose` alias — no back-compat (Q3).
- `fork` = a context mode, never a profile.
- The built-in default profile's persona is **user-editable** like any other
  profile (uniformity), with reset-to-default; still **never** model-writable —
  authoring stays user-driven ([[agent-authoring]]) (was Q1).
- **Config: Option A (locked).** A profile owns its *entire* config (persona +
  `model` + `permissionMode` + tools). The **Providers** pane becomes
  credentials-only (model picking moves onto the profile); permission is
  per-profile. No account-wide "active model" separate from the profile (was Q-config).

**Build scope of THIS plan vs follow-on:** ship the **DM** foreground (1:1 — the
reframed current chat) + the full Agent/Task cleanup + Option-A config. **Channels
(multi-agent) are in the target model but built as a separate follow-on plan**
([[agent-channels]]); this plan only keeps the types/model **channel-ready** (a
conversation is `DM | Channel`; a participant set; an agent-addresses-agent seam) —
it does not build multi-agent turn-taking, mentions, or cross-agent messaging.

## Goal

Reprocess the agent subsystem so the code, the data model, and the UX all express
**Agent (profile) + Task (run)**, and remove the artifacts of "subagent-as-a-type":

1. the **primary** (foreground) agent becomes a **first-class profile** with a
   name + persona, listed in Agent Profiles;
2. the default `fresh` task runs the **primary** agent's persona — **`general`
   retires** as a separate built-in;
3. **`fork`** is modeled purely as a task **context mode** (memory → caller), not
   a pseudo-`AgentDefinition`;
4. **terminology** across code + UX renames subagent → task where it denotes the
   *run* (keep "agent" where it denotes the *profile*);
5. the roster (Agent Profiles) = exactly **{ primary } ∪ { user agents }**.

## Non-goals

- **Not** changing the execution engine (pi-agent-core `Agent` loop, isolation
  tiers, sidechain transcript storage) beyond what the identity/rename require.
- **Channels (multi-agent foreground) are in the target *model* but built later**
  ([[agent-channels]], a separate follow-on plan). This plan ships only the **DM**
  foreground and keeps the types channel-ready — no multi-agent turn-taking,
  mentions, or agent↔agent messaging here.
- **Not** changing memory extraction / dream semantics — only clarifying ownership
  wording under the Task framing.
- **Not** a visual redesign of Agent Profiles beyond "the primary agent appears as
  a profile" (it reuses the [[agent-authoring]] editor).
- Per [[no-backward-compat-pre-launch]]: cut over directly, no aliases/migration
  unless an Open Question keeps one deliberately.

## Current state (the mess — code-grounded)

- **Primary agent** is not a profile: its prompt is `LIN_AGENT_SYSTEM_PROMPT`
  (`agentSystemPrompt.ts`), seeded at `agentRuntime.ts:5150/5288/5638`. It has no
  `AgentDefinition`, no entry in the roster, and an implicit identity. Post-#167
  the prompt is already split by `audience` ('shared' vs 'main'), which is the
  hook this plan builds on.
- **`general`** (`createGeneralAgentDefinition`, `agentSubagents.ts`) is, post-#167,
  an **empty-body** built-in = "base agent, fresh". It is used as: the default
  fresh type + `general-purpose` alias (`:1282`), the skill default
  (`resolveSkillSubagentType :1077`), the unknown-type fallback (`:1064-1073`), and
  the sole roster seed (`ensureLoaded :1293`). It is **redundant** with "the
  primary agent run fresh."
- **`fork`** (`createForkAgentDefinition`) is created on demand for
  `contextMode === 'fork'` (`:540,:1066`); memory → caller; never in the roster.
  Correct as a *mode*, but modeled as a throwaway pseudo-`AgentDefinition`.
- **Naming**: tool `Agent` (`AGENT_SUBAGENT_TOOL_NAME`), runs `AgentSubagentRun`,
  param `subagent_type`, `contextMode: 'fresh' | 'fork'`. "subagent" is pervasive
  but the concept is "task".
- **Protocol surface**: `src/core/types.ts` (`AgentDefinition`), `commands.ts`
  (`AGENT_COMMANDS`), and the `Agent` tool schema all encode the old framing.

## Design

### D1 — Name the two concepts in the model
Keep `AgentDefinition` as the **Agent/profile** shape — and it **owns the
capability/budget** (`model`, `effort`, `tools`, `permissionMode`, `maxTurns`,
`skills`). Introduce a **Task** vocab for the *run*: rename `AgentSubagentRun*` →
task-run types on the surface (storage may stay; the rename is about the contract
+ UX). A task carries only `{ runner: agentId, mode: 'fresh' | 'fork', brief,
disposition: sync | async, name? }` — **no capability fields** (they would
duplicate the runner's profile). `maxTurns` in particular is the runner's budget,
never a per-task input.

### D2 — Primary agent as a first-class profile
Promote the foreground agent to an `AgentDefinition` (e.g. `source:'built-in'`,
`name:'tenon'`). Its system prompt = the `audience:'main'` sections (identity +
memory) **+** the shared core — so the main prompt stays byte-equivalent while the
persona becomes a *named, listed* profile. It is the **default runner**.

### D3 — Retire `general`
A `fresh` task with no explicit runner resolves to the **primary** agent. Remove
`general` as a separate built-in; skill-default and unknown-type fallback point at
the primary. **`general`/`general-purpose` are hard-removed** — no model-facing
alias (decided: go cleanest, [[no-backward-compat-pre-launch]]).

### D4 — `fork` is a mode, not a pseudo-agent
Drop `createForkAgentDefinition` as a "definition." A `fork` task inherits the
caller's runner identity + prepared prompt + a fork directive; keep the recursion
guard and the Dream evidence-start marker. Fork never appears in the roster.

### D5 — Terminology rename (subagent → task)
Where the word denotes the *run*: `subagent_type` → `agent` (or `runner`),
`AgentSubagentRun` → task-run, spec/UX copy ("subagent runs" → "task runs",
"启动子智能体" → "运行任务"). Where it denotes the *profile*, keep "agent". The tool
id may stay `Agent`. This is protocol churn → **interface-first PR**.

### D6 — Roster semantics
Agent Profiles = **{ primary } ∪ { user agents }**. The Enabled toggle reads
"allow this profile to run tasks." Document the two non-entries: `fork` (a mode)
and the implicit caller-context.

### Security / safety
The headless task directive (never ask the user, concise result) stays. Authoring
remains **user-driven only** ([[agent-authoring]] Non-goal); the primary persona is
**user-editable** (with reset-to-default) but **never model-writable**.

### Collision self-check (vs in-flight work)

`gh pr list`: **#165 `agent-scheduled-routines`** (cc-2, OPEN) +
**#167 `agent-authoring`** (this clone, ready).

| File / surface | This plan | #165 (Lane B) | Result |
|---|---|---|---|
| `src/core/types.ts` | primary `AgentDefinition` + task-run rename | `NodeType: command`, sys fields | **both touch types.ts** → interface-first, sequence |
| `src/main/agentSubagents.ts` | retire general, fork-as-mode, runner | — | mine |
| `src/main/agentSystemPrompt.ts` | primary persona from `audience` split | — | mine (builds on #167) |
| `src/main/agentRuntime.ts` | primary as default runner | scheduler hooks | **possible overlap** → coordinate |
| `commands.ts` | task/runner contract | scheduling commands | additive-vs-rename → coordinate ordering |
| `AgentChatPanel` / `AgentDock` | — | scheduler UI | theirs |

**Conclusion:** real overlap on `src/core/types.ts` + `agentRuntime.ts` with #165.
This plan must **land behind #167** (it depends on the `audience` split) and be
**sequenced w.r.t. #165** via a human-led interface-first PR for the shared type /
contract changes. Decide ordering at ratification.

## Open questions (for main + PM)

Q1/Q2/Q3/Q5/Q6 are **resolved by "go cleanest"** (see North star): user-editable
default persona; full rename; hard-remove `general`; full code rename; drop
per-task overrides. **Config is now locked too: Option A** — a profile owns its
*entire* config; the Providers pane becomes credentials-only (model picking moves
onto the profile); permission is per-profile. So the design forks are decided; what
remains is **scope/sequencing judgment for the PM + main**, not direction:

1. **DM/Channel foreground — how much lands here.** The foreground reframes from
   "the main chat" to a **conversation switcher** (DM | Channel list at the top,
   chat-app idiom). This plan builds the **DM** half (1:1 — the reframed current
   chat, plus the switcher shell + types that are channel-ready); **Channels**
   (multi-agent) are a separate follow-on ([[agent-channels]]). Confirm that split
   is the right first cut, or whether the switcher shell should also defer.
2. **Sequencing vs #165.** Real overlap on `types.ts` + `agentRuntime.ts` (see
   Collision self-check). This plan must land **behind #167** (depends on the
   `audience` split) and be ordered w.r.t. #165 via a human-led interface-first PR.
   Decide ordering at ratification.

## Subtasks (build — only after ratification)

- [ ] Interface-first PR: `types.ts` / `commands.ts` (default-profile
  `AgentDefinition`; task-run rename + runner param; capability fields finalized on
  the profile; **conversation type `DM | Channel`** kept channel-ready) — human-led,
  sequenced vs #165.
- [ ] Default profile (built-in) as a definition + default runner; roster shows it;
  persona user-editable with reset-to-default.
- [ ] Retire `general` + `general-purpose` alias; `fresh`-no-runner → default
  profile; skill-default + unknown-type fallback → default profile.
- [ ] `fork` as a pure context mode (drop the pseudo-definition).
- [ ] Drop the `Agent` tool's per-call `model`/`effort` overrides; capability is
  profile-only (`maxTurns` never a task input).
- [ ] Full rename subagent → task (types, files, storage, tool contract, UX copy).
- [ ] **Config Option A:** move model onto the profile (Providers pane →
  credentials-only); per-profile permission (Permissions pane reorganized around
  profiles).
- [ ] **DM foreground reframe:** the current main chat becomes the *default DM*;
  add the top **conversation switcher** (DM list now; Channel list stubbed,
  channel-ready types). Channels (multi-agent) ship later as [[agent-channels]].
- [ ] Spec rewrite (`docs/spec/agent-subagent-runtime-plan.md` → the Agent/Task
  model) + tests; fold this plan's design into the spec on ship.
