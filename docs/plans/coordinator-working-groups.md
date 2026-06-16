# Coordinator Working Groups — the coordinator creates Channels to organize agents

**Part of the [[agent-program]] (M3 group management).** Give the user-facing **coordinator** a
runtime capability to **create a Channel and add member agents**, so a user can say "set up a
working group for X with the research and writing agents" and the coordinator organizes it —
reusing the exact conversation-creation path the user's Channel config UI already uses.

## Goal

Let the coordinator, on the user's request, **create a multi-agent working-group Channel**: name
it, add the relevant member agents, route it, and announce it in chat. The user asks in natural
language ("organize a group for the Q3 launch with Research and Writing"); the coordinator creates
the Channel, adds the members, and says so. The created Channel behaves exactly like a
user-created one (same membership, coordinator routing, async message bus).

Today Channels are **user-only**: created through the native `ChannelConfigWindow`
(`agentCreateConversation` IPC → `agentRuntime.createConversation()` + `addMember`). The
coordinator has no way to organize a group itself. This plan adds the coordinator's entry,
reusing that runtime path.

## Non-goals

- **Create + add-members only.** Renaming, removing members, and deleting Channels through the
  coordinator are follow-ups; the user already does these in `ChannelConfigWindow`.
- **Coordinator / user-facing agent only.** A delegated `restricted` child does not get this tool
  — organizing groups is a user-facing coordinator act, gated by the wiring flag (the same
  user-facing-only pattern as [[conversational-agent-authoring]]).
- **No new channel/coordinator semantics.** Reuse the existing membership + coordinator-routing +
  async-message-bus model. This plan adds only the create entry, not a new group model.
- **Not auto-organizing.** The coordinator creates a Channel to fulfill an **explicit user
  request**, not proactively/unprompted (which would be channel-spam). The "when to create vs. use
  #General vs. DM" judgment is taught (see Design).
- **Not the always-on shared room.** That is [[default-general-channel]] (#General). This is for
  ad-hoc, topic-scoped working groups — complementary, not a replacement.

## Background — why a tool (and why that is right here)

Unlike [[conversational-agent-authoring]] (where an agent definition is a **file**, so authoring
is a skill + `file_write`), a Channel is **runtime conversation state with no file form** — it
exists only as records in the conversation store, created via `agentRuntime.createConversation()`.
There is no file to write, so the only mechanism is a **runtime tool** that calls the same
`createConversation` + member path the user UI uses. A thin tool over the existing runtime method
is therefore the clean — and only — approach. (The "no new tool" route that fit agent authoring
does not apply: there is nothing to write.)

This also resolves a specific slice of the M3 **"who-configures-whom"** open question that
[[agent-conversation-model]] flagged for PM decision: the answer for *coordinator organizes a
working group* is **yes**.

## Design

### Shape

Shape **(a): ONE complete feature in ONE PR** — the `create_channel` tool + member add + wiring +
the when-to-create guidance + tests + spec. Ships only when "ask the coordinator to organize a
group → the Channel exists with the right members and routes" works end-to-end.

### Mechanism

```text
user: "set up a working group for the Q3 launch with Research and Writing"
  -> coordinator resolves the member agents (by name) from the loaded roster
  -> coordinator calls create_channel({ name, members: [agentId...], topic? })
  -> the tool calls agentRuntime.createConversation() + adds the members
     (the same runtime path ChannelConfigWindow uses)
  -> coordinator announces in chat: "Created #q3-launch with Research and Writing."
  -> the Channel is live: coordinator-routed, async message bus, in the dock
```

### The pieces

1. **Tool `create_channel`** (new, runtime; wired in `createAgentTools` behind an
   `options.channelOrg` flag so only the user-facing coordinator gets it). Input: `name`,
   `members` (agentIds the coordinator resolved from the roster), optional `topic` / initial
   framing. It calls `agentRuntime.createConversation()` with the Channel options + adds the
   members — the exact path `ChannelConfigWindow` uses. Returns the created Channel identity so the
   coordinator can reference / route to it. Reversible (the user deletes it in the existing UI).

2. **When-to-create guidance.** Teach the coordinator to create a Channel only for a **persistent,
   multi-agent working group the user asked for** — otherwise use #General (shared) or a DM (one
   agent). Lives in the tool description (or a small bundled skill — see Open questions). This is
   the anti-channel-spam guardrail.

### Membership & routing

- Members = the chosen agents + the user; the **coordinator routes** (the existing Channel
  coordinator model). Reuse the existing membership primitives — share the `ensureGeneralChannelMembership`
  / add-member path [[default-general-channel]] is consolidating; do **not** fork a second
  membership rule set.
- The Channel is a normal conversation: **no stored `kind`** (the ratified invariant); Channel-ness
  is the reserved-id / runtime invariant, same as today.

### Confirmation & safety

- **No system gate; the coordinator announces in chat.** Creating a Channel is local, reversible,
  and has no external effect, so under [[agent-permission-blacklist-default-allow]] (#277) it is
  **default-allow + audit** — not on any redline or soft-block. The coordinator's "I've created #X
  with A and B" is conversational etiquette (and the user requested it), not a permission prompt.
- **No new autonomy hole.** Channel messages still dispatch runs through the **global gate**, and
  the depth/cycle/concurrency delegation guards still apply to any agent-to-agent activity inside
  the new Channel — same as messaging an existing Channel. Creating the Channel grants the member
  agents **no capability they did not already have**.
- **Audit.** Channel creation emits an event (initiator = `user` via coordinator org), so the user
  can see and undo it.
- **Noise is the real cost, not safety.** The when-to-create guidance + "membership = presence,
  not noise" routing keep agent-organized Channels from cluttering the dock.

### Reuse (no new infrastructure)

- **Create path:** `agentRuntime.createConversation()` + the member-add path that
  `ChannelConfigWindow` / `agentCreateConversation` already use.
- **Routing + async delivery:** the existing coordinator routing + the shipped
  `channel-async-message-bus`.
- **Membership:** the shared membership / ensure path [[default-general-channel]] is consolidating.

### Files (anticipated)

- **New:** `agentCreateChannelTool.ts`; registration in `agentTools.ts` (`createAgentTools` + an
  `options.channelOrg` flag); the when-to-create guidance (tool description or a small bundled
  skill).
- **Changed:** `agentRuntime.ts` (expose the create + member path to the tool — it already owns
  `createConversation`); a creation audit event; possibly a coordinator roster-resolution helper
  (name → agentId).
- **Tests + spec:** `docs/spec/agent-tool-design.md` (the tool + the when-to-create guidance); an
  `agent-conversation-model`-area note that the coordinator may organize working groups (resolving
  that who-configures-whom slice).

### Gate

`typecheck` + `test:core` + `test:renderer` + `docs:check`; new agent tool + conversation-creation
surface → `/code-review ultra`; new model-callable capability → `/security-review`. No new UI ships
(reuses existing Channel rendering), so no visual gate — unless a create-confirmation surface is
added.

## Open questions

- **When-to-create guidance: tool description vs. a bundled skill?** A tool description is leanest;
  a small `organize-group` skill is the `skillify` / `create-agent` pattern and carries richer
  judgment (when a working group is warranted vs. #General / DM). *Recommend: start in the tool
  description; promote to a skill only if the judgment needs more room.*
- **Member resolution.** The coordinator resolves members by name from the loaded roster. What if a
  requested member does not exist or is ambiguous? *Recommend: the tool validates agentIds and
  returns a clear error so the coordinator can ask the user to clarify (normal tool-error →
  conversational repair).*
- **Confirm before create?** Silent default-allow + announce (recommended), or confirm the member
  set in chat before creating? *Recommend: silent + announce — the user asked for it and it is
  reversible; confirm only when the member set is large or ambiguous.*
- **Who routes / does the coordinator add itself?** *Recommend: reuse the existing channel
  coordinator-routing; no special case.*
- **Edit / remove / delete by the coordinator** — follow-up. Confirm create-only is enough for v1.

## Implementation checklist (build-order within the one PR)

- [ ] `create_channel` runtime tool (name + members + optional topic → `createConversation` + add
      members → returns Channel identity), `agentCreateChannelTool.ts` + `createAgentTools` wiring
      behind `options.channelOrg`.
- [ ] Member resolution (name → agentId from the roster) + clear errors for missing / ambiguous
      members.
- [ ] When-to-create guidance (tool description or small skill) — the anti-spam guardrail.
- [ ] Channel creation audit event (initiator = `user` via coordinator org).
- [ ] Reuse the shared membership path (do not fork from `default-general-channel`'s
      ensure-membership).
- [ ] Tests: "organize a group with A and B" → Channel exists, members + coordinator routing
      correct, async bus works; missing member → graceful error; a `restricted` child does NOT get
      the tool; the created Channel grants no new capability (messages still gated).
- [ ] Spec sync: `agent-tool-design.md` + the agent-conversation-model who-configures-whom note
      (coordinator may organize working groups).
