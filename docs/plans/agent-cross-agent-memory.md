---
status: draft
priority: P1
owner: unassigned
phase: M3-B
created: 2026-06-10
updated: 2026-06-10
---

# M3-B: cross-agent memory sharing + the cross-principal isolation gate

**Shape: (a) ONE complete feature in one PR.** The sharing read-path and the
hard isolation gate ship together — sharing without the gate is the known
failure mode (unifying "self" and "other" memory unifies the leak), and the
gate alone has nothing to protect.

**Dependencies:** Phase 1 (`agent-memory-source-binding`, merged #178) — citing
a co-member's distilled fact inherits its provenance integrity. **M3-A**
(`agent-channel-peers`) — agent co-members only exist once Channels do.
**`agent-run-unification`** — citing rides the unified seq/eventId evidence
scheme (one addressing mode under the isolation gate, not two).

## Goal

In a Channel, each agent member's briefing additionally includes its **agent
co-members'** distilled self-models — read-only, distilled-only — so peers can
build on each other's knowledge, while a **hard architectural gate** guarantees
no principal can ever dereference another principal's raw evidence.

This is the **one genuinely new primitive** of M3 (the architecture map's ★):
everything else in the milestone is rules and views over existing primitives.

## Ratified design this builds on (do not re-decide)

From `agent-data-model.md` §Extension / D2 (as revised), all PM-ratified:

- **A pool = one Principal's self-model**, undivided (D2 revised 2026-06-10:
  the `isolated` tier is removed; modes are `global` and `read-only-global`;
  `originWorkspace` is provenance only, never a filter).
- **Visibility = conversation membership — there is no publish ACL.** A reader
  assembles: its own pool → `<self>` (second person) + **every co-member
  principal's pool** in the current conversation → `<principal name="…">`
  (third person). The user-pool half of this **already shipped (#173)**; this
  plan extends the same rule to agent co-members.
- **Writes are per-principal; one writer per pool** (each principal's Dream
  writes only its own pool — shipped #173). Sharing adds **no write path**.
- **Cross-principal recall returns the distilled `fact` only.** Evidence
  expansion (`recall(include_evidence:true)` dereferencing `sources[]` to raw
  transcript) is permitted **only** when the entry's `principal` == the
  reader's own; the runtime evidence service principal-gates the dereference.
- **Foreign-principal facts carry the highest load-time scan bar** (they enter
  another model's prefix every turn).

## Verified code anchors (read-only audit 2026-06-10)

- `buildMemoryReminder(agentId, session)` — `src/main/agentRuntime.ts:3856-3886`:
  already reads `[self pool, co-member user pool]` via
  `listMemoryEntries(principal, …)`; the extension point is to generalize the
  pool list over `session.members` (agent principals included).
- `renderAgentMemoryBriefing(selected, { reader })` —
  `src/main/agentMemoryBriefing.ts`: already renders per-reader zones; needs the
  third-person `<principal name>` zone for foreign agent pools.
- Evidence expansion path — `src/main/agentRecallTool.ts` +
  `src/main/agentPastChats.ts` (source → raw transcript dereference): the gate
  enforcement site.
- `memoryIsolation: 'global' | 'read-only-global'` —
  `src/main/agentSettings.ts:90` — unchanged by this plan.

## Design

1. **Membership read, generalized.** The briefing's pool list becomes "the
   reader's own pool + every co-member principal's pool" (user and agent alike),
   derived from the conversation's `members`. Foreign agent pools render as
   third-person `<principal name="…">` zones; `<self>` stays second person.
2. **The hard gate (the load-bearing piece).** Enforce *in the evidence
   service*, not in tool prompts or call-site convention: any dereference of
   `MemoryEntry.sources[]` to raw conversation/run content checks
   `entry.principal` against the requesting reader's principal and **refuses**
   on mismatch with a typed error (the distilled `fact` remains available).
   Every dereference path goes through this one choke point — `recall`'s
   evidence expansion and any future caller. Negative tests prove refusal.
3. **Scan bar.** Apply the existing secret-pattern redaction heuristic at the
   injection boundary for foreign-pool facts (same heuristic as the agent-memory
   backlog item; accepting it is heuristic).
4. **Spec sync (A6).** Fold into `agent-data-model`'s D2/§4 sections as shipped
   behavior; flip `agent-architecture.md`'s "cross-agent memory sharing +
   isolation gate" row ◻ → ✅; archive this plan `done`.

## Non-goals (boundary — 钉死)

- **NO publish/subscribe ACL or per-fact sharing controls** — visibility is
  membership, full stop (ratified; a publish primitive was explicitly rejected
  in favor of extending D2).
- **NO cross-principal writes** — sharing is read-only; one writer per pool.
- **NO raw-evidence sharing of any kind** — distilled facts only, ever.
- **NO new memory fields** (`kind`/`confidence`/`salience` stay out — settled in
  the agent-memory-model review) and **no new recall tool** (the single `recall`
  tool is the surface).
- **NOT injection-budget tuning** — how many foreign facts fit the briefing is
  data-model's open salience question; this plan uses the existing per-pool
  caps.

## Decisions (PM gates — closed)

- **Q1 — uniform co-member pool rule: RATIFIED 2026-06-10.** All co-member
  pools are read alike by membership; the user pool is just one principal's
  pool, no special case. One rule, consistent with "user is an ordinary
  Principal". Pinned — do not re-open.
- **Q2 — foreign-pool volume cap.** Reversible local — dev decides and notes in
  the PR (suggested start: half the own-pool cap).

## Acceptance

- [ ] In a 2-agent Channel, agent A's briefing contains a `<principal>` zone
      with B's distilled facts (third person) and vice versa; a non-member
      agent's pool never appears.
- [ ] Gate negative tests: cross-principal `recall(include_evidence:true)`
      returns the distilled fact + a typed refusal for evidence; the refusal
      holds at the evidence-service choke point (unit test calls the service
      directly, not just through the tool).
- [ ] Own-principal evidence expansion still works (regression).
- [ ] Foreign-pool facts pass the redaction heuristic at injection.
- [ ] `bun run typecheck` + `bun run test:core` green vs known baselines.
- [ ] Spec sync per Design 4; plan archived `done`.

## Collision self-check (2026-06-10, plan time)

- Sequenced strictly after Phase 1 and M3-A merge (file overlap on
  `agentRuntime.ts` / briefing paths with both) — re-run `gh pr list` + re-check
  scopes at claim time.
- Protocol surface: none expected (no `src/core/commands.ts`/`types.ts` change;
  the gate is a main-process service behavior + tests).
