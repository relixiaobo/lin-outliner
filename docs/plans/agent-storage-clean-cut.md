---
status: draft
priority: P1
owner: unassigned
created: 2026-06-10
updated: 2026-06-10
---

# Agent storage clean-cut: session → conversation, pools → principals/

**Shape: (a) ONE complete feature in one PR.** A pure rename/relayout with a
store-owned clean-cut — zero behavior change. **PM-ratified 2026-06-10, both
scope calls closed:** full clean (stored format + ALL code identifiers) and
unified pool layout. Rationale: pre-release is the one moment this costs a dev
wipe instead of a migration, and M3-B/D1 are about to build on these names
(A7 — foundation before consumers).

## Goal

After this PR, the words `session`/`sessionId` no longer exist in the agent
subsystem — on disk or in code — and every memory pool lives under one path
rule. The #151 translation seam dissolves.

## The residue (verified 2026-06-10, `file:line`)

1. **Stored event types** are still `'session.created' | 'session.renamed' |
   'session.settings_changed'` (`src/core/agentEventLog.ts:526-528`, payload
   interfaces `:596-609`, replay cases `:1426-1443`) — bytes in every
   conversation's `events.jsonl`.
2. **Every stored event carries `sessionId`** (`AgentEventBase`,
   `agentEventLog.ts:584`).
3. **Pool layout is asymmetric** (`agentEventStore.ts:296-307`): agent pools at
   `agents/<agentId>/memory/`, user pools at `principals/user-<userId>/memory/`
   — two path rules for one concept ("a principal's pool"), contradicting the
   ratified pool-=-principal semantics.
4. **Code identifiers**: ~146 `session` refs in `agentEventStore.ts`, ~837 in
   `agentRuntime.ts` (`AgentSessionState`, the
   `sessionIdFromConversationId`/`conversationIdFromSessionId` boundary seam,
   `appendEvents(sessionId, …)`, …). The public protocol surface is already
   clean (#151): `src/core/types.ts` / `commands.ts` have **zero** refs.

## Design

1. **Stored format rename:** event types → `'conversation.created' |
   'conversation.renamed' | 'conversation.settings_changed'`;
   `AgentEventBase.sessionId` → `conversationId`. Replay mismatch error and all
   producers/consumers follow.
2. **Pool relayout:** all pools move under `principals/<principalKey>/memory/`
   (`principals/agent-<agentId>/…`, `principals/user-<userId>/…`).
   `agents/<agentId>/` keeps ONLY `identity.json` (agent-specific, not a pool).
   `memoryPaths()` becomes the single path rule with no type branch on
   location.
3. **Store-owned clean-cut (no migration, pre-release policy):** on first
   store access, detect the old format (an `agents/<id>/memory/` dir or any
   `session.*` event in a conversation head) → hard-delete the agent data root
   and start fresh (M0 #150 precedent). Each clone wipes its own
   `~/.lin-outliner-*` dev userData after merging; confirm no dev app is
   running first.
4. **Full identifier rename:** `AgentSessionState` → `AgentConversationState`
   and the rest of the `session` vocabulary across `src/core/agentEventLog.ts`,
   `src/main/agentEventStore.ts`, `src/main/agentRuntime.ts`, and any
   stragglers (`rg -i session src/` drives the sweep; exclude genuine
   third-party API terms if any). Delete the #151 translation seam
   (`sessionIdFromConversationId` / `conversationIdFromSessionId` and the
   translator naming) — boundaries now speak one vocabulary.
5. **Checkpoint hygiene:** the replay-state/event shape changes, so bump
   `CHECKPOINT_VERSION` (per the standing item-(g) rule; its broader test work
   stays in `agent-dream-followups`).
6. **Spec sync (A6):** `agent-data-model.md` §5 layout (the `agents/<id>/memory`
   line + M0-reality note) and `agent-architecture.md` (remove the "only
   residue is the internal field name `sessionId`" caveat; ledgers table
   "Keyed by `agentId` (or user principal)" → principal).

## Non-goals (boundary — 钉死)

- **NO behavior change** — replay semantics, write-time split, retention, and
  every contract stay identical; this is names and paths only. If a rename
  forces a real semantic choice anywhere, stop and escalate.
- **NOT** the dev-userData dirnames (`~/.lin-outliner-*` — separate, noted in
  AGENTS.md), **NOT** watermark shape (#178 settled), **NOT** item (g)'s test
  work, **NOT** any UI copy.

## Sequencing (hard constraint)

Lands **after** the two in-flight PRs merge (M3-A `cc/agent-channel-peers`,
alignment `cc-2/agent-memory-academic-alignment` — both touch these files) and
**before** M3-B and memory-D1 (so the one new event family and the cross-agent
read path are built on clean names). Any idle clone can take it.

## Acceptance

- [ ] Greps prove the cut: `rg "session\." src/core/agentEventLog.ts` → 0
      event-type matches; `rg -i "sessionid" src/` → 0; `rg "AgentSessionState"
      src/` → 0; no `agents/<id>/memory` path construction remains.
- [ ] Old-format dev data is detected and cleanly removed on startup (test with
      a fixture dir); fresh runs create the new layout.
- [ ] `bun run typecheck` + `bun run test:core` + `bun run test:renderer` green
      vs baselines (tests renamed mechanically with the code).
- [ ] `CHECKPOINT_VERSION` bumped; checkpoint-over-old-shape falls back to full
      replay (existing structural guards).
- [ ] Spec synced per Design 6; plan archived `done`.

## Collision self-check (2026-06-10, plan time)

Touches the protocol/infrastructure files (`agentEventLog.ts` — A4 list) and
the two biggest main-process files; the diff is huge but mechanical. In-flight
overlap: #M3-A and #alignment (both claimed) — this plan explicitly queues
behind them. Re-run `gh pr list` at claim time; expect zero other claims.
