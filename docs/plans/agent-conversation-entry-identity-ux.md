---
status: in-progress
priority: P2
owner: main
created: 2026-06-11
updated: 2026-06-12
---

# Agent Conversation UX: Roster, Channels, Identity, Presence

**Shape: (b) a set of independent complete features**, each its own PR, ordered
below. Drafted by codex-2 (PR #197), revised by main after the PM review
conversation (2026-06-11); the revisions in this version are PM-ratified
direction. Implementation owners are unassigned.

## Authority

This plan is the UX layer over already-ratified conversation semantics. It
introduces no new conversation primitives. Read first:

- `docs/spec/agent-conversation-model.md` — canonical DM per agent
  (find-or-create, continuous), Channels as named rooms, derived (not stored)
  kind, "a DM never converts in place", `@` scoped to roster, capability binds
  to the agent identity.
- `docs/spec/agent-architecture.md` — Channel delivery model (typing presence
  while running, whole reply lands on completion, drill-in to run panel).
- `docs/plans/agent-program.md` — M3 sequencing; M3-A (#179) shipped the
  `actor` field and channel routing this plan renders.

**Load-bearing semantic fact (ratified, already in the runtime):** same-round
co-addressees are independent — each turn's context cuts at the message that
addressed it, and co-addressees never see each other
(`agentRuntime.ts` round loop). Execution is currently serialized as an M3-A
simplification, but that is an implementation stage, not a product position.
**The UI in this plan is designed to the parallel semantics**, so that the
execution-layer upgrade (`docs/plans/agent-channel-parallel-runtime.md`) ships
later with zero UI change.

## Goal

Make agent conversations feel like a simple messaging product:

- the user reaches any agent in one click — the roster IS the DM list;
- DM vs Channel is obvious before anything is created, and escalating a DM to
  a Channel states its consequence in the verb itself;
- every reply clearly shows who said it, and out-of-order replies stay
  readable;
- who is working right now is visible in a fixed place, never as transcript
  noise;
- message metadata (time, model, tokens) is available on demand, never loud;
- models are configured on agent profiles, not changed ad hoc from a DM — and
  the current composer model menu, which silently mutates the GLOBAL provider,
  is treated as a defect, not a habit to wean.

## UX Principles

1. **People first, transport second.** The primary object is an agent; at this
   product's scale (a handful of configured agents) the roster is the best
   picker — no compose-style recipient search is needed.
2. **DMs are relationships; Channels are named rooms.** A DM is clicked open
   (the relationship already exists); a Channel is created by naming the room.
   Members can be invited now or later. Two objects, two verbs — no morphing
   starter.
3. **No surprise conversion.** Escalating from a DM explicitly creates a new
   Channel; the verb says so before the click, a system line confirms after.
4. **Identity is visible where it disambiguates, silent where it repeats.**
   DM identity lives in the header; Channel rows carry per-speaker identity.
   Model strings never repeat on every row.
5. **Model choice belongs to the profile.** The chat surface displays model
   identity; it never mutates it.
6. **Presence reflects the parallel semantics.** An addressed agent is
   independently working from the moment its message lands; the UI never
   invents a turn-taking story ("queued behind A") that the semantics don't
   have.
7. **Metadata is available, not loud.** Time separators in the stream; depth
   behind a native context menu.

## Design

### Feature A: Roster-as-DM-list + New Channel flow

Complete feature: the user reaches any agent's DM in one click and creates a
Channel in one explicit flow. **This feature has a hard runtime dependency**
(arbitrary-agent canonical DMs — today `defaultDmConversationId()` is keyed to
the built-in assistant only); it ships as ONE plan-track PR covering UI +
runtime, not as renderer polish.

Conversation list, two sections:

- **Direct Messages = the agent roster.** One row per configured agent —
  avatar, display name, model/profile subtitle, last-message snippet/time when
  history exists. Every agent appears, chatted with or not (DM is
  find-or-create); clicking a row opens that agent's canonical DM. DM rows are
  not rename/delete targets (matches the existing canonical-DM runtime
  restrictions).
- **Channels.** Title, stacked member avatars, unread badge, rename/delete.

One creation verb: **New Channel** — a required Channel name, optional member
multi-select over the roster, and an optional opening message shared with the
room. This follows the Slack-shaped flow: create the named space first, then
invite people/agents now or later. The runtime still stores the name in the
legacy `goal` field for existing event/index compatibility, but that is not a
user-facing concept.

Channel header and member management:

- the Channel title is the primary label; stacked member avatars are
  secondary context;
- member add/remove lives behind a **Members** popover, not loose header
  icons; removal of the coordinator is disabled, and removal is disabled while
  runs are in flight (matching runtime rules);
- historical attribution survives member removal (already the stored-record
  behavior; the UI must not re-resolve past speakers against the live roster).

DM → Channel escalation: the DM header action is labeled **"Create a Channel
with <Agent>…"** (never a bare `+`). It opens the New Channel flow with that
agent preselected, and focus lands on the Channel name field. After creation,
navigate to the new Channel; its top shows a system line: "Created from your DM
with <Agent> · DM history not shared." The original DM is untouched (the runtime
already spawns, never converts — this feature makes that semantic legible).

Runtime scope (the hard dependency): one canonical DM per agent
(find-or-create keyed by `{user, agentId}`), restore on startup, same
no-rename/no-delete/no-member-change restrictions as the assistant DM. Likely
touches `src/main/agentRuntime.ts`, conversation-list IPC/view shapes only if
needed, `tests/core/agentRuntimeConversations.test.ts`.

UI scope: `src/renderer/ui/agent/AgentChatPanel.tsx`,
`src/renderer/styles/agent-dock.css`, i18n `en.ts`/`zh-Hans.ts`, e2e under
`tests/e2e/agent-composer.spec.ts`.

### Feature B: Speaker identity (subsumes `agent-avatar-v1`)

Complete feature: the user always knows who is speaking, with zero added noise
in the common case.

- **DM:** identity lives in the **header** — avatar, display name, `@mention`,
  model subtitle. Message rows stay quiet (iMessage-style), no per-row avatar
  or name: with one counterpart, per-row identity is repetition.
- **Channel:** assistant rows carry avatar + display name, with **consecutive
  grouping** — a run of messages from the same speaker shows identity on the
  first row only, the rest align-indent under it.
- **Model strings never render on message rows.** Model identity lives in the
  header subtitle (DM) and the per-message details (Feature E).
- Avatar v1 is the already-ratified derived design (TASKS board,
  agent-avatar-v1, PM-ratified 2026-06-10): name initial on a circular chip,
  hue deterministically derived from `agentId`, muted alpha-on-ink tint
  (identity is content, not functional state — B3/B4 intact; circular per B6;
  reuse the workspace-root-avatar idiom). User principal gets one too.
  **Folding avatar-v1 into this feature is PM-ratified (2026-06-11)**; the
  standalone board item is absorbed here. Sync `design-system.md` in the same
  PR (A6); a user-authorable `icon` frontmatter field stays deferred (v2).

Rides the `actor` field M3-A added; projection + renderer only
(`agentRenderProjection.ts`, `AgentMessageRow.tsx`, `AgentMessageFrame.tsx`,
`AgentChatPanel.tsx`, `agent-message.css`). If a row-level field is missing
from the projection, add the smallest derived field — never change stored
events.

### Feature C: Model configuration — fix the global-provider trap

Complete feature: the chat surface displays model identity and never mutates
global state.

**The current composer model menu mutates the GLOBAL active provider**
(`agentSetActiveProvider` — changing "this DM's model" changes every
conversation's model). That is a user-facing trap, not a habit to wean
gradually; it gets fixed in one step rather than the original four-stage
demotion:

- The composer model chip becomes **identity display + navigation**: it shows
  the active model for this agent; clicking opens the owning settings surface
  — the agent's profile for user/project agents, the provider settings page
  for the built-in assistant (honest: that setting IS global until the P3
  registry unification gives the assistant a per-identity profile binding).
- `AgentDefinition.model`/`effort` remain the source of truth for
  user/project agents (already ratified: capability binds to the agent).
- Skills keep their scoped execution-time model/effort overrides (capability
  behavior, not chat-surface selection).

Touches `AgentComposerControls.tsx`, `AgentComposerModelMenu.tsx` (removed or
reduced to display), `AgentSettingsView.tsx`, `AgentEditor.tsx`, provider
settings tests. Small PR; can land early and independently.

### Feature D: Channel activity area + reply anchors

Complete feature: who is working is visible in a fixed place, and
completion-order replies stay readable.

**Activity area** — designed to the parallel semantics from v1:

- An agent appears in the area from the moment a message addresses it, until
  its final reply lands or fails. Items from different addressing messages
  coexist (the user can send a second message while the first is in flight —
  it routes independently).
- Each item: avatar + name + that agent's own true state — `thinking`,
  `using tools`, `received` (addressed, run not started — under today's serial
  runtime this is the visible state for later co-addressees; under the
  parallel runtime it shrinks to nothing, with no UI change). **Never "queued
  behind X"** — that names a dependency the semantics don't have.
- Fixed height near the composer/header boundary; overflow collapses to a
  count (B7: no layout shift). Click an item → that run's working-state panel
  (existing drill-in).
- **Stop, scoped:** hover an item → per-agent stop (cancels that run only;
  co-addressees are independent, so single-stop is coherent). The composer
  stop button = stop everything in flight + discard unstarted routing, keeping
  the existing "N unstarted turn(s) discarded" system-line trace.
- A failed item briefly shows a failed state with retry; the failed-run trace
  lands in the transcript as today; siblings are unaffected (matches the
  existing "one addressee's failure never skips siblings" runtime rule).

**Reply anchors** — required for completion-order readability: when a reply's
addressing message (`addressedByMessageId`, already persisted) is NOT the
nearest user message above it in the visible transcript, render a quiet quote
anchor on the reply (`↩ "<truncated original>"`); clicking scrolls to and
briefly highlights the original. Adjacent replies (most DM and single-`@`
traffic) render no anchor — the transcript stays clean until out-of-order
actually happens. System-attached, never user-maintained.

Projection + renderer only (`agentRenderProjection.ts`, `AgentChatPanel.tsx`,
`AgentChildRunDetailsPanel.tsx`, `agent-message.css`, `agent-dock.css`,
Channel renderer/e2e tests). True parallel execution is NOT this PR — it is
`docs/plans/agent-channel-parallel-runtime.md`, a pure execution-layer
upgrade once this UI is in place.

### Feature E: Message metadata — time separators + native details

Complete feature: time, speaker, model, and token usage are inspectable
without cluttering the stream.

- **Time separators** carry the bulk: a centered `Today 14:32`-style divider
  when the gap between consecutive messages exceeds a threshold (~1h). This
  answers "when was this" for 90% of cases at zero per-row cost.
- **Native context menu** (B10 — native menus, not a custom `⋯` button):
  right-click a message → Copy / Retry-Regenerate (where applicable) /
  **Details**. Existing row actions stay; Details is the new entry.
- **Details popover:** absolute timestamp, speaker identity + `@mention`,
  provider/model for assistant messages, token usage when available (input /
  output / cache fields — the per-turn totals already ride the final assistant
  reply per `agent-data-model.md`; per-run aggregate stays in the run panel).
- Optional fast path: hover fades a precise timestamp at the row edge.

Derive everything from existing message/run records via the projection; add
the smallest derived field if one is missing — never change stored events.
Touches `agentRenderProjection.ts`, `AgentMessageRow.tsx`,
`AgentMessageFrame.tsx`, `agent-message.css`, renderer tests.

## Ordering

1. **B + E** — pure projection/UI, no dependencies, immediate clarity gain.
2. **D** — activity area + reply anchors (UI to the parallel model; serial
   runtime degenerates gracefully).
3. **A** — roster + arbitrary-agent DMs + escalation verb (UI + runtime, one
   plan-track PR; the largest experience jump).
4. **C** — can land any time as a small independent PR; earlier is better
   given the global-provider trap.
5. `agent-channel-parallel-runtime` — after D, as its own plan-track item.

## Non-goals

- No cross-agent memory sharing (M3-B) or per-agent POV inspector (M3-C).
- No concurrent Channel execution in this plan's PRs — that is
  `agent-channel-parallel-runtime` (already-committed semantics; execution
  upgrade only).
- No DM transcript forwarding into a Channel; the seed/system line is
  explicit; private DM history stays private.
- No user-authorable avatar/icon field (v2); derived avatars first.
- No per-message model override UI; no compose-style recipient search.

## Ratified decisions (PM review, 2026-06-11)

1. **Arbitrary-agent DMs**: direction was already ratified in the conversation
   model ("each agent has one always-on continuous DM"); ships with Feature A
   as UI + runtime in one PR.
2. **agent-avatar-v1 folds into Feature B**; row-level metadata is identity
   only (avatar + name) — model strings move to header + details.
3. **Composer model control**: fixed in one step (display + navigate), not a
   four-stage demotion — the control mutates the global provider today, which
   is a defect.
4. **Channel execution**: parallel/independent co-addressees ARE the committed
   semantics (context cuts at the addressing message; M3-A merely serialized
   execution). The UI is built to the parallel model now; the runtime upgrade
   is a separate plan (`agent-channel-parallel-runtime`) and needs no further
   product re-ratification.
5. **Roster replaces the morphing starter**: at this product's agent count,
   the list is the picker; "New Channel" is the only creation verb.

## Acceptance

- Every configured agent appears in the Direct Messages roster; one click
  opens its continuous DM (no "new conversation" ceremony).
- Creating a Channel = name the room, optionally invite agents, optionally add
  an opening message; the system line and membership match the ratified spawn
  semantics.
- Channel membership is managed from a Members popover; removing the
  coordinator is disabled, as is removal while runs are in flight.
- The DM escalation verb names its consequence; the original DM is unchanged
  and a system line in the new Channel says so.
- DM rows are quiet with identity in the header; Channel rows show grouped
  avatar + name attribution; historical attribution survives member removal.
- The activity area shows every addressed-but-unfinished agent with its own
  true state, supports items from multiple in-flight messages, per-item and
  global stop, and opens the run panel on click; it never shifts layout.
- Out-of-order replies carry a reply anchor back to their addressing message.
- Time separators appear at gaps; right-click → Details exposes timestamp,
  speaker, model, and token usage.
- The composer model chip displays and navigates; nothing on the chat surface
  mutates provider/model state.
- Light + dark visual checks for roster, headers, identity rows, activity
  area, anchors, separators, and narrow widths.
- `bun run typecheck` + relevant core/renderer/e2e tests pass.

## Collision check

At the time of this revision: no open PRs touch agent conversation UI. Feature
A's runtime slice touches `agentRuntime.ts` — re-run `gh pr list` at claim
time; coordinate with any in-flight runtime work before claiming.
