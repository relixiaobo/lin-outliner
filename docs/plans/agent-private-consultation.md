# Agent Private Consultation

Define the architecture model for an agent privately asking another specialist
agent for help, then bringing the result back to the original conversation.

This is a foundational design note, not a research-only plan. It clarifies how
private consultation fits beside skill forks and visible Channels in Tenon's
DM/Channel model.

## Goal

Give Tenon a product and runtime vocabulary for Slack-like agent-to-agent help:
the current agent can privately consult a specialist agent, receive a bounded
answer, and remain accountable for the final reply in the original conversation.
The same private lane can later cover specialist task delegation, but this
document focuses on the advisory/second-opinion shape because that is where the
DM/Channel intuition is most fragile.

The model must preserve these existing invariants:

- Agents are durable Principals with their own tools, skills, model profile, and
  memory line.
- A DM is a one-user/one-agent relationship; it does not silently become a group.
- A Channel is the visible shared room where multiple agents speak to the user and
  each other as members.
- A run anchors to exactly one conversation; execution details live in the run
  ledger, not the conversation log.
- Membership controls cross-principal memory visibility in shared conversations.

## Non-goals

- No userless agent-agent DM implementation in this execution unit.
- No new team/swarm abstraction.
- No broadcast-to-all-agent primitive.
- No cross-machine or remote peer messaging.
- No change to Channel `@` addressing: `@` remains scoped to visible members.
- No change to the generic `/research` recommendation: generic research remains a
  skill/fork capability; specialist consultation is a separate interaction mode.
- No new stored conversation `kind`; DM/Channel remains a derived rendering.

## Research findings

### Tenon current state

Tenon already has the execution pieces:

- `Agent` can start a fresh child run with `agent_type`, or a fork when
  `agent_type` is omitted. Fresh children execute as the selected agent
  definition; forks execute as the parent agent.
- Fresh child agents use their own agent identity and memory owner. Forks inherit
  the parent agent's memory owner.
- Child runs are ordinary runs with their own run ledgers, linked to the parent by
  `parentRunId` / `parentToolCallId`; child tool noise is not inlined into the
  parent conversation.
- `AgentSend`, `AgentStatus`, and `AgentStop` already address same-conversation
  background child runs.
- The renderer already has child-run boundary rows, task details, and "view full
  run" affordances.

Tenon also has the social model:

- DMs are 1:1 agent relationships and cannot be membership-edited.
- Channels are named rooms with visible agent members, `@` routing, per-agent POV,
  and completion-order delivery.
- A Channel member's runtime assembly sees the Channel through a member POV, and
  co-member memory visibility follows membership.
- Fresh child sidechains are not conversation members. They do not make the
  consulted agent a visible participant in the source conversation.

The missing piece is not raw execution. The missing piece is product semantics:
when a fresh child run is "private consultation" rather than just "a delegated
task", how that is exposed, audited, permissioned, and bounded.

### cc-2.1 reference points

cc-2.1 is useful as a behavior reference, not as a product model to copy.

Borrow:

- fresh specialists need a full brief because they do not inherit parent context;
- forks are for isolated use of the current agent's context;
- multiple independent specialists can be launched in parallel;
- the parent must not fabricate or summarize child results before they return;
- long-running agents can receive queued follow-up messages and resume from a
  transcript;
- private messages must be explicit tool calls; plain output is not magically
  visible to other agents.

Do not copy:

- team/swarm as a first-class product layer;
- broadcast to all teammates;
- cross-session or cross-machine messaging;
- shutdown/plan-approval mailbox protocols;
- hidden team-lead governance;
- userless teammate panes as the primary UI model.

## Design

### 1. Keep interaction modes distinct

Tenon needs these modes to stay separate because each creates a different user
expectation:

| Mode | Runtime shape | Product meaning | Use when |
|---|---|---|---|
| Skill fork | Same agent, `context: fork`, isolated child run. | "I used one of my own capabilities off-thread." | Generic research, verification, summarization, formatting, inspection. |
| Private consultation | Fresh child run with a target agent identity, recorded as consultation. | "I privately asked a specialist, then brought the result back." | Second opinions, security/design/domain review, specialist memory/tools. |
| Private delegated task | Fresh child run with a target agent identity, recorded as delegated work. | "I privately asked a specialist to do work for me." | Test running, focused implementation, artifact production, command execution. |
| Channel invitation | Target agent is a visible conversation member. | "This agent joined the room and can speak here." | Multi-party discussion, visible disagreement, ongoing collaboration. |

The important distinction is not whether a child run exists. All three may use
run ledgers. The distinction is what social claim the UI and runtime make:

- a skill fork is the current agent thinking elsewhere;
- a consultation is the current agent asking a colleague elsewhere;
- a delegated task is the current agent assigning work elsewhere;
- a Channel is multiple colleagues sharing the same room.

Not every fresh `Agent(agent_type)` call is a consultation. Some are ordinary
private delegated tasks. Consultation is the advisory case where the target
agent's judgment is the product; delegated task is the execution case where the
target agent's work product is the product.

### 2. Define consultation as a run relationship, not a new conversation kind

The first implementation should model consultation as a specialized fresh child
run, not as a new userless Conversation.

That preserves the current data model:

- `Conversation` stays the objective source thread.
- `Run` stays the execution unit.
- `parentRunId` / `parentToolCallId` stay the hierarchy.
- `agentId` / `memoryOwnerAgentId` on the child identify the consulted agent.
- No stored DM/Channel `kind` is introduced.
- The consulted agent is not added to source conversation `members`.

The child run needs additional semantic metadata, either stored directly or
derived from a stable event field:

```ts
privateDelegation?: {
  callerAgentId: string;
  targetAgentId: string;
  sourceConversationId: string;
  purpose: 'consultation' | 'task';
  visibility: 'boundary-visible-details-inspectable';
}
```

This metadata is not a new primitive. It is a label over an existing run
relationship so renderers, task panels, permission cards, and future analytics can
distinguish "consulted @reviewer", "assigned @test-runner", and "forked a
worker".

### 3. Source conversation rendering

In the source conversation, a consultation should render as a boundary row, not as
a message from the consulted agent.

Recommended rendering:

```text
@assistant consulted @security-reviewer · completed
View consultation
```

The final answer remains the caller's reply. The caller may cite the consultation:

```text
I checked this with @security-reviewer. Their main concern was ...
```

The consulted agent does not appear as a Channel speaker unless it is actually a
Channel member. This preserves the user's mental model: the specialist helped
privately, but did not join the room.

Delegated-task copy should use a different verb:

```text
@assistant assigned @test-runner · running
View task
```

That avoids overloading "consulted" for execution work while keeping both shapes
on the same private delegation lane.

### 4. Consultation context assembly

A consulted fresh agent should not inherit the caller's full transcript by
default. The caller must write a brief like a colleague walking into the room.

The consulted agent receives:

- the caller's task brief;
- explicit source snippets or references the caller chooses to include;
- ambient outline/file access allowed by the target agent's tools;
- the target agent's own system prompt, skills, model/effort, tools, and memory;
- the user's memory pool if the current single-user trust model already makes it
  readable to the target agent.

The consulted agent should not automatically receive:

- the caller agent's private memory pool;
- the source DM's raw transcript;
- Channel co-member memory from a room the consulted agent has not joined;
- raw evidence from another principal's memory entries;
- hidden tool output from the caller's run.

If the caller wants the specialist to see exact context, it forwards or summarizes
that context in the brief. This matches the existing "new Channel onboarding"
rule: private transcripts do not cross boundaries automatically.

### 5. Result and accountability

The consulted agent returns an advisory result. The caller decides what to do with
it. A delegated-task agent returns work output or an artifact reference, but the
caller still decides how to present it in the source conversation.

Rules:

- The caller remains responsible for the final answer in the source conversation.
- The caller must not claim a result before the consultation has completed.
- If the consultation fails, the caller reports the failure or chooses a different
  path; it should not silently invent the specialist's opinion.
- If the consulted agent produces an artifact, the result should point to the
  artifact's natural container, not dump large output into the parent context.
- The consultation report should separate direct findings, confidence, caveats,
  and recommended next steps.

### 6. Permissions and safety

Private delegation is higher risk than a same-agent fork because it crosses
principal identity and can use another agent's tools, skills, and memory line.

Required rules:

- `disabledAgents` blocks consultation with that agent.
- The target agent's tool allow/deny profile applies structurally.
- The caller cannot use consultation to gain tools it would be forbidden to use
  directly unless the permission model explicitly allows that delegation.
- Existing depth/cycle guards apply.
- Background consultations are cancellable and visible in the task/run panel.
- Permission requests from the consulted agent are attributed to that agent and
  surfaced in the source conversation's approval UI.
- Raw consultation transcript is inspectable by the user through run details, but
  is not injected into the source conversation transcript by default.

The permission model may need a distinct action kind such as
`agent.consult.spawn`, even if the first implementation routes through the current
`agent.delegate.spawn` machinery. The distinction matters for settings copy:
"allow this agent to fork itself" and "allow this agent to consult @security" are
different user expectations.

### 7. Follow-up messages

Tenon already has `AgentSend` for same-conversation child runs. Consultation can
reuse that execution path, but the product copy should follow the delegation
purpose:

- "Send follow-up to consultation" while running or resumable.
- "Resume consultation with @reviewer" after a stopped/completed background run
  when the transcript is still retained.
- "Send follow-up to @test-runner's task" for delegated work.
- "Start a new consultation" when the old run is no longer resumable or the task
  has materially changed.

This is not the same as opening the target agent's canonical DM. A consultation
follow-up continues the private run attached to the source conversation; a DM
message starts or continues the user's direct relationship with that agent.

### 8. Memory effects

The target agent may later distill its consultation run into its own memory,
subject to the existing Dream/memory rules.

The caller does not automatically gain the target's memory. It only receives the
consultation result. If the result is useful, the caller may remember its own
lesson through the normal memory pipeline.

Consultation transcripts should be valid evidence for the consulted agent's own
memory because the consulted agent authored that run. They should not become raw
evidence for the caller unless the caller's own run records the result and later
Dreams that result.

### 9. Relationship to `/research`

Generic `/research` should remain a built-in skill/fork because it is the current
agent using a generic capability. It does not need a durable specialist identity.

Private consultation is appropriate when the task needs a real specialist's
judgment:

- "Ask @security-reviewer whether this permission model is safe."
- "Get @designer's critique of this interaction."
- "Ask @database-expert for a second opinion on this migration."

The same user phrase can choose different modes depending on target:

- "research this module" -> skill fork;
- "ask the reviewer to research this module" -> private consultation;
- "ask the test-runner to verify this module" -> private delegated task;
- "@reviewer what do you think?" in a Channel -> visible Channel turn.

## Potential execution units

This design can ship as a set of independent complete features.

### Feature A — Private delegation semantics over existing fresh child runs

One PR can add the smallest product-complete layer:

- add an explicit private-delegation purpose, either as an optional `Agent` input
  field or as equivalent runtime metadata set by the caller path;
- keep the default compatible with existing fresh child runs so command/test
  delegation does not get mislabeled as advisory consultation;
- render consultation and delegated-task boundary copy distinctly from generic
  fork copy;
- update `Agent` tool guidance to teach skill fork vs consultation vs Channel;
- add tests that a consulted agent is not added to conversation members and its
  result returns only through the boundary/tool result.

This feature reuses existing `Agent`, `AgentSend`, `AgentStatus`, and `AgentStop`
tools. It does not add an agent-agent DM.

### Feature B — Private-delegation permissions

A later PR can split permission semantics:

- add `agent.consult.spawn` and/or `agent.delegate.task.spawn` classifier actions;
- expose settings copy that distinguishes self-forking from consulting another
  agent or assigning another agent work;
- test disabled-agent and permission-denied paths;
- ensure child permission requests bubble with target-agent attribution.

### Feature C — Durable agent-agent DMs, only if needed

If users want long-lived private relationships between agents, design it
separately. It is larger because it may require conversations whose member set is
two agents and no user, or a special owner-visible private thread.

That future design must answer:

- whether the user is a member, an owner/inspector, or both;
- how membership-scoped memory reads work without accidentally sharing raw
  private user DMs;
- whether agent-agent DMs appear in the user's conversation list;
- how retention, search, forwarding, and delete/archive work;
- how the UI prevents confusion with user-agent DMs and Channels.

Do not block Feature A on this larger model.

## Open questions

- Should v1 store explicit private-delegation metadata, or derive
  consultation from `contextMode === 'fresh'` + `parentRunId` + target agent
  identity? Recommendation: store explicit purpose metadata
  (`consultation | task`) so UI and permissions do not depend on brittle
  inference.
- Should consultation use the existing `Agent` tool or a new `ConsultAgent` tool?
  Recommendation: keep `Agent` for v1 and improve guidance/rendering. Add a
  separate tool only if model behavior proves ambiguous.
- Should a consulted agent be allowed to ask the user questions directly?
  Recommendation: route questions through the caller or show them as attributed
  consultation permission/question cards in the source conversation; do not let
  the specialist silently take the floor.
- Should the target agent read the caller agent's distilled memory by default?
  Recommendation: no. The caller should brief or forward what is relevant.
- Should consultation runs be visible in the source transcript by default?
  Recommendation: yes as a compact boundary row, with details inspectable.

## Collision check (2026-06-13)

Open PRs reviewed:

- #232 `codex-3/research-agent-skill-plan` adds a separate `/research` skill plan.
  This document intentionally keeps consultation separate from generic research.
- #231 `cc/channel-async-message-bus` changes Channel runtime/projection/UI. This
  document should avoid editing Channel code until that PR lands.
- #230 `codex-3/skillify-upgrade-plan` is plan-only under
  `agent-skills-authoring.md`; no file overlap.
- #229 `cc-2/agent-workdir-relocation` changes file/workdir boundaries and
  permission-adjacent code. Consultation implementation must re-check tool roots
  after that lands, but this document is plan-only.

This plan PR should touch only this file. Main can decide whether to place it on
the board, merge it as a discussion foundation, or redirect it into a broader
agent-architecture plan.

## Verification

For this document PR:

- `git diff --check`
- `bun run docs:check` is expected to fail until main adds this plan to
  `docs/TASKS.md` or rejects the plan, because dev agents do not edit the
  main-owned board.

For the first implementation PR:

- `bun run typecheck`
- `bun run test:core -- agentRuntimeChildRuns agentChannel agentRenderProjection`
- `bun run docs:check`
- visual verification only if renderer copy/rows change beyond existing
  child-run boundary components.
