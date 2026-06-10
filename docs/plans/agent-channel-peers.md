---
status: draft
priority: P1
owner: unassigned
phase: M3-A
created: 2026-06-10
updated: 2026-06-10
---

# M3-A: working multi-agent Channel (membership + routing + peer reply)

**Shape: (a) ONE complete feature in one PR.** Membership without a peer that
actually replies would be a scaffold slice, so membership, routing, and the peer
turn ship together; the internal split below is build order, not separate releases.

## Goal

A user can create a **Channel** with more than one agent member and have the
right agent reply:

- `@agent` (scoped to members) routes the turn to that agent; no `@` routes to
  the **coordinator** (default = the main agent).
- The addressed peer takes a real turn **as itself**: its own identity record,
  model/effort/skills from its profile, its own memory line; its reply lands in
  the shared thread with `actor` = its agent principal, and the UI shows who spoke.
- A coordinator may hand off by `@`-ing a better-suited member (a relay — strictly
  sequential turn-taking, bounded by a loop budget).
- Membership changes are real events (`member.added` / `member.removed`) that
  replay and render.

## Ratified design this builds on (do not re-decide)

From `agent-conversation-model.md` / `agent-data-model.md`, all PM-ratified:

- **Canonical DM + user-creatable Channels.** DMs are find-or-create-unique and
  never convert in place; adding a second agent **spawns a new seeded Channel**
  (goal + existing agent as member + optional DM back-link). The session list is
  the Channel list.
- **Routing rule:** *a run is produced iff a principal is in `addressedTo`*,
  bounded by a loop budget; the coordinator is just the default `addressedTo`
  when the user `@`s no one. Explicit `@` bypasses the coordinator entirely.
- **Coordinator = a Member role flag**, not a router subsystem; routing is the
  coordinator's normal turn (it answers or `@`s a member to hand off). A
  Channel's default coordinator = the main agent. DMs have none.
- **Sequential turn-taking only** — one member runs at a time; hand-off is a
  relay, never concurrency.
- **`@` candidate set = the conversation's agent members** (Slack-style); a DM
  has no `@`.
- **Capability binds to the agent, not the conversation** (model/effort/tools/
  skills travel with the agent profile); a Channel adds a goal overlay, never
  overrides who the agent is.
- **POV flatten at assembly (agent-data-model §8):** for agent A's turn, A's own
  prior turns → `assistant`; everyone else (user + other agents) coalesces into
  `user` content with a `<system-reminder>` identity preamble per source turn
  (`@bob (agent) said:` …). This is **load-bearing for the peer turn** — without
  it a peer misattributes speakers — so it ships here, not in M3-C.
- **New-member onboarding floor:** shared substrates only, never the private DM
  transcript. In this PR: ambient outline (automatic) + optional seed text at
  Channel creation. Coordinator-briefing and message-forwarding onboarding are
  follow-ups (see Non-goals).

## Verified code anchors (read-only audit 2026-06-10)

- `defaultConversationMembers()` — always `[user, mainAgent]`
  (`src/main/agentRuntime.ts:3147`); conversation creation IPC at `:663`.
- `addressedTo?: AgentPrincipal[]` is **type-only** — never written or read
  (`src/core/agentEventLog.ts:161`).
- `member.added`/`member.removed` are **declared-only**: no `applyAgentEvent`
  case (`src/core/agentEventLog.ts:140,176`; switch `:1424-1723`) — replay would
  silently drop them. Members are frozen at `session.created` (`:1427-1435`).
- The turn run hardcodes the main agent: `agentId: this.agentIdentity.agentId`
  in `startRun` (`src/main/agentRuntime.ts:4393`) — the routing hook point.
- Peer identity reuses `agentDefinitionAgentId()` (stable tuple, rename-safe;
  `src/main/agentSubagentIdentity.ts:6`).
- Memory is already principal-keyed (#173): `buildMemoryReminder(agentId, …)`
  reads the reader's own pool + the co-member user pool
  (`src/main/agentRuntime.ts:3856-3886`) — a peer's turn reuses this verbatim.
- Render projection has **no actor field** (`src/core/agentRenderProjection.ts`
  `AgentRenderMessageEntity`); `AgentConversationListMeta.members` already exists
  but is unrendered (`src/core/types.ts:730`; `AgentChatPanel.tsx:1034`);
  composer has no `@`-mention (`AgentComposerEditor.tsx`).

## Design (build order within the one PR)

1. **Events first (protocol surface — coordinated change):** `applyAgentEvent`
   cases for `member.added`/`member.removed` mutating `session.members`; write
   `addressedTo` on `message.created`; stamp `actor` on peer assistant messages.
   `src/core/` changes land complete with their replay tests.
2. **Channel creation:** `createConversation` accepts an initial member set +
   goal (user-creatable Channel); DM stays canonical find-or-create; "add agent
   to DM" spawns the seeded Channel per the ratified UX.
3. **Routing:** resolve `addressedTo` from composer `@`-mentions (members-scoped);
   none → coordinator. Parameterize `startRun`'s agent identity (the `:4393`
   hook): the addressed member's profile → identity record, model/effort, skills,
   system prompt, memory line. Hand-off: an agent reply containing `@member`
   produces that member's run; a per-user-turn loop budget caps the chain.
4. **Peer assembly:** the §8 POV flatten in the transcript derivation for the
   running agent (actor→role mapping + coalesced identity preambles).
5. **UI:** composer `@`-mention typeahead over agent members; member display on
   the Channel header/list (`members` is already in the list meta); actor
   attribution on message rows (add `actor` to the render projection + a name
   badge on non-main-agent assistant rows). Visual gate: light + dark.

## Non-goals (boundary — 钉死)

- **NOT cross-agent memory** — a peer reads its own pool + the user pool (the
  shipped #173 membership read); reading *agent* co-member pools is **M3-B**.
- **NOT a POV inspector UI** — M3-C.
- **NOT concurrent turns** — sequential relay only (ratified).
- **NOT coordinator reassignment UI** — coordinator = main agent by default;
  the role flag exists in data, reassignment UX is a follow-up.
- **NOT coordinator-briefing / message-forwarding onboarding tools** — follow-up;
  this PR ships ambient outline + seed-at-creation only.
- **NOT who-configures-whom** — no agent configures another agent here
  (main-agent-first stays the standing default; PM gate untouched).
- **NOT doc snapshot+delta** — context cache discipline belongs to the
  memory-prefix work, orthogonal.

## Open questions (PM gates — answer before build)

- **Q1 — group default-`addressedTo`.** When the user `@`s no one in an N-member
  Channel: all / none / last-speaker / **coordinator (recommended — this is the
  design's current answer; ratifying it here pins it)**.
- **Q2 — relay loop budget.** Max agent→agent hand-offs per user turn. Reversible
  local — dev decides and notes in the PR (suggested start: 3).

## Acceptance

- [ ] Create a Channel with the user + 2 agents; `@b hello` produces b's run; the
      reply renders with b's name/actor; b's assembly shows the §8 flatten
      (verified in a transcript-derivation test).
- [ ] No-`@` message routes to the coordinator; a coordinator `@member` hand-off
      produces that member's run; the loop budget caps a circular `@` chain.
- [ ] `member.added`/`member.removed` replay round-trip (event → restart →
      members correct); `addressedTo` written and read back.
- [ ] DM behavior unchanged (no `@`, single implicit addressee, find-or-create).
- [ ] `bun run typecheck` + `bun run test:core` + relevant renderer tests green
      (vs known baselines); UI visually verified light + dark.
- [ ] Spec sync (A6): fold the shipped design into `docs/spec/` (conversation
      areas + `agent-architecture.md` status rows: `addressedTo`/members scaffold
      → ✅, Channel/routing rows → ✅); archive this plan `done`.

## Collision self-check (2026-06-10, plan time)

- Open PRs at draft time: **cc/agent-memory-source-binding (Phase 1)** — touches
  `agentRuntime.ts` (Dream watermark region ~:2842) and `agentEventLog.ts`
  (watermark cursor types). **This plan also touches both files** (routing hook
  ~:4393, event types ~:161/:176/:1424+). Different regions, but same files —
  **start M3-A only after Phase 1 merges**, then rebase. This matches the
  ratified debt-first order anyway.
- `src/core/agentEventLog.ts` is protocol surface (A4/infra list): the step-1
  event changes are the coordinated part — keep them minimal and land them with
  the PR as one complete change (no interface-only pre-PR needed since no other
  branch consumes them yet; re-check `gh pr list` at claim time).
