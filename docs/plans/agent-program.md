---
status: meta
priority: P1
owner: relixiaobo
created: 2026-06-05
updated: 2026-06-05
---

# Agent Program — Foundation, Dependency Graph, Release Milestones

The umbrella for the agent-subsystem rebuild. It does **not** describe a feature; it
owns what no single feature plan should own alone: the shared **L0 foundation**, the
**cross-plan event taxonomy**, the consolidated **protocol-surface change list**, the
**dependency graph**, and the **release milestones M0–M3**. Member feature plans
*reference* this doc; they must not re-describe the foundation.

This is a **`meta`** plan — a standing reference (like `performance-optimization.md`
and `ui-quality-roadmap.md`), not a unit of work. It exists because analyzing
[[agent-conversation-model]] and [[agent-self-modification]] together revealed they are
**not two plans but one program over a shared foundation** — and that foundation is
mostly the *same* set of seams every agent plan was independently planning to cut.

## Member plans

| Plan | Owns | Milestone(s) |
|---|---|---|
| [[agent-conversation-model]] | Agent identity, DM/Channel conversations, the memory line, background tasks, multi-agent + coordinator routing | M0–M3 (the spine) |
| [[agent-skills-authoring]] | Skill **structure** (unified library + binding + `built-in` floor) and **governed self-authoring** | M0–M2 |
| [[agent-self-modification]] | Self-observation, the `config` tool, **hooks**, config recovery, curation policy | M1–M3 |
| [[agent-ask-user-question-tool]] | The `ask_user_question` tool (structured pause/resume) | M1 |
| [[agent-import-skill]] | Data import from other products (consumer of skills + ask_user_question) | M1–M2 |
| [[agent-scheduled-routines]] | `command` NodeType + anacron scheduler + triggered runs | M2 |
| [[agent-generative-ui]] | Inline HTML/SVG widgets in chat | M1–M2 (P3 priority) |
| [[agent-tool-permissions-hardening]] | Post-#60 permission correctness/hardening | any (independent) |
| `agent-tool-result-trim` | Model-visible tool-result trimming | shipping (#128) |

## Shipped foundation (build on this — A8)

Already real; the rebuild sits **on top**, it does not re-implement these:

- **Event-sourced persistence** — per-session `events.jsonl` + payload files +
  checkpoints; message / tool / approval / run / branch / compaction / subagent events
  (`docs/spec/agent-event-log-rendering.md`). Stored under flat `sessions/<id>/` that
  **conflates messages and execution** in one stream — F2 splits it into a conversation
  log + run log. `actor` is already on every event (hardcoded `'pi-mono'`);
  `compaction.completed` already records a summary over a **retained** range (the
  distillation backbone). **No DM/Channel rendering, no members, no memory line yet.**
- **Skills** — discovery + invocation from `user` / `project` / additional / `dynamic`
  sources; path-conditional; embedded shell; `allowed-tools` run-scoped preapproval;
  `model`/`effort` override; `context: fork`. **Registry startup-cached; no `built-in`;
  no authoring** (`docs/spec/agent-skills.md`).
- **Permissions** — `allow | ask | deny` + platform hard blocks + bash classifier +
  ask resolver + approval UI + session-scoped allow rules + permission events (#60,
  `docs/spec/agent-tool-permissions.md`).
- **Subagents** — fresh / fork / background runs + sidechain transcripts + background
  notifications + `Agent` / `AgentStatus` / `AgentSend` / `AgentStop`
  (`docs/spec/agent-subagent-runtime-plan.md`).
- **Compaction** — manual / automatic / reactive + tool-output slimming + recent-file
  restore.

**Not shipped (the build surface):** memory; DM/Channel conversations; hooks
(frontmatter ignored); the config tool / runtime_status / doctor; skill authoring;
`ask_user_question`; durable multi-agent identities + coordinator; a unified visible
task panel.

## The L0 foundation (M0) — shared seams, interface-first

Six seams the whole program rests on. They are mostly **protocol-surface** (A4) and
must land **interface-first** before consumers build on them (A7). Each names the plans
that consume it — proof it belongs here, not inside one feature plan.

| # | Seam | What | Consumers |
|---|---|---|---|
| F1 | **Agent identity record** | A stable `name` agents / memory / config hang off (NOT the registry refactor — that is M3) | conversation-model (memory), self-modification (config/status), skills (binding) |
| F2 | **session → `{conversation, run}`** | Split the conflated session: re-key `sessions/<id>` → a **conversation log** (`conversations/<id>`, messages) **+ a run log** (`runs/<id>`, execution); add the `Principal` type + `members` + `cursors` (**no stored `kind`** — DM/group is derived); `RunMeta` anchors to exactly one conversation, `trigger` is provenance. (Detail: conversation-model §Data structure.) | conversation-model, scheduled-routines (persistence), past_chats, ask-question (events) |
| F3 | **`actor` on message records** | Store authorship on `AgentEventMessageRecord` (`agentEventLog.ts:451`); **parameterize** `agentActor()`, dropping hardcoded `'pi-mono'` (`agentRuntime.ts:3211`). `actor` is one `Principal`-based type used as member = author = addressee | conversation-model (notifications, multi-agent POV, forwarding), task delivery |
| F4 | **Typed event bus + taxonomy** | One typed domain-event emitter (`agentRuntime.ts:1707`) + a **single event taxonomy designed once** (below) | **notifications** (conv-model, trusted observer) + **hooks** (self-mod, untrusted) + ask-question + gen-ui + scheduled + config + skills |
| F5 | **`AgentSessionState` split** | Break the per-session singleton bundle (`activeRunId`, `toolOutputPayloads`, `lastSubmittedUserPrompt`, `skillRuntime`, `selectedLeafMessageId`; `agentRuntime.ts:240-270`) so parallel runs don't clobber. The F2 **run log** makes this isolation *structural* (each run owns its own execution stream), not incidental | background tasks, scheduled routines, multi-agent channels |
| F6 | **Protocol-surface type adds (consolidated)** | One coordinated round of `src/core/*` additions (below) instead of N drive-by edits | all plans |

### Cross-plan event taxonomy (design ONCE)

Every member plan independently planned to add events to `agentEventLog.ts` /
`agentTypes.ts`. **Reconcile them into one taxonomy here**, then each plan emits/consumes
its slice. cc-2.1's hook-event vocabulary (from self-modification) is the reference
naming; align lifecycle points to it rather than inventing variants.

| Event family | Emitted by | Consumed by | Notes |
|---|---|---|---|
| **Lifecycle** (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `PostCompact`, `Stop`) | runtime | hooks (self-mod), notifications | cc-2.1 names; the hook event surface |
| **Run / execution** (`run.started/completed/failed`, `*_message.delta`, `thinking.delta`, `tool_call.*`, `tool_result.created`) | the run loop | run log, debug panel | live in the **run log** (F2), not the conversation log — keeps `tool_call ↔ tool_result` pairs off the shared channel stream |
| **Distillation** (`compaction.completed`, generalized) | compaction / consolidation | context assembly, navigation, recall, memory feedstock | a recorded summary over a **retained** range; carries the addressable `source` down-pointer (conversation-model §Data structure) |
| **Task** (`TaskCreated`, `TaskCompleted`, `needs-input`) | task plane (conv-model) | task panel, notifications, hooks | self-mod's `TaskCreated/Completed` hooks **depend on conv-model building this** |
| **Notification / attention** | task plane, runs | origin conversation (in-stream + unread/OS) | trusted internal observer; reuses **F3 `actor`** |
| **`user_question.*`** (requested / answered / cancelled) | ask_user_question | ask-question UI, `needs-input` tasks | [[agent-ask-user-question-tool]] |
| **`widget_state.updated`** | generative-ui | widget renderer, next-turn context | [[agent-generative-ui]] |
| **`ConfigChange`** | config tool | config recovery, hooks, audit | [[agent-self-modification]] |
| **`skill.*`** (create / patch / replace / enable / disable / rollback / curation) | skills authoring | skill audit, curation, hooks | [[agent-skills-authoring]] |
| **`sys:lastRunAt`** (schedule fire cache) | scheduler | catch-up decision | [[agent-scheduled-routines]] |

**Trust split (shared bus, separate dispatch).** Notifications are **trusted async
observers**; hooks are an **untrusted extension surface** with interceptors
(synchronous, can block/mutate, e.g. `PreToolUse`-deny) needing a sandbox/trust gate.
Both ride the same F4 bus; they differ in dispatch + trust, not in the event taxonomy.
Hook trust precedence: `system/admin > user > project > skill > model-suggested
session hook` (self-modification). Caution (from cc-2.1 + hermes): both fragmented into
per-consumer registries — "design the taxonomy once" is the cleaner target, but the
fragmentation pressure is real; keep the *event definitions* unified even if dispatch
is per-consumer.

### Consolidated protocol-surface changes (A4 / A7, interface-first)

Land these as a small number of coordinated interface-first PRs (the
infrastructure-ownership list — `src/core/types.ts`, `commands.ts`, `agentEventLog.ts`):

- `actor` on `AgentEventMessageRecord` (F3; backward-compatible).
- `Principal` type + conversation `members` + `cursors`; `RunMeta` (mandatory `conversationId` anchor + `trigger` provenance); **no stored `kind`** (F2).
- `DistillationNode.source` (explicit both-ends range) + `MemoryEntry.sources` down-pointer (the addressable-distillation backbone; conversation-model §Data structure).
- `'built-in'` on `SkillDefinition.source` ([[agent-skills-authoring]]; backward-compatible).
- Pending-interaction types for `user_question.*` ([[agent-ask-user-question-tool]]).
- `widget_state.updated` event ([[agent-generative-ui]]).
- `command` NodeType + protected-field property + `sys:lastRunAt` ([[agent-scheduled-routines]]).
- Review/approval-card + `ConfigChange` event types ([[agent-self-modification]]).

(Not every item must land in one PR — but the **event taxonomy and naming** are decided
together, here, so consumers don't diverge.)

## Dependency graph

```
L0 FOUNDATION (M0, interface-first)
   F1 identity · F2 session→{conversation,run}+Principal/members · F3 actor
   · F4 typed event bus + ONE taxonomy · F5 AgentSessionState split · F6 protocol type adds
        │
L1 SINGLE-AGENT CAPABILITY (M1)
   memory v1 (conv-model) · skills self-authoring (skills-authoring)
   · self-observation + config tool (self-mod) · ask_user_question (its plan)
        │
L2 OFF-FLOOR + EXTENSION (M2)
   background task panel + notifications + needs-input (conv-model)
   · prompt-only hooks (self-mod) · memory v2 extraction · config recovery + curation
        │
L3 MULTI-AGENT (M3)
   sequential Channels + coordinator (conv-model) · per-agent POV derivation
   · cross-agent configuration · command hooks (self-mod) · memory v3 · registry unification
```

Feature consumers slot where their deps land: [[agent-import-skill]] at M1 (needs
skills save-as-adapter + ask_user_question), [[agent-scheduled-routines]] at M2 (needs
F5 split + triggered runs), [[agent-generative-ui]] at M1/M2 (needs F4 bus; P3 priority,
mostly independent).

## Release milestones

| Milestone | Content | User-visible value |
|---|---|---|
| **M0 — Foundation** | F1–F6: identity · session→`{conversation, run}` (+ `Principal`/`members`, no stored `kind`) · actor · event bus + taxonomy · AgentSessionState split · consolidated protocol-surface adds | none directly — unblocks the whole program, one design pass, no rework |
| **M1 — Single-agent "self"** | memory v1 · skills self-authoring · config tool + runtime_status + doctor · ask_user_question | the agent **remembers**, can be **configured**, can **author its own skills**, can **ask structured questions** — the bulk of perceived value |
| **M2 — Off-floor + extension** | background task panel + notifications + needs-input · prompt-only hooks · memory v2 extraction · config recovery + skill curation | long tasks **don't go silent**, work is **observable**, memory becomes **automatic**, runtime self-heals |
| **M3 — Multi-agent** | sequential Channels + coordinator · per-agent POV · cross-agent configuration · command hooks · memory v3 consolidation · main-agent registry unification | **IM-native multi-agent** collaboration |

## How this reorg changes the member plans

- **[[agent-conversation-model]]** — slimmed: its §Skills moves to
  [[agent-skills-authoring]] (a structural-facts stub + pointer remains). The L0 seams
  it analyzed (identity, actor, session→{conversation,run}, AgentSessionState split) **keep
  their detailed, code-grounded design in conv-model**; this program doc owns only their
  **sequencing, the unified event taxonomy, and protocol-change coordination** (so
  consumers don't diverge). It remains the owner of conversations / memory / tasks /
  multi-agent.
- **[[agent-self-modification]]** — slimmed: §7 Skill Maintenance + §8 Curation move to
  [[agent-skills-authoring]]; its hook system references the **F4 event bus** here; its
  `TaskCreated/TaskCompleted/TeammateIdle/Notification` hooks are explicitly **gated on
  conv-model's task/channel layer (M2/M3)**.
- **[[agent-skills-authoring]]** — new; the single home for skill structure + authoring.
- The remaining plans (**ask-user-question, generative-ui, scheduled-routines,
  import-skill, permissions-hardening**) stay as feature plans; their event additions
  are reconciled into the taxonomy above; their build slots into the milestones.

## Open questions (program-level)

- **Milestone granularity for PRs.** M0 is several interface-first PRs; how finely to
  cut them (one per seam vs grouped) — decide at M0 kickoff.
- **Who configures whom** (cross-agent configuration scope: main-agent-first vs every
  specialist) — directional, owned by [[agent-conversation-model]] / [[agent-self-modification]].
- **Event taxonomy ownership after M0.** Once the taxonomy ships, does this doc stay the
  registry of event names, or does it fold into a `docs/spec/agent-event-*` spec? Lean:
  fold into spec when M0 ships (A6).
