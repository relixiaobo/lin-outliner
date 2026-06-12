---
status: done
priority: P2
owner: codex-2
phase: M3-C
created: 2026-06-10
updated: 2026-06-12
---

# M3-C: per-agent POV inspector (derived view)

**Shape: (a) ONE complete feature in one PR.** An independent transparency
enhancement — nothing later depends on it.

**Dependency:** M3-A (`agent-channel-peers`) — the §8 POV flatten ships there as
part of the peer turn (it is load-bearing for assembly); this plan *exposes*
that derivation to the user, it does not build it.

## Goal

In a Channel, the user can inspect **what a given agent member actually sees**:
a read-only, derived view of the conversation as assembled for agent X — its §8
POV flatten (own turns as `assistant`, everyone else coalesced into `user` with
identity preambles) plus its memory-briefing zones (`<self>` + `<principal>`).

Why it earns a PR: multi-agent debugging and trust. "Why did B answer that way?"
is unanswerable today because transcript views are global; the per-agent
assembly is the real input to B's model and currently invisible.

## Ratified design this builds on

- **POV is a derived projection, never stored** (`agent-architecture.md` —
  "Per-agent POV | Conversation | a derived projection (not stored)"). The
  conversation log stays the single objective record; this view is rebuilt on
  demand from it.
- The §8 flatten + attribution rules (`agent-data-model.md` §8) — reuse the
  exact derivation the peer turn uses (M3-A); the inspector must never have its
  own divergent copy of the mapping (one derivation, two consumers).

## Code anchors (audit 2026-06-10 — re-verify after M3-A lands)

- Visible-transcript projection seam: `getAgentEventVisibleTranscript()`
  (`src/core/agentEventLog.ts:1307`) and `buildAgentRenderProjection()`
  (`src/core/agentRenderProjection.ts`) — the global views the POV view sits
  beside.
- The M3-A assembly derivation (file TBD by M3-A) — the function this view
  re-renders read-only.
- Renderer surface: a member-scoped view toggle in the Channel UI
  (`AgentChatPanel.tsx`) — exact seam settled after M3-A's member display lands.

## Design

1. One derivation, two consumers: extract M3-A's POV assembly into a pure
   function over `(replayState, forAgentId)`; the runtime turn and the inspector
   both call it.
2. Read-only renderer view: pick a member → render their assembled view
   (flattened transcript + memory zones), clearly labeled as derived ("what X
   sees"), never editable, never persisted.
3. Spec sync (A6): flip `agent-architecture.md`'s "Per-agent POV projection"
   row ◻ → ✅; archive this plan `done`.

## Non-goals (boundary — 钉死)

- **NOT stored** — no new persistence, no events, no protocol-surface change.
- **NOT an editing surface** — purely read-only inspection.
- **NOT token-level fidelity** — it renders the assembled messages/zones, not
  the provider wire format (no prompt-bytes viewer).
- **NOT cross-conversation** — scoped to one Channel's members.

## Open questions

- **Q1 — placement.** Where the inspector lives (a header menu per member vs a
  debug-flavored pane). Reversible local — dev proposes in the one-line build
  note; visual gate (light + dark) applies either way.

**Decision shipped:** a member-scoped action in the Channel Members popover opens
a read-only debug-flavored side inspector. This keeps the control next to the
member identity and reuses the existing run/details panel geometry.

## Acceptance

- [x] For a 2-agent Channel, selecting member B shows B's POV: B's turns as its
      own voice, user + A coalesced with identity preambles, B's memory zones.
- [x] A derivation unit test pins inspector output == the runtime assembly
      derivation for the same `(state, agentId)` (one-derivation invariant).
- [x] Read-only verified (no mutation paths); visual check light + dark.
- [x] `bun run typecheck` + relevant tests green; spec row flipped; plan
      archived `done`.

## Collision self-check (2026-06-10, plan time)

- Sequenced after M3-A (it consumes M3-A's derivation). No protocol-surface
  changes expected. Re-run `gh pr list` at claim time.

## Claim-time collision self-check (2026-06-12)

- `gh pr list` shows only #208 (`codex-3/tana-style-references`), scoped to the
  NodePanel references/backlinks surface; no overlap with `agentChannel`,
  `agentRuntime`, `agentRenderProjection`, or `AgentChatPanel` member POV seams.
- `origin/main:docs/TASKS.md` marks codex, codex-2, and codex-3 idle; Feature A
  (#207), ledger hygiene (#205), and file attachments (#206) are merged.
- The M3-A derivation is `flattenAgentPathForPov()` in
  `src/core/agentChannel.ts`; runtime assembly currently wraps it in
  `deriveChannelPiMessages()` in `src/main/agentRuntime.ts`.
- PR-4 memory retrieval is not currently claimed by an open PR. This branch will
  avoid recall/ranking changes and keep the inspector's memory briefing read-only
  so a future retrieval upgrade can rebase cleanly.
