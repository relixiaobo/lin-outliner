# Single-agent collapse — one customizable agent, channels only, one memory

Subtract the multi-agent apparatus down to the model the product actually needs:
**one user-facing agent (Neva), customizable; Channels as the only conversation
primitive; one first-person memory; the outline as the product.** Pre-release,
no users — so this is a clean teardown, **no migration / back-compat / legacy
readers** (on a format change, wipe `~/.lin-outliner-*` dev userData and delete
the old reader).

## Goal

- **One user-facing agent: Neva.** No multi-agent. The agent that helps the user
  is always the same one. Neva is **user-customizable** (identity + capability
  authored; memory accumulated) — not a hardcoded built-in.
- **Channel is the only conversation primitive.** Each Channel = an isolated
  discussion/execution context (a workstream). Default `General` + user-created
  topic Channels. **No DM concept.** Because each Channel has exactly one agent,
  **inline streaming + steering are universal** and there is no nav-lock.
- **One first-person memory, bound to the agent.** Neva's knowledge ("what I
  know"), broad — the user-model ("对你的认知") is one region of it, not the whole.
  Fed by a single Dream over the agent↔user interactions. **No self-persona pool,
  no per-principal pools, no transactive/membership machinery.**
- **Three surfaces, three jobs:** **Outline** = the product (work, key process,
  outcomes; human + agent write). **Channel** = isolated context (raw stays
  local). **Memory** = continuity (distilled, global to the agent). `Run` = an
  execution within a Channel.

## Non-goals

- **Multi-agent / teams.** Removed, not hidden. If a team is ever wanted, it
  re-enters as "add a member to a Channel" over the single-primitive model — no
  paradigm rework. Not built here.
- **A self-persona memory.** The agent's identity/persona/capability is
  **authored** (profile + governed self-config), never dreamed. Behavioral
  self-signals surface as governed config *suggestions* to the user, not silent
  self-memory.
- **Back-compat / migration.** None (pre-release).

## Design

### Load-bearing invariants (write these into `spec/`)

1. **Per-channel is *environment*, not *agent*.** Each Channel carries its own
   environment info (its content/history + the relevant ambient-outline focus);
   the **same** agent reads whichever Channel it is in, so behavior varies by
   environment — but **capability (model/tools/skills/persona) never forks.** A
   Channel may hold behavior-flavored context *text*; it never holds a second
   configured agent.
2. **Channel manages *context*; Memory manages *knowledge*.** Channel isolates
   the **raw/active** context (reasoning quality, no topic-bleed). Memory is the
   agent's **distilled** knowledge, global across Channels. Raw stays local; only
   distilled crosses. Channels are context boundaries, **not secrecy boundaries**.
3. **Memory is the agent's first-person knowledge.** "About the agent" = the
   agent is the *knower/owner*, not that facts describe the agent's persona.
   Content = `model-of-you` + `knowledge-of-your-work/domain/conclusions` (minus
   what the outline already records). The agent's persona is **not** in memory.

### Conversation model

- **One primitive, rendered one way.** Drop `canonicalDmAgentId` and the
  DM/Channel rendering split (`src/core/types.ts:758`, `agentChannel.ts`
  `isChannelConversationId`/`usesChannelActivitySurface`). Every conversation is a
  single-agent Channel. `General` stays the default landing (undeletable, sorts
  first); user creates/renames/deletes topic Channels (members not editable —
  membership is implicitly `{user, Neva}`).
- **Behavior unified (DM's hand-feel becomes the only hand-feel).** Inline
  streaming always (`agentRenderProjection.ts:465` — drop the `!channelSurface`
  gate); steering always; **no nav-lock** (drop `dmRunActive` lock, Slack-like:
  the stream continues, surfaces via the transcript / unread). Collapse
  `dmRunActive` + `channelRunsActive` → one `runActive`.
- **Per-channel environment info** (invariant 1): a lightweight topic/context note
  per Channel that the one agent reads. Context only, never capability.

### Agent (Neva) — customizable single identity

- Today Neva is `source:'built-in'`, read-only; the user must *duplicate* to
  customize (`agentDelegation.ts:1484` `createTenonAssistantAgentDefinition`,
  `AgentEditor.tsx:83`). Make the single agent **directly editable** (name /
  persona / system prompt / model / effort / skills / tools) through the existing
  `AgentConfigWindow`/`AgentEditor`/`AgentSettingsView` surface.
- **Stable internal id ≠ editable display identity.** Keep `assistant` as the
  stable memory anchor; name/persona/avatar/model/skills are editable on top.
  Renaming Neva must not orphan her memory. `@handle` loses its user-facing
  addressing role (no one to @) and demotes to internal id only.
- **Conversational self-config** stays (governed/audited; `config` /
  `agentSelfMaintenanceTools.ts`): "be terse / change your model / you're called
  Lin" edits the profile. Local instructions live in the Channel's environment;
  standing-config changes are global.

### Memory — one pool, one Dream, first-person

- **Collapse to one believer-keyed pool = Neva's knowledge.** Remove
  per-principal pools (`principalKey`, `principals/<dir>/`, the self/co-member
  zone split in `agentMemoryBriefing.ts`). "对你的认知" = relational facts in
  Neva's own pool. `memoryIsolation` (`global`/`read-only-global`) becomes moot —
  remove it.
- **One Dream.** Cut `dreamPoolAgent` ("Assistant self-model") and the
  agent-self-Dream path; keep only the user-directed Dream ("About you").
  Reflective-run anchoring simplifies (only one pool to maintain).
- **Layering (academic, per `agent-memory-foundations.md`), as applied here:**
  *world record* (raw conversation/run ledgers, below memory) → **L1 working**
  (per-turn assembly / resident briefing) · **L2 episodic** ("我们之间发生的事":
  episode units + memory-owned gist) · **L3 semantic** (Neva's knowledge,
  one pool) · **L4 procedural** (skills — *authored*, not dreamed). Connective:
  *index* (fact↔episode pointers) + *schema/overview*. Zoom ladder: schema → fact
  → episode gist → raw span.

### Dream / run surfacing → Settings → Agent

- Durable Dream records are **already** principal/agent-keyed
  (`agentEventStore.ts:407` `principals/.../memory/…`) — **not** in any
  conversation. Only the *user-facing surfacing* lives in the conversation today
  (`dream.finished` boundary + `notification.created` anchored to a conversation;
  the task-panel dream entry). With DM gone, **relocate the surfacing** to a new
  **"Memory & activity" panel in Settings → Agent**: Dream history (only "About
  you" now), memory entries (inspect / correct / forget), run/task history. This
  is a *rendering* move, not a storage migration.

## The teardown inventory

**Delete — pure multi-agent** (verified decoupled): coordinator
(`agentRenderProjection.ts` coordinator flag, `AgentChatPanel.tsx:1027`); member
roster + `@`-routing + typeahead (`agentChannel.ts` mention/handoff,
`AgentComposerEditor.tsx`, `ChannelConfigWindow` member add/remove); POV /
independence cut (`agentChannel.ts:130-323`, POV inspector); channel activity
surface (`ChannelWorkingRow`/`ChannelWorkingDetail`, `channelActivityEntries`,
`usesChannelActivitySurface`); channel org tools (`agentChannelTools.ts` whole
file, `agentTools.ts:238` `channelOrg`); channel permission gates
(`agentPermissionModel.ts:213`); channel environment reminder
(`agentConversationEnvironmentReminder.ts`, refactor to single-agent env);
parallel-channel runtime.

**Delete — DM concept:** `canonicalDmAgentId` (`types.ts:758`), `lin-agent-dm-`
prefix, the two conversation-list sections + two "+" buttons (`AgentChatPanel.tsx`
~1084), DM-vs-Channel branching everywhere.

**Delete/collapse — memory:** `dreamPoolAgent`/self-Dream; per-principal pools +
`memoryIsolation`; transactive/membership rendering.

**Rework — unify behavior:** `dmRunActive`/`channelRunsActive` → one `runActive`;
universal inline streaming + steering; drop nav-lock.

**Add:** editable Neva profile (+ stable-id/display-name split); Settings→Agent
"Memory & activity" panel; per-channel environment note (context-only).

## Build order (A7 foundation-first)

1. **Conversation primitive + behavior unification** — remove
   `canonicalDmAgentId`, collapse the render model to single-agent inline-streaming
   Channel, one `runActive`, no nav-lock. Keystone: makes all multi-agent code
   provably dead.
2. **Delete the dead multi-agent code** (the ~2k-line pure-delete set).
3. **Editable Neva** + Settings→Agent "Memory & activity" panel (relocate Dream
   surfacing).
4. **Collapse memory** to one first-person pool; cut self-Dream + per-principal
   machinery.

Each step ends green (`bun run typecheck` + `test:core`/`test:renderer` +
`docs:check`). Shape: **one complete feature in one PR**, with the four steps as
build-order *within* it (not separate partial releases) — the product is only
coherent once all four land.

## Open questions

- **Memory key:** believer-keyed single pool (recommended; aligns with D-1 +
  "Neva's first-person knowledge") vs keeping a nominal user pool. Settle in
  step 4 against `agent-memory-realignment`.
- **`General` framing:** keep the word "Channel" (single-occupant) for now; revisit
  "conversation/topic" rename later — zero-cost, non-blocking.
