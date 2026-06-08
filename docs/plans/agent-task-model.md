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
| **Agent** = a *profile / persona* | an identity: name + system prompt + model/tools/permission config. Answers **who runs**. | { the **primary** agent, user-defined agents } |
| **Task** = a *delegated run* | a bounded execution: brief(prompt) + context **mode** + owning identity + isolated transcript + optional background + returned result. Answers **what / how**. | every `Agent`-tool invocation |

So what gets "spawned" is **not another agent** — it is the (same or a chosen)
agent **running a task**. A Task's parameters:

- **runner**: which profile executes — default = the **primary** agent; or a named
  user agent (today's `subagent_type`).
- **context mode**: `fresh` (clean slate) or `fork` (inherit the caller's
  prepared context). Today's "omit `subagent_type` ⇒ fork".
- **memory owner**: `fresh` → the runner; `fork` → the caller. (Already true:
  `resolveSubagentMemoryOwner`, `agentSubagentIdentity.ts:11-19`.)
- **bounds / isolation / result**: `maxTurns`, background, sidechain transcript,
  returned summary.

"Subagent" as a distinct *kind of agent* dissolves into "an agent running a task."

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
- **Not** multi-agent messaging / teams / channels.
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
Keep `AgentDefinition` as the **Agent/profile** shape. Introduce a **Task** vocab
for the *run*: rename `AgentSubagentRun*` → task-run types on the surface (storage
may stay; the rename is about the contract + UX). A task carries
`{ runner: agentId, mode: 'fresh' | 'fork', brief, bounds… }`.

### D2 — Primary agent as a first-class profile
Promote the foreground agent to an `AgentDefinition` (e.g. `source:'built-in'`,
`name:'tenon'`). Its system prompt = the `audience:'main'` sections (identity +
memory) **+** the shared core — so the main prompt stays byte-equivalent while the
persona becomes a *named, listed* profile. It is the **default runner**.

### D3 — Retire `general`
A `fresh` task with no explicit runner resolves to the **primary** agent. Remove
`general` as a separate built-in; skill-default and unknown-type fallback point at
the primary. (Open Q3: keep `general`/`general-purpose` as a model-facing alias,
or hard-remove per no-backcompat.)

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
remains **user-driven only** ([[agent-authoring]] Non-goal); the primary persona
must not be model-writable (Open Q1 decides whether it is *user*-editable at all).

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

1. **Primary persona editability** — read-only built-in, or user-editable (reusing
   the [[agent-authoring]] editor)? Affects the authoring/security surface.
2. **Model-facing contract churn** — rename `subagent_type` → `agent`/`runner`, or
   keep the param name and only re-document? (Every caller/prompt mentions it.)
3. **`general` cutover** — hard-remove (no-backcompat) or keep `general` /
   `general-purpose` as an alias to the primary for a while?
4. **Foreground switching** — in scope to run the *whole session* as a chosen user
   agent (switch the primary), or strictly task runners for now?
5. **Rename depth** — surface-only (UX + docs + tool schema) vs full code rename
   (types, file names, storage). Cheapest correct cut?

## Subtasks (build — only after ratification)

- [ ] Interface-first PR: `types.ts` / `commands.ts` (primary `AgentDefinition`,
  task-run rename, runner param) — human-led, sequenced vs #165.
- [ ] Primary agent as a definition + default runner; roster shows it.
- [ ] Retire `general`; `fresh`-no-runner → primary; skill-default + fallback → primary.
- [ ] `fork` as a pure context mode (drop the pseudo-definition).
- [ ] Terminology rename (subagent → task on the run surface).
- [ ] Spec rewrite (`docs/spec/agent-subagent-runtime-plan.md` → the Agent/Task
  model) + tests; fold this plan's design into the spec on ship.
