# Conversational Agent Authoring — Neva creates an agent through chat

**Part of the [[agent-program]].** This is the **`agentify`** sibling of `skillify`
([[agent-skills-authoring]]): a user-directed, interview-then-confirm workflow that
turns a conversation into a reusable custom **agent**, the same way `skillify` turns
one into a reusable **skill**. It reuses [[agent-self-modification]]'s core principle —
the model never writes the runtime registry directly; a runtime-owned API does, behind
a human confirmation.

## Goal

Let a user ask Neva, in normal conversation, to build a reusable custom agent. Neva
**designs** it (interviews the user about purpose, when it should run, what tools and
tone it needs; drafts a tight `description` + body), and the user **ratifies the
commit** through a prefilled review before anything is persisted.

Today agent creation is **UI-only**: the only way to author an `AgentDefinition` is the
Settings agent editor (`AgentConfigWindow` → `AgentEditor`), which writes
`~/.agents/agents/<name>/AGENT.md` through a runtime-owned IPC path the model cannot
reach (`createAgentDefinition` in `agentRuntime.ts`, backed by `createAgentDefinitionFile`
in `agentAuthoring.ts`, whose docblock states *"the model never reaches this surface —
only the user, through the settings UI"*). This plan adds the **conversational entry**
while keeping the human as the writer.

## Non-goals

- **No model-direct write to the agent registry** (`~/.agents/agents/**` /
  `<workspace>/.agents/agents/**`). The commit always routes through the existing
  runtime-owned create path behind a human confirmation — exactly the boundary
  [[agent-self-modification]] forbids relaxing (no raw `file_write` to registries).
- **No privilege escalation.** A created agent's `tools` / `disallowedTools` /
  `permissionMode` may not exceed what the creating user has effectively granted. An
  agent that could mint a more-capable agent and delegate to it would escape its own
  sandbox; the ceiling clamp closes that path.
- **Not a generic agent CRUD tool family** for the model (`agent_create` /
  `agent_patch` / `agent_delete`). Following the cc-2.1 decision recorded in
  [[agent-self-modification]] (*"does not expose separate skill_create/skill_patch …"*),
  the model gets one `skillify`-style propose workflow, not raw mutation tools.
- **Create-only this PR.** Editing / tuning / deleting an existing agent through chat is
  a follow-up, not this feature.
- **Not multi-agent "configure each other."** Who-configures-whom across agents is
  [[agent-conversation-model]]'s (M3), not this.

## Background — why creation is UI-only today, and why that constraint stays

The UI-only gate is not an oversight; it is the **privilege-escalation boundary**. An
agent that can author agents can author one with broader tools/permissions than itself,
then delegate to it — a self-escalation path out of its sandbox. So the design problem is
not "add a create tool"; it is **"let Neva create an agent without opening a
self-escalation path."** Two mechanisms keep the boundary intact:

1. **The human is the writer.** The model proposes a draft; the actual persist is a
   one-click human ratification through a prefilled editor. The creation *flow* is fully
   conversational; only the *commit* is a human action — the same shape as any
   consequential, hard-to-reverse action.
2. **The new agent cannot exceed the creating user's grants** (the ceiling clamp).

## Design

### Shape

**Shape (a): ONE complete feature in ONE PR.** The three pieces below (skill → propose
tool → confirm UI) are build-order *within* the single PR (foundation before consumers,
A7), not separate releases. The PR ships only when create-an-agent-through-chat works
end-to-end — never the tool without its confirm UI.

### The control point (mirrors `skillify`)

cc-2.1's `skillify`, as recorded in [[agent-self-modification]], is *"user-invoked,
interviews the user, shows a full SKILL.md, and asks for confirmation before saving."*
This is the **`agentify` analog for AGENT.md**:

```text
user asks for an agent
  -> Neva interviews (purpose / when it runs / tools / tone)
  -> Neva drafts an AgentAuthoringInput
  -> prefilled review shown to the user
  -> user confirms / edits / cancels
  -> on confirm, the runtime writes via createAgentDefinition()
  -> result (created identity, or cancelled) returns to Neva
```

Why a tool and not "interview + file tools" the way `skillify` writes a SKILL.md:
skills live under `.agents/skills/**`, which the file tools *can* reach, so `skillify`
writes through `file_write` after confirmation. Agent definitions live in the
**runtime-owned** registry the file tools **cannot** reach. So the agent path needs a
runtime-owned bridge — the `propose_agent` tool — instead of a raw file write. The
control point (interview → show full definition → confirm) is identical; only the write
mechanism differs, and it differs in the *safer* direction.

### The three pieces

1. **Skill `create-agent`** (bundled, built-in immutable floor — `agentSkills.ts`). Pure
   *workflow knowledge*, no write power of its own. `when_to_use`: the user wants to
   build / needs a specialized or reusable agent. It teaches Neva to interview for the
   load-bearing fields (purpose, activation, tool needs, tone/voice), draft a tight
   `description` (the routing line) and a focused body, and then call `propose_agent`.

2. **Tool `propose_agent`** (new, runtime-owned; modeled on `agentAskUserQuestionTool.ts`).
   Input: a drafted `AgentAuthoringInput` (`agentTypes.ts`) + target storage
   (`user` | `project`). It does **not** write. It surfaces the prefilled confirm UI and
   round-trips the user's decision back to Neva. On confirm it routes through the existing
   `createAgentDefinition()`; it returns a structured result (`created` with the new
   agent's identity, or `cancelled`) so Neva can continue without guessing. This is the
   `agentify` tool — the proposal bridge, not an `agent_create` CRUD tool.

3. **Confirm UI** — reuse `AgentConfigWindow` / `AgentEditor` in a prefilled
   *"review this proposed agent"* mode. It shows name / description / body / tools /
   permission mode / model, **which capabilities will be granted**, and where it will be
   saved. The user can edit any field freely before saving. Save is the human-writer step
   and the real security gate; Cancel returns control to Neva.

### Security model (the load-bearing part)

- **Model proposes, never writes.** The only persist path remains the runtime-owned
  `createAgentDefinition()` behind the human confirm — no new write surface reaches the
  registry.
- **Permission ceiling.** Before showing the proposal, `propose_agent` validates the
  drafted `tools` / `disallowedTools` / `permissionMode` against the creating user's
  **effective grants**, computed through the post-#250 consequence-based
  `decide(effect)` model (`agentPermissionModel.ts`). Anything beyond the ceiling is
  dropped (and surfaced, not silently swallowed — see Open questions). The confirm UI
  shows the effective, possibly-clamped capability set.
- **Audit.** Creation writes a creation event to the agent event log (initiator =
  `user`, via = conversational propose), consistent with the self-mod event-log
  requirements.
- **Tool gate.** `propose_agent` itself gets a new permission action kind aligned with
  the #250 model. Because the **human confirm UI is the real gate**, the tool-level gate
  can be light (it only opens a review the user must still approve); the exact default
  decision per safety mode is settled at build with `/security-review`.

### Reuse (no new infrastructure)

- **Write path:** existing `createAgentDefinition()` / `createAgentDefinitionFile()`
  (`agentAuthoring.ts`) — already realpath-jailed and audited.
- **Round-trip:** the `ask_user_question` model→UI→model mechanism
  (`agentAskUserQuestionTool.ts`) — concurrent-run input keyed by `runId` is already
  solved there.
- **UI:** existing `AgentConfigWindow` / `AgentEditor` over `AgentAuthoringInput`
  (`agentTypes.ts`) / `AgentDefinition` (`core/types.ts`) — add a prefilled review mode.
- **Skill registry:** `agentSkills.ts` built-in floor + the `/skillify` precedent.

### Files (anticipated)

- **New:** the `create-agent` bundled skill (body + registration in `agentSkills.ts`);
  `agentProposeAgentTool.ts`; registration in `agentTools.ts` (`createAgentTools`).
- **Changed:** `agentRuntime.ts` (wire the propose round-trip to
  `createAgentDefinition`); renderer `AgentConfigWindow` / `AgentEditor` (prefilled
  review mode); `agentPermissionModel.ts` (new action kind + ceiling clamp, aligned with
  #250).
- **Tests + spec:** `docs/spec/agent-tool-design.md` (the tool + the control point);
  cross-reference the boundary in [[agent-self-modification]]; agent-skills spec if the
  `create-agent` skill needs a note.

### Gate

`typecheck` + `test:core` + `test:renderer` + `docs:check`; **security-sensitive →
`/security-review`** (this is the capability-boundary escalation the program flagged);
new tool + permission action + protocol touch → `/code-review ultra`; confirm UI →
light + dark visual verification.

## Open questions

- **Round-trip shape.** Synchronous round-trip (Neva learns the outcome and can say "I
  created *Research Buddy* for you") vs. one-way "open the prefilled editor" (cheaper,
  but Neva does not get the result back). *Recommendation: synchronous, reusing the
  `ask_user_question` infrastructure.*
- **Ceiling surfacing.** When the draft requests tools beyond the user's grants, clamp
  silently or tell the user "I left out X because you haven't granted it"? *Recommendation:
  surface it, in the confirm UI.*
- **Storage default.** Default new agents to `user` (`~/.agents/agents`) vs `project`
  (`<workspace>/.agents/agents`), with the confirm UI offering the switch? *Recommendation:
  default `user`.*
- **Capture scope.** Should `create-agent` also support "turn this conversation / these
  instructions into an agent" (infer an implicit spec from context), or only explicit
  "build me an agent that does X"? *Recommendation: explicit-only for v1.*
- **Tool-gate weight.** Given the human confirm is the real gate, how light can the
  `propose_agent` permission default be across safety modes? *Settle at build with
  `/security-review`.*

## Implementation checklist (build-order within the one PR)

- [ ] `create-agent` bundled skill (interview → draft → propose workflow).
- [ ] `propose_agent` runtime tool (draft in → confirm round-trip → `createAgentDefinition`).
- [ ] Permission ceiling clamp/validate against the creating user's effective grants (#250 model).
- [ ] Prefilled "review proposed agent" mode in `AgentConfigWindow` / `AgentEditor`.
- [ ] Creation audit event (initiator = `user`, via = conversational propose).
- [ ] New permission action kind for `propose_agent`, aligned with `decide(effect)`.
- [ ] Tests: propose → confirm → create happy path; cancel; ceiling clamp; escalation attempt denied.
- [ ] Spec sync (`agent-tool-design.md` + the [[agent-self-modification]] boundary cross-ref).
