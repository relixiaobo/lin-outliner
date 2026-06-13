# Research Agent + Skill Wrapper

Give Tenon a first-class research/explore capability that is easy for the user,
the main agent, command nodes, and other agents to invoke without requiring a
Channel membership setup. The capability is deliberately split into two pieces:
a read-only `researcher` agent definition that owns execution boundaries, and a
`/research` skill wrapper that owns discovery, briefing, and invocation ergonomics.

## Goal

Ship one complete product capability: when the user or an agent asks to research,
explore, verify context, or map a code/document area, Tenon can run the work in an
isolated read-only child run and return a concise evidence-backed report to the
caller.

The capability should work from:

- a normal assistant DM, where the main agent can invoke it without switching to a
  Channel;
- another agent run, provided that agent has the `skill` tool and the skill is
  ratified/listed or slash-invoked by the user;
- a command node, where the command can call the skill as part of its prompt;
- a Channel, where `researcher` can still be invited as a member when a long-lived
  peer identity is useful.

The model-facing concept is **Research as a skill**. The execution profile is
**Researcher as an agent**.

## Non-goals

- No browser automation. Web research stays limited to existing `web_search` /
  `web_fetch`; logged-in browser control remains gated by the separate browser
  integration plan.
- No MCP/plugin/remote agent lifecycle.
- No teammate/team/worktree/remote branch from cc-2.1.
- No new model-facing research tool. Use the existing `skill` tool and existing
  same-conversation `Agent` delegation runtime.
- No generic built-in worker profile. Generic isolation continues to use fork by
  omitting `agent_type`.
- No mutation capability in the researcher profile. Research reads, searches, and
  reports; it does not edit files, mutate outliner nodes, change config, spawn
  subagents, or run write-capable shell commands.

## Design

### 1. Add a built-in `researcher` agent profile

`researcher` is a code-registered built-in agent definition, similar in
immutability to the existing built-in Tenon assistant. It is not a Channel-only
feature; it is an ordinary agent definition that can be selected by
`Agent(agent_type: "researcher")` and by skills using `agent: researcher`.

The profile is optimized for fast, bounded, read-only investigation:

- `tools`: read/search only. Start with `node_search`, `node_read`, `file_read`,
  `file_glob`, `file_grep`, `web_search`, `web_fetch`, and `recall` if available.
  Do not include `file_write`, `file_edit`, `node_create`, `node_edit`,
  `node_delete`, `bash`, `skill`, or `agent`.
- `model`: inherit by default; a later tuning pass may choose a cheaper/faster
  model if provider policy supports it.
- `permissionMode`: restricted, or the closest existing equivalent, so the tool
  list is an allow-list rather than a suggestion.
- `maxTurns`: low enough to avoid runaway exploration, high enough for a focused
  survey.
- System prompt: require evidence-backed reports, explicit uncertainty, and no
  edits. The final answer should include findings, source references, unknowns,
  and suggested next probes. It should not create plans unless asked.

The built-in researcher may be duplicated into a user/project agent if a user
wants custom domain research behavior. The built-in itself remains immutable.

### 2. Add a built-in or project-shipped `/research` skill wrapper

The skill is the ergonomic entry point. It should be visible as a normal skill,
not only as an agent picker option, so the main agent and other agents can invoke
research without requiring the user to create or enter a Channel.

Recommended first version: a built-in skill, because the wrapper is a product
primitive that teaches Tenon's own runtime how to call its own built-in
`researcher` profile. If the review prefers a smaller first step, ship it as a
project skill under `.agents/skills/research/SKILL.md`; the body and behavior are
the same, but project skill trust/acceptance applies.

Frontmatter shape:

```yaml
description: Research or explore a question in an isolated read-only child run.
when_to_use: Use when the user asks to research, explore, inspect, map, survey, or verify context before deciding or editing. Examples: "research this area", "explore how backlinks work", "verify this assumption", "find the relevant files". Do not use for direct implementation or edits.
argument-hint: "<question or area to research>"
arguments:
  - question
context: fork
agent: researcher
allowed-tools:
  - node_search
  - node_read
  - file_read
  - file_glob
  - file_grep
  - web_search
  - web_fetch
  - recall
```

The wrapper body tells the parent/caller how to brief the researcher:

- include the concrete question and desired depth (`quick`, `standard`, or
  `deep`);
- include known files, nodes, plans, specs, or claims to verify;
- specify whether web search is allowed or local-only is required;
- ask for evidence with file/node/web references;
- require the output to separate findings, confidence, open questions, and next
  recommended actions;
- explicitly prohibit edits, writes, config changes, and child-agent spawning.

Because `context: fork` skill calls already return only the child result to the
parent, the heavy search transcript stays out of the main conversation while the
final report remains visible.

### 3. Main-agent and other-agent usability

The key product reason for the skill wrapper is callability.

A pure agent profile is technically callable through `Agent(agent_type:
"researcher")`, but it is not ergonomic: the caller must know the agent name and
choose the delegation tool. A skill wrapper lets the runtime advertise a natural
capability: `/research`, plus automatic model invocation when the user's request
clearly asks for research. The skill then selects the right agent profile through
`agent: researcher`.

This creates three invocation paths with one execution profile:

| Entry | Mechanism | Result |
|---|---|---|
| User slash | `/research ...` | user explicitly requests a researcher child run |
| Main or child agent | `skill({ skill: "research", args })` | model-invoked research when ratified/listed |
| Channel | invite/use `researcher` | long-lived peer researcher identity |

If an agent definition excludes the `skill` tool, it cannot use the wrapper. That
is intentional: such agents are not allowed to invoke dynamic capabilities. If an
agent has `Agent` but not `skill`, it can still call `Agent(agent_type:
"researcher")` directly when the listing exposes the profile.

### 4. Permission and safety model

Researcher safety should be structural, not prompt-only.

- The built-in `researcher` profile has no mutating tools.
- The `/research` skill preapproves only read/search tools needed by the child
  run. It never preapproves writes, bash, browser actions, deploys, or external
  side effects.
- If web access is needed, the wrapper asks the caller to make it explicit when
  the task involves current external information. Otherwise local/contextual
  research is the default.
- The child result must disclose whether it used web sources, local files,
  outliner nodes, or memory recall.
- The child result must not present uncertain inference as fact.

### 5. Relationship to cc-2.1 Explore/Plan

cc-2.1's `Explore` and `Plan` built-in agents are useful references for the
read-only boundary and focused search behavior. Tenon should not copy them
verbatim:

- cc wording is Claude Code and codebase oriented; Tenon must cover outliner nodes,
  agent memory, specs, files, and optionally web.
- cc exposes the specialist primarily as an agent. Tenon should expose Research as
  a skill wrapper so the capability is callable without Channel setup and without
  callers memorizing `agent_type`.
- cc `Plan` is software-architecture-specific. Tenon's first capability should be
  research/explore only. Planning remains a caller responsibility unless a later
  `/plan` wrapper is justified.

## Touched files

Expected implementation files:

- `src/main/agentDelegation.ts` - register the built-in `researcher` agent
  definition beside the built-in assistant; ensure listings and disabled-agent
  behavior work unchanged.
- `src/main/agentSkills.ts` - register the `/research` built-in skill if the PR
  chooses the built-in wrapper path.
- `src/core/agentToolCatalog.ts` / `src/main/agentTools.ts` tests only if the
  researcher allow-list reveals catalog drift; no new tool is expected.
- `docs/spec/agent-delegation-runtime.md` - document the built-in researcher
  profile and its direct `Agent(agent_type)` path.
- `docs/spec/agent-skills.md` - document the `/research` `context: fork` wrapper
  pattern and its interaction with `agent: researcher`.
- `docs/spec/agent-tool-design.md` - no new model-facing tool; add a short note
  only if the reviewer wants the research wrapper listed as an app-level
  capability.
- Tests under `tests/core/agentRuntimeChildRuns.test.ts`,
  `tests/core/agentSkills.test.ts`, and/or a small new focused test file:
  - researcher appears in agent listing;
  - researcher tool allow-list excludes mutation, `skill`, and `agent`;
  - `/research` renders as a forked skill selecting `agent: researcher`;
  - the parent receives only the final child result;
  - disabledAgents / disabledSkills gates still apply.

## Risks

- **Capability duplication.** A direct `Agent(agent_type: "researcher")` path and a
  `/research` skill wrapper may look redundant. They are intentionally layered:
  agent = execution boundary; skill = ergonomic capability.
- **Prompt-only safety.** A research profile with `tools: ["*"]` would be unsafe.
  The implementation must use an explicit read/search allow-list and tests should
  pin the absence of mutating tools.
- **Over-browsing.** Research requests may trigger unnecessary web use. Default to
  local/contextual research unless the user asks for current external information
  or the question is clearly time-sensitive.
- **Channel confusion.** The researcher should be usable as a Channel member, but
  the primary product story is callable research from any normal agent flow. UI
  copy and docs should avoid implying that Channel membership is required.
- **Built-in surface creep.** If every workflow becomes a built-in skill, the prompt
  grows. Research earns built-in treatment only because it bridges an existing
  runtime boundary and is broadly useful across documents, specs, files, and
  commands.

## Open questions

- Should `/research` ship as a code-registered built-in skill, or as a project
  skill template first? Recommendation: built-in, because it is a product
  primitive over a built-in agent profile.
- Should `researcher` include `web_search` / `web_fetch` by default, or should web
  access be a separate `research-web` wrapper? Recommendation: include web tools
  but instruct local-first behavior; permission policy still governs web access.
- Should there also be a separate `/explore` alias? Recommendation: no separate
  first version. Use one `/research` wrapper whose `when_to_use` includes explore,
  inspect, survey, and verify. Add aliases only if user language data shows need.
- Should a later `/plan` skill wrap `researcher` output into implementation plans?
  Recommendation: defer. Planning has stronger PM/escalation implications than
  read-only research.

## Collision check (2026-06-13)

Open PRs reviewed:

- #231 `cc/channel-async-message-bus` touches Channel runtime/projection/UI and
  specs. Adjacent to agent execution but not the built-in agent/skill registration
  path.
- #230 `codex-3/skillify-upgrade-plan` touches only
  `docs/plans/agent-skills-authoring.md`. Conceptually adjacent to skill wrappers,
  no file overlap with this new plan unless both edit `agent-skills.md` later.
- #229 `cc-2/agent-workdir-relocation` touches agent file/workdir tools and
  adjacent permission/tool specs. It may affect the exact local file behavior that
  researcher can read, but does not block this plan.

No blocking overlap. The implementation PR should re-run the collision check
against `src/main/agentDelegation.ts`, `src/main/agentSkills.ts`, and the three
agent specs before claiming work.

## Verification

For the implementation PR:

- `bun run typecheck`
- `bun run test:core -- agentRuntimeChildRuns agentSkills`
- `bun run docs:check`
- If the implementation adds UI affordances beyond existing agent/skill listings,
  add light/dark visual verification; otherwise no visual gate is required.

## Build checklist

- [ ] PM/main review decides whether to board this as a new active plan and where
      it sits relative to `agent-skills-authoring` and delegation-runtime work.
- [ ] Register built-in `researcher` with read/search-only tools.
- [ ] Add `/research` wrapper skill using `context: fork` + `agent: researcher`.
- [ ] Add tests for listing, tool allow-list, wrapper routing, and disabled gates.
- [ ] Sync `agent-delegation-runtime.md` and `agent-skills.md` in the same change.
