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
  shell commands, or spawn child agents.

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
subtractive tool profile so the child cannot call mutating tools even if the
prompt drifts.

Add a small skill-runtime extension for `context: fork` skills:

- `tools` or equivalent internal tool narrowing may subtract tools from the
  parent agent's tool set.
- It may never add a tool the parent agent does not already have.
- It applies to the child run's actual available tool catalog, not only to
  permission preapproval.
- It is limited to forked skill runs in this PR; normal agent definitions keep
  their existing tool binding semantics.

Recommended first implementation: expose the narrowing as supported skill
frontmatter for forked skills, then have `/research` use it. If the reviewer wants
a smaller protocol surface, implement the same narrowing as a built-in-only
internal profile for `/research`, but keep the design subtractive and structural.

The research allow-list should include read/search tools only:

- `node_search`
- `node_read`
- `file_read`
- `file_glob`
- `file_grep`
- `web_search`
- `web_fetch`
- `recall` if available in the current runtime

It must exclude mutation and delegation:

- `node_create`, `node_edit`, `node_delete`
- `file_write`, `file_edit`
- `bash`
- `skill`
- `agent`
- browser-control tools
- deploy, config, or credential tools

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

- `src/main/agentSkills.ts` - register the built-in `/research` skill and parse
  any new forked-skill tool narrowing fields if they are exposed as frontmatter.
- `src/core/types.ts` - only if tool narrowing becomes part of the typed
  `SkillDefinition` protocol surface. If the reviewer chooses a built-in-only
  internal profile, this file should not change.
- `src/main/agentRuntime.ts` and/or `src/main/agentDelegation.ts` - apply the
  forked skill's narrowed tool set when creating the child run.
- `docs/spec/agent-skills.md` - document `/research`, read-only fork behavior,
  and the distinction between `allowed-tools` preapproval and structural tool
  narrowing.
- `docs/spec/agent-delegation-runtime.md` - document that this capability uses a
  same-agent fork, not a separate agent definition.
- Tests under `tests/core/agentSkills.test.ts`,
  `tests/core/agentRuntimeChildRuns.test.ts`, and/or a focused integration test:
  - `/research` appears as a built-in skill;
  - the skill creates a forked same-agent child run;
  - the child run receives read/search tools only;
  - mutating tools, `skill`, and `agent` are unavailable in the child;
  - the parent receives only the final child result;
  - disabled skill gates still apply.

## Risks

- **Protocol surface creep.** A general skill `tools` field is useful beyond
  research, but it touches the skill definition contract. If this is too broad for
  the first PR, use a built-in-only internal narrowing profile and keep the spec
  explicit about the narrower scope.
- **Prompt-only safety.** The implementation must not rely on "do not edit" text
  alone. Tests should pin that mutating tools are absent from the child catalog.
- **Over-browsing.** Research can waste time and introduce stale or irrelevant web
  material. Default local-first; use web only when the task is current, external,
  or impossible to answer from local context.
- **Too little context.** A forked child may miss nuance if the parent passes a
  vague question. The skill body should force a brief, concrete research brief.
- **Too much transcript.** The child should return a report, not a search diary.
  Keep detailed tool churn in the child run log.

## Open questions

- Should forked skill tool narrowing be a general frontmatter feature or a
  built-in-only internal profile for `/research`? Recommendation: general
  subtractive frontmatter for `context: fork` skills, because future skills such
  as verify/audit can reuse the same safety boundary.
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
`src/main/agentDelegation.ts`, `src/core/types.ts`, and the agent specs before
claiming work.

## Verification

For the implementation PR:

- `bun run typecheck`
- `bun run test:core -- agentSkills agentRuntimeChildRuns`
- `bun run docs:check`
- If the implementation adds UI affordances beyond existing child-run/skill
  listings, add light/dark visual verification; otherwise no visual gate is
  required.

## Build checklist

- [ ] PM/main review decides whether to board this as a new active plan.
- [ ] Register built-in `/research`.
- [ ] Add structural read-only tool narrowing for the research fork.
- [ ] Add tests for listing, fork routing, tool narrowing, and disabled gates.
- [ ] Sync `agent-skills.md` and `agent-delegation-runtime.md` in the same change.
