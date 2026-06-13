# Research Skill

Give Tenon a first-class research/explore capability as a skill of the current
agent. When generic research needs isolation, it runs as a read-only fork of the
current agent.

This plan does **not** decide the whole agent-to-agent communication model. Tenon
should support explicit private agent consultation as a separate architecture
primitive: an agent can ask another specialist agent for help, then bring the
result back to the original conversation. That is different from making generic
research secretly invoke a named non-member agent by default.

## Goal

Ship one complete capability: when the user or an agent asks to research,
explore, inspect, map, survey, or verify context before deciding or editing,
Tenon can run a bounded read-only investigation and return a concise,
evidence-backed report.

The capability should work from:

- a normal assistant DM, without switching to a Channel;
- another agent run, if that agent is allowed to invoke skills;
- a command node, as a reusable research step in the command's prompt;
- a Channel, where the addressed member uses the skill as its own capability.

The user-facing concept for this capability is **Research as a skill**. The
execution boundary is **a read-only fork of the current agent**.

## Non-goals

- No built-in `researcher` agent in this execution unit.
- No implicit non-member `researcher` invocation as the default implementation of
  generic research.
- No long-lived research participant, independent memory line, or Channel member.
  If that product need appears later, it should be designed as a separate
  explicit Channel agent.
- No global ban on agent-to-agent private consultation. That belongs in the
  broader delegation architecture, not in this research skill execution unit.
- No browser automation. Web research stays limited to existing `web_search` /
  `web_fetch`; logged-in browser control remains gated by the browser integration.
- No MCP/plugin/remote agent lifecycle.
- No new model-facing "research" tool. Use the existing skill invocation path.
- No mutation capability in the research child run. Research reads, searches, and
  reports; it does not edit files, mutate outliner nodes, change config, run
  side-effecting shell commands, or spawn child agents.

## Design

### 0. Architectural stance: three different primitives

Tenon should keep three concepts separate:

| Primitive | What it means | Best for |
|---|---|---|
| Skill fork | The current agent uses one of its own capabilities in an isolated child run. | Generic research, verify, summarize, format, inspect. |
| Private consultation | The current agent asks another specialist agent for help off-thread, receives a result, and remains accountable for the final reply. | Security review, design critique, domain expertise, specialist memory/tools. |
| Channel invitation | Another agent becomes a visible member of the shared conversation. | Multi-party discussion, visible disagreement, ongoing collaboration. |

This plan chooses the first primitive for generic `/research`. It should not be
read as an argument against the second primitive. The Slack-like model is valid:
an agent can privately contact a specialist and bring the answer back. The
important product distinction is that this is a consultation record, not a claim
that the specialist joined the original DM or Channel.

Private consultation should have its own future design with explicit audit and
visibility rules:

- the caller declares which agent it consulted;
- the private transcript is inspectable through the run/task trace, not injected
  into the original conversation as if the specialist spoke there;
- the target agent's own tools, skills, and memory line apply;
- the caller owns the final answer and may accept, reject, or summarize the
  specialist's result;
- recursion, cost, permission, and memory-write behavior are bounded.

### 1. Add a built-in `/research` skill

`/research` is a code-registered built-in skill because it is a product primitive
over Tenon's own runtime boundary, not a project-local workflow. It should be
visible in the normal skill listing and usable through slash invocation and
model-invoked skill calls, subject to the existing skill ratification and
permission rules.

Recommended frontmatter shape:

```yaml
description: Research or explore a question in an isolated read-only child run.
when_to_use: Use when the user asks to research, explore, inspect, map, survey, or verify context before deciding or editing. Examples: "research this area", "explore how backlinks work", "verify this assumption", "find the relevant files". Do not use for direct implementation or edits.
argument-hint: "<question or area to research>"
arguments:
  - question
context: fork
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

The `allowed-tools` list above is only a no-prompt convenience for expected read
operations. It is not the safety boundary. The read-only boundary is the
catalog-narrowing mechanism described in §3.

The skill body briefs the child run to:

- restate the concrete question and scope before searching;
- prefer local document/spec/file evidence first;
- use web search only when the question needs current or external information;
- cite file paths, node references, memory references, or web URLs for findings;
- separate findings, confidence, open questions, and suggested next probes;
- avoid plans, edits, writes, config changes, shell commands, and child-agent
  spawning unless the caller later asks for that as a separate task.

`/explore` should not be a separate first version. The `/research` trigger should
cover explore, inspect, survey, map, and verify. Add an alias later only if usage
data shows that users consistently look for it.

### 2. For generic research, run as a fork of the current agent

The skill uses `context: fork` with no `agent:` override. That means the child run
inherits the current agent's role and conversation context, then works in an
isolated execution transcript whose final report returns to the caller.

This preserves the DM/Channel mental model for the generic research capability:

- In a DM, the user asked the current agent to use a research capability.
- In a Channel, the addressed member used one of its skills.
- No extra named agent speaks, joins, or accumulates hidden relationship state.
- The UI can label the boundary as a skill run, for example `/research`, rather
  than as a message from a non-member "researcher".

If the product later needs a long-lived researcher personality with its own
memory, that is a different feature: an explicit agent definition that the user
adds to a Channel, opens a DM with, or lets another agent privately consult under
the broader delegation rules. It should not be smuggled in as the default
implementation of generic research.

### 3. Make read-only safety structural

The current `allowed-tools` skill field is a run-scoped preapproval list; it must
not be treated as the only safety boundary. A research fork needs an actual
catalog restriction so the child cannot call mutating tools even if the prompt
drifts.

The implementation should reuse the existing agent tool catalog filter:

- `AgentDefinition.tools` / `disallowedTools` already narrow the real tool catalog.
- `createAgentTools(...)` already applies that catalog narrowing before the model
  sees tools.
- The research fork should enter the same path with an internal read-only
  restriction at fork spawn. Do not write a second filter.

The read-only set should be derived from `AgentToolActionKind`, not hand-listed by
tool name. Add a `READ_ONLY_ACTION_KINDS` partition, or an equivalent per-kind
flag, beside the existing default action decision table in
`src/core/agentPermissionModel.ts`. The `satisfies Record<AgentToolActionKind, ...>`
pattern keeps the partition exhaustive: every future action kind must be
classified as read-only or side-effecting before typecheck passes.

Read-only action kinds include status, recall, search, fetch, read, and diagnostic
operations such as:

- `file.read.*`
- `outline.read`
- `web.search`
- `web.fetch`
- `shell.read_search`
- `agent.memory.recall`
- `agent.runtime.status`
- `agent.config.read`
- `agent.doctor.run`
- `agent.delegate.status`

Side-effecting action kinds must be excluded from the research child catalog:

- file edit/write/delete
- outline edit/delete
- side-effecting shell execution
- remote publish/deploy
- external message send
- config write
- skill invocation
- agent delegate spawn/send/stop
- memory Dream/write-like actions
- permission modification
- payment/purchase

The built-in `/research` registration should carry an internal read-only fork
flag, for example `readOnlyFork: true`, that is not part of mutable
`SkillDefinition` frontmatter in v1. When that flag is present, skill invocation
passes read-only catalog narrowing into `AgentDelegationRuntime.invokeSkillChildAgent`.
The forked child then receives the parent's normal context, but only the tools
whose action-kind profile is read-only. The resulting catalog must omit mutating
tools entirely; tests should assert absence from the child model request, not
mere permission denial at call time.

Do not add a general skill `tools` field in this feature. If a second built-in
read-only fork skill later proves the need, expose a single `readOnly: true`-style
capability rather than per-skill tool arrays.

### 4. Report shape

The final child result should be compact enough to paste back into the parent
conversation without flooding it:

```text
Findings
- ...

Evidence
- ...

Confidence
- High/medium/low, with the reason.

Open questions
- ...

Next probes
- ...
```

The report should distinguish direct evidence from inference. If the child used
web sources, it should say so and cite URLs. If it only used local files or nodes,
it should say that too.

### 5. Relationship to cc-2.1 Explore/Plan

cc-2.1's `Explore` agent is a useful reference for bounded read-only
investigation. Tenon should borrow the boundary and report discipline, not the
agent-shaped product grammar.

The key differences:

- cc-2.1 is primarily codebase/session oriented; Tenon research must cover
  outliner nodes, specs, files, agent memory, and optionally web.
- cc-2.1 can expose a specialist agent because Claude Code does not have Tenon's
  DM/Channel participant model. In Tenon, a named agent implies a durable
  participant or an explicit private consultation. Generic `/research` should not
  hide that distinction.
- cc-2.1 `Plan` is software-architecture-specific. Tenon's first capability is
  research/explore only. Planning remains the caller's responsibility unless a
  later `/plan` skill is justified.

## Touched files

Expected implementation files:

- `src/core/agentPermissionModel.ts` - add the exhaustive read-only action-kind
  partition or equivalent per-kind flag.
- `src/main/agentSkills.ts` - register the built-in `/research` skill with its
  internal read-only fork flag. Do not add mutable `SkillDefinition` frontmatter
  for tool narrowing in v1.
- `src/main/agentRuntime.ts` and/or `src/main/agentDelegation.ts` - apply the
  built-in skill's read-only fork flag at fork spawn by reusing the existing
  `tools` / `disallowedTools` catalog-narrowing path.
- `src/main/agentTools.ts` - only if a small exported helper is needed to share
  the existing catalog filter; do not duplicate the filter logic.
- `docs/spec/agent-skills.md` - document `/research`, read-only fork behavior,
  and the distinction between `allowed-tools` preapproval and catalog restriction.
- `docs/spec/agent-delegation-runtime.md` - document that this capability uses a
  same-agent fork with a read-only catalog restriction, not a separate agent
  definition.
- Tests under `tests/core/agentSkills.test.ts`,
  `tests/core/agentRuntimeChildRuns.test.ts`, and/or a focused integration test:
  - `/research` appears as a built-in skill;
  - the skill creates a forked same-agent child run;
  - the child request's catalog includes read/search/status/diagnostic tools
    derived from read-only action kinds;
  - mutating tools, `skill`, and `agent` spawn/send/stop are absent from the child
    catalog, not merely denied by permission;
  - the parent receives only the final child result;
  - disabled skill gates still apply.

## Risks

- **Tool taxonomy mistakes.** The read-only partition becomes security-sensitive.
  Keep it exhaustive with TypeScript and test representative side-effecting tools
  so new action kinds cannot drift into the research catalog silently.
- **Prompt-only safety.** The implementation must not rely on "do not edit" text
  alone. Tests should pin that mutating tools are absent from the child catalog.
- **Allowed-tools confusion.** `allowed-tools` is useful to avoid prompts for
  expected read operations, but it must stay documented as preapproval only.
  Safety comes from catalog restriction.
- **Over-browsing.** Research can waste time and introduce stale or irrelevant web
  material. Default local-first; use web only when the task is current, external,
  or impossible to answer from local context.
- **Too little context.** A forked child may miss nuance if the parent passes a
  vague question. The skill body should force a brief, concrete research brief.
- **Too much transcript.** The child should return a report, not a search diary.
  Keep detailed tool churn in the child run log.

## Open questions

- Should forked skill tool narrowing become a general frontmatter feature later?
  Recommendation: no for v1. Keep `/research` built-in-only. If a later verify or
  audit skill needs the same boundary, expose a single `readOnly: true` capability
  rather than per-skill tool arrays.
- Should web tools be included by default? Recommendation: include them but make
  the skill local-first and require the report to disclose when web was used.
- Should the UI expose a visible child-run affordance for `/research`? Recommendation:
  reuse the existing child-run boundary if possible, but label it as a skill run
  instead of a separate agent.
- Should Tenon later add an explicit researcher agent? Recommendation: defer. Add
  it only when users want a durable research participant with its own memory and
  Channel presence.
- Should Tenon add an explicit private consultation primitive for agent-to-agent
  help? Recommendation: yes, as a separate architecture plan. It should model the
  Slack-like "ask a specialist privately, then bring back the result" workflow,
  rather than forcing every cross-agent interaction into a shared Channel.

## Collision check (2026-06-13)

Open PRs reviewed:

- #231 `cc/channel-async-message-bus` touches Channel runtime/projection/UI and
  specs. It is semantically adjacent because it changes Channel delivery, but this
  plan avoids hidden non-member agents and therefore does not need the async bus.
- #230 `codex-3/skillify-upgrade-plan` touches
  `docs/plans/agent-skills-authoring.md`. Conceptually adjacent to skills, but no
  file overlap in this plan PR.
- #229 `cc-2/agent-workdir-relocation` touches agent file/workdir tools and
  adjacent permission/tool specs. It may affect which local files research can
  read, but it does not block the skill design.

No blocking overlap. The implementation PR should re-run the collision check
against `src/main/agentSkills.ts`, `src/main/agentRuntime.ts`,
`src/main/agentDelegation.ts`, `src/core/agentPermissionModel.ts`, and the agent
specs before claiming work.

## Verification

For the implementation PR:

- `bun run typecheck`
- `bun run test:core -- agentSkills agentRuntimeChildRuns`
- `bun run docs:check`
- If the implementation adds UI affordances beyond existing child-run/skill
  listings, add light/dark visual verification; otherwise no visual gate is
  required.

## Build checklist

- [ ] Main boards the implementation PR; this plan-only branch does not edit
      `docs/TASKS.md`.
- [ ] Add exhaustive read-only action-kind partition.
- [ ] Add fork-spawn catalog restriction by reusing existing
      `tools` / `disallowedTools` filtering.
- [ ] Register built-in `/research`.
- [ ] Wire `/research` to consume the internal read-only fork restriction.
- [ ] Add tests for listing, fork routing, tool narrowing, and disabled gates.
- [ ] Sync `agent-skills.md` and `agent-delegation-runtime.md` in the same change.
