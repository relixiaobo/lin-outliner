---
status: draft
---

# Default #General Channel - the shared room for durable peer agents

Create a Slack-like `#General` Channel as the default shared room for the user and
all durable peer agents. The Channel exists by default, new peer agents join it
automatically, and the Agent Dock can open into it without the user first creating
a Channel.

This extends [[agent-conversation-model]] and [[agent-architecture]]. It is a
plan-track change because it changes user-visible Agent Dock behavior and the
conversation membership lifecycle.

## Goal

- Every workspace has one default Channel named `#General`.
- `#General` starts with the user and the coordinator agent.
- Every future durable peer agent is automatically added to `#General`.
- The Agent Dock defaults to `#General` when there is no remembered last
  conversation.
- Membership means presence, addressability, and access to shared Channel context.
  It does **not** mean default participation, default listening, or default
  notification.
- Unaddressed messages in `#General` route to the coordinator, just like any other
  Channel.

## Non-goals

- No built-in functional agent identities such as "Researcher", "Reviewer",
  "Builder", or "Planner". Agents are human-like durable identities, not job
  slots.
- No new `Coordinator` entity. The coordinator is the default-addressed agent in a
  Channel, currently the main assistant identity.
- No stored conversation `kind`. `#General` is a normal named Conversation with a
  reserved identity and invariant membership behavior.
- No implicit all-agent broadcast. `@all` is deliberately deferred unless the PM
  decides it belongs in this first feature.
- No migration or backward compatibility burden. Pre-release development data can
  be wiped if the stored shape needs a clean cut.

## Product definition

Slack's `#general` is the closest mature precedent: full workspace members are
automatically present in a default public room, but notifying everyone still
requires an explicit address such as `@everyone`. The useful distinction is:

| Concept | Slack | Tenon |
|---|---|---|
| Default shared room | `#general` | `#General` |
| Auto-membership | full workspace members | durable peer agents |
| Cannot disappear as a normal room | protected general channel | runtime ensures default Channel exists |
| Broadcast | explicit `@everyone` | future explicit `@all` |
| Normal message | visible in the room | routed to coordinator unless addressed |

The product rule is therefore:

> `#General` is the default shared Channel for the user and all durable peer
> agents. New peer agents are automatically added. Membership gives an agent
> shared-room presence and makes it addressable; it does not make the agent answer
> every message. Broadcast must be explicit.

## Design

### 1. `#General` is a normal Channel with a reserved identity

The specialness lives in the runtime invariant, not in the data model:

- Add a reserved default Channel id, e.g. `lin-agent-channel-general`.
- Store it as the same Conversation shape used by other named Channels.
- Keep the title as `General`; the UI renders the Channel affordance as
  `#General`.
- Do not add `kind: "general"` or `kind: "channel"` to the stored record.

The default Channel should be protected from ordinary deletion. A later rename
policy can be designed separately; v1 should keep the name fixed to avoid
breaking the user's mental model.

### 2. Runtime ensures `#General` exists

On agent runtime initialization, after the coordinator identity and visible agent
roster are known:

1. Find `lin-agent-channel-general`.
2. If missing, create it with user + coordinator members.
3. If present, ensure the user and coordinator are still members.
4. Ensure every durable peer agent in the active roster is a member.

The operation must be idempotent. Re-running it on every startup or roster reload
must not append duplicate `member.added` events.

### 3. Durable peer agents auto-join

Auto-membership applies to visible, durable peer identities:

- the built-in main assistant;
- user-authored agents;
- project-authored agents loaded into the current workspace;
- future built-in human-like peer agents, if the product ships any.

Auto-membership does **not** apply to:

- fork runs;
- child/delegation runs;
- headless workers;
- transient implementation helpers.

Any agent creation or reload path that makes a peer agent addressable must call
the same `ensureGeneralChannelMembership` path. This keeps conversational agent
authoring and file/project agent loading from growing separate membership rules.

Deletion or unavailability should remove the agent from the active addressable
roster while preserving historical speaker attribution. If a disabled-agent state
exists later, the UI can show the historical member as unavailable rather than
pretending it is still runnable.

### 4. Routing remains quiet by default

`#General` follows the existing Channel routing model:

- user message with no mention: route only to the coordinator;
- user message with `@agent`: route to the mentioned agent or agents;
- agent reply with `@agent`: hand off through persisted addressing;
- future `@all`: explicit all-member fan-out, likely with confirmation or a
  rate/noise guard.

This is the load-bearing behavior that prevents auto-membership from becoming
auto-noise.

### 5. Agent Dock behavior

Agent Dock selection should use this priority:

1. the remembered last valid DM or Channel;
2. `#General`;
3. coordinator DM as a defensive fallback only if `#General` cannot be restored.

The Channels section should show `#General` as the stable first Channel. DMs remain
available as private relationship spaces with individual agents.

The roster UI should communicate presence and addressability without implying that
every agent is currently participating. Mention typeahead should naturally include
`#General` members once there is more than one agent member.

### 6. Memory and privacy boundary

`#General` is a public shared room inside the workspace:

- its conversation transcript is shared Channel context;
- co-member semantic memory sharing follows the existing membership-scoped rule;
- raw private evidence never crosses principals;
- DM transcripts remain private to their members;
- a newly added agent can read the public `#General` context, but should not be
  represented as having been present before it joined.

This preserves the current architecture: conversation logs are the objective
record; each agent owns its own memory line; cross-agent sharing is distilled and
membership-scoped.

## Shape and build order

**Shape: (a) one complete feature in one PR.** The implementation should land as a
single independently verifiable feature, with the following internal build order:

1. Add the reserved `#General` Channel identity and idempotent ensure routine.
2. Integrate the ensure routine with runtime startup and peer-agent roster
   changes.
3. Update Agent Dock default-selection and Channel list behavior.
4. Add deletion/unavailability handling for active membership.
5. Update specs and tests.

Do not ship a partial PR that only creates a hidden Channel without making the
default Dock experience and auto-membership behavior work.

## Likely files

- `src/main/agentRuntime.ts` - conversation creation, coordinator lookup,
  membership replay, roster integration, default selection data.
- `src/core/agentChannel.ts` - mention/addressing invariants if `#General`
  exposes any missing edge case.
- agent authoring / agent definition loading entry points - call the same
  auto-membership ensure path when a durable peer appears.
- `src/renderer/ui/agent/AgentChatPanel.tsx` - Agent Dock default selection,
  Channel ordering, roster affordances.
- renderer runtime store tests - remembered conversation should win over
  `#General`; missing remembered conversation should fall back to `#General`.
- core/runtime tests - idempotent creation, auto-membership, quiet routing, and
  non-membership for child/fork agents.
- `docs/spec/agent-architecture.md` and related agent conversation spec - fold
  the final behavior into the current intended model.

## Validation

- `bun run typecheck`
- focused runtime tests covering:
  - startup creates `#General`;
  - repeated startup does not duplicate membership events;
  - new durable peer agents auto-join;
  - fork/child/headless agents do not auto-join;
  - unaddressed `#General` messages route only to the coordinator;
  - `@agent` routes only to the addressed peer;
  - remembered Agent Dock selection wins over the default Channel.
- focused renderer tests for Agent Dock selection and Channel list ordering.
- existing renderer/core suites touched by the implementation.

## Coordination and collisions

- `#251` (`cc-2/conversational-agent-authoring`) is conceptually adjacent: any
  conversational "create an agent" flow should use the same auto-membership
  routine. The implementation PR should either land after that plan's interface is
  clear or coordinate on the shared helper first.
- Agent context architecture work may affect prompt/environment assembly, but
  `#General` should not need a new context primitive. It should consume the
  existing Channel environment reminder.
- The recently merged remembered-conversation behavior should be treated as the
  selection baseline: remembered valid selection first, `#General` second.

## Open questions for PM/main review

- Should `@all` be explicitly out of this first PR, or does the first `#General`
  feature need a broadcast affordance to feel complete?
- Should v1 make `#General` non-renamable, or should owners be allowed to rename
  it while preserving the reserved identity?
- When an agent is deleted, should the current member edge be removed immediately,
  or should the member remain visible as unavailable until the next compaction /
  cleanup pass?
- Should user-level agents join every workspace's `#General`, or only the active
  workspace where they become addressable? The recommended default is active
  workspace only.
