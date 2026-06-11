---
status: draft
priority: P2
owner: codex-2
created: 2026-06-11
updated: 2026-06-11
---

# Agent Conversation UX: Agent Choice, DMs, Channels, Identity

**Shape: (b) a set of independent complete features.** This document is a
review proposal only; it ships no product code. The implementation should land
as one or more complete UX features, not as scaffolding.

## Goal

Make agent conversations feel like a simple messaging product:

- the user chooses **who** they want to talk to;
- the product makes **DM vs Channel** obvious before anything is created;
- each reply clearly shows **which agent** answered and which configured model
  profile it used;
- models are configured on agent profiles ahead of time, not casually changed
  from inside a DM message flow.

The current mechanics are functionally correct after M3-A, but the interaction
still exposes implementation seams: the header `+` can feel like it mutates a DM,
the conversation picker is Channel-shaped, and the composer model menu makes the
agent identity feel less stable than the product model intends.

## UX Principles

1. **People first, transport second.** The primary object in the UI is an
   agent/persona, not a model or a conversation-kind implementation detail.
2. **DMs are relationships; Channels are goals.** A one-agent DM is opened, not
   named. A Channel is named because it has a goal and a roster.
3. **No surprise conversion.** Adding an agent while viewing a DM must explicitly
   create a new Channel. The DM remains private and unchanged.
4. **Identity is visible, not decorative.** Avatar, display name, `@mention`, and
   model metadata explain who produced a message. The visual treatment stays
   quiet and native-feeling.
5. **Model choice belongs to the profile.** The message surface can display the
   model, but it should not encourage per-chat ad hoc model swapping for DMs or
   Channels.

## Recommended Product Experience

### Start Conversation

Replace the current "Channels-first" creation mental model with one
conversation starter:

1. The agent header exposes a compact **New message** action.
2. Activating it opens a small popover/sheet with a `To:` search field over agent
   profiles.
3. Selecting exactly one agent offers **Open DM**. This opens that agent's
   canonical DM.
4. Selecting two or more agents changes the action to **Create Channel** and
   reveals a required Channel name/goal field plus an optional seed note.
5. The same starter is used from a DM's "add agent" path, but with the current DM
   agent preselected and clear Channel semantics: the original DM is not shared
   or converted.

This is the clearest model for users: choose recipients first; the product
derives whether it is a DM or Channel.

### Conversation List

Render the list as two sections:

- **Direct Messages**: one row per agent DM, using the agent avatar, display
  name, and model/profile subtitle. DM rows are not rename/delete targets.
- **Channels**: one row per goal Channel, with the title, small member avatars,
  message count/time, unread badge, and rename/delete actions.

The current "show channels" label is correct for the existing data surface, but
the best user experience is a single conversation switcher that contains both
DMs and Channels.

### Header And Member Management

In a DM header:

- show the agent avatar, display name, `@mention`, and profile model subtitle;
- show a **Create Channel with...** action instead of an ambiguous member `+`;
- do not show a member strip for the single agent unless it is useful as compact
  identity.

In a Channel header:

- show the Channel title as the primary label;
- show member avatars/mentions as secondary context;
- keep member management behind a **Members** popover with add/remove actions;
- disable removal of the coordinator and removal during active rounds, matching
  runtime rules.

### Message Stream Identity

Every assistant message row should carry speaker metadata derived from the
durable record:

- avatar: deterministic derived avatar from `agentId` for v1;
- name: display name from the agent profile, with `@mention` as fallback;
- model: provider/model used for that run, rendered as subdued metadata;
- status: streaming/failed/retry remains on the row, not in a separate identity
  system.

Channel rows already have name-level attribution for non-coordinator speakers.
The next step should make identity uniform across DMs and Channels: a DM reply is
still an agent reply, not an anonymous assistant bubble.

This proposal should subsume or extend the existing `agent-avatar-v1` backlog
item: avatar-only identity is useful, but the user need is broader than a chip.
It is avatar + name + model + stable profile context.

### Model Configuration

The composer should not be the primary place to change a DM agent's model.

Recommended behavior:

- Agent Profiles owns model/effort/tool/skill settings.
- The composer displays the active profile model as read-only metadata or a
  link/shortcut to profile settings.
- For user/project agents, the existing `model` and `effort` fields on
  `AgentDefinition` remain the source of truth.
- For the built-in assistant, expose an equivalent "Default Assistant" profile
  setting before removing the last editable composer model path. Until that is
  available, the current provider model remains a fallback, but the UX should
  move toward profile-owned configuration.
- Skills may still carry scoped model/effort overrides during execution; those
  are capability-level behavior, not casual chat-surface selection.

## Implementation Boundaries

### Feature A: Conversation Starter And List Polish

Complete feature: the user can start an agent DM or create a Channel from one
recipient-first flow.

Likely touched files:

- `src/renderer/ui/agent/AgentChatPanel.tsx`
- `src/renderer/ui/agent/AgentComposerEditor.tsx` if the `@` member picker is
  reused
- `src/renderer/styles/agent-dock.css`
- `src/core/i18n/messages/en.ts`
- `src/core/i18n/messages/zh-Hans.ts`
- e2e coverage under `tests/e2e/agent-composer.spec.ts`

If implementation includes arbitrary-agent DMs, it also touches runtime
conversation semantics:

- `src/main/agentRuntime.ts`
- `src/core/types.ts` / `src/core/agentTypes.ts` only if new IPC/view shapes are
  needed
- conversation-list tests in `tests/core/agentRuntimeConversations.test.ts`

That means "choose any agent for DM" is **not purely renderer polish** in the
current code. Today the canonical DM path is keyed to the built-in assistant;
making one canonical DM per agent is product-correct, but it is a small runtime
feature and should be reviewed as such.

### Feature B: Speaker Identity In Message Rows

Complete feature: every assistant row shows the speaker identity and model used.

Likely touched files:

- `src/core/agentRenderProjection.ts`
- `src/renderer/ui/agent/AgentMessageRow.tsx`
- `src/renderer/ui/agent/AgentMessageFrame.tsx`
- `src/renderer/ui/agent/AgentChatPanel.tsx`
- `src/renderer/styles/agent-message.css`
- renderer/e2e tests for DM and Channel rows

This can stay mostly UI/projection-level because M3-A already gives message
records an `actor`, and assistant-message start events already carry
provider/model ids. If the projection lacks a convenient row-level metadata
field, add the smallest derived field rather than changing stored events.

### Feature C: Profile-Owned Model UX

Complete feature: the conversation surface no longer teaches users to set the
agent model ad hoc during a DM.

Likely touched files:

- `src/renderer/ui/agent/AgentComposerControls.tsx`
- `src/renderer/ui/agent/AgentComposerModelMenu.tsx`
- `src/renderer/ui/agent/AgentSettingsView.tsx`
- `src/renderer/ui/agent/AgentEditor.tsx`
- provider/model settings tests

The safe sequence is:

1. make model identity visible on rows and headers;
2. make Agent Profile model/effort configuration discoverable and polished;
3. convert the composer model control into read-only status + settings shortcut
   for DMs/Channels;
4. only then remove or de-emphasize the editable chat-surface model menu.

## Non-goals

- No cross-agent memory sharing; that is M3-B.
- No per-agent POV inspector; that is M3-C.
- No concurrent Channel execution.
- No DM transcript forwarding into a Channel. The seed note remains explicit and
  shared; private DM history stays private.
- No v1 custom avatar/icon field in `AGENT.md`. Use deterministic derived
  avatars first; a file-format addition can be revisited later.
- No per-message model override UI.

## PM / Main Review Questions

1. **Should arbitrary-agent DMs ship now?** Recommended: yes. The intended model
   already says each agent has one continuous DM; the UI should not permanently
   encode "only the built-in assistant gets a DM." This is not pure UI, so it
   should be a plan-track implementation.
2. **Should `agent-avatar-v1` be folded into this broader identity work?**
   Recommended: yes. Avatar-only is a partial answer; the row needs name and
   model metadata too.
3. **How aggressive should the composer model cleanup be in the first PR?**
   Recommended: do not remove the editable control until the built-in assistant
   has a clear profile-owned model setting. First make profile ownership visible;
   then demote the composer control.

## Acceptance

- A user can open a DM by choosing one agent from a searchable starter.
- A user can create a Channel by choosing multiple agents, naming the goal, and
  optionally adding a seed note.
- Adding an agent from a DM explicitly creates a new Channel; the original DM is
  unchanged.
- DM and Channel message rows show agent avatar, display name/mention, and model
  metadata.
- Channel rows preserve historical attribution after member removal.
- The composer does not present model selection as the central DM interaction.
- Light and dark visual checks pass for the starter, conversation list, headers,
  identity rows, and compact/narrow panel widths.
- `bun run typecheck` plus relevant core/renderer/e2e tests pass.

## Collision Self-check

Checked 2026-06-11 from `lin-outliner-codex-2`:

- Open PRs: #196 `pinned-drag-drop` touches sidebar drag/pin behavior, not agent
  conversation UI.
- This proposal PR touches only this plan document.
- Future implementation likely overlaps with agent UI files and possibly
  `agentRuntime.ts` if arbitrary-agent DMs are included. Re-run `gh pr list` at
  claim time before implementation.
