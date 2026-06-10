---
status: draft
owner: unassigned
priority: P1
phase: M3-Phase-1
supersedes: []
---

# Agent memory: source binding survives compaction

**Shape: (a) ONE complete feature in one PR.** A correctness hardening + its
regression harness + the spec sync. Any internal ordering is build-order within
the single PR, not phased releases.

> **PM-ratified 2026-06-10 — boundary locked to the spine.** Both Open-question
> scope calls resolved **OUT**: *(f)* reminder-cache staleness and *(g)* checkpoint
> shape-version hygiene stay in `agent-dream-followups`. Build = watermark
> compaction-survival fix + resolution regression test + spec sync, nothing more.
> Ready for a dev clone (cc / cc-2 / codex / anti) to claim with a Draft PR.

## Goal

Make the agent-memory **evidence binding survive transcript compaction**, so that:

1. every distilled fact's `sources[]` resolves to **exactly its origin** evidence
   or **fails loud** — never silently returns different content; and
2. Dream **never permanently drops** a run's post-compaction content (no message
   content is ever simultaneously un-Dreamed *and* unreachable).

This is the Phase-1 precondition for M3 **cross-agent citing**: when agent B cites
agent A's distilled fact, the citation resolves A's `sources[]` to raw evidence
across the principal-isolation gate. If that resolution can silently surface the
wrong evidence — or if a fact was built on evidence that compaction dropped — the
corruption propagates across the isolation boundary. Harden the binding before the
gate is load-bearing.

## Context — verified state (2026-06-10 read-only audit, `file:line`)

The audit narrowed the real debt. The **resolution path is already robust**; the
residual gap is the **Dream watermark**, which is the only positional mechanism left.

- **`sources[]` are already stable IDs, not offsets.**
  `AgentMemorySource.messageRange: [fromId, throughId]` + `eventId` (a payload pin)
  — `src/core/agentEventLog.ts:406-416`. Conversation resolve = `findIndex` by
  message id, failing loud `NOT_ON_ACTIVE_BRANCH` (`src/main/agentPastChats.ts:365-379`);
  agent-run resolve = payload-id-pinned + decoded `runId:message:N`, failing loud
  `SOURCE_NOT_FOUND` (`src/main/agentSubagentTranscript.ts:69-81`). #164 review
  findings #1/#2 already fixed the "recall reads the wrong payload" corner.
- **The residual debt is the watermark, which IS positional.**
  `AgentDreamAgentRunWatermarkCursor = { messageCount, payloadId }`
  — `src/core/agentEventLog.ts:436-439`. After a subagent run auto-compacts,
  `payloadId` changes, so the cursor falls back to `evidenceStart`. But for a
  **fork run** (`evidenceStart > 0`) whose compacted payload is *shorter* than
  `evidenceStart`, `fromMessageCountExclusive = min(evidenceStart, len)` and then
  `len <= fromMessageCountExclusive` → the run is **skipped forever**, so the
  compacted summary (now its only durable evidence) is **never distilled**
  — `src/main/agentRuntime.ts:2842-2853`. This is #164 review finding #4
  (partially fixed; the fork+compaction corner remains the load-bearing hole).

## Non-goals (boundary — 钉死)

- **NOT** the M3 cross-principal isolation gate / read-path precedence — that is
  Phase 2.3 (cross-agent memory sharing), a separate plan.
- **NOT** a `sources[]` / `AgentMemorySource` **schema change** — the schema is
  already robust (stable IDs + payload pin). Do not widen it; harden the watermark
  and lock the resolution path, don't re-shape the source.
- **NOT** the `memoryIsolation: 'isolated'`-only workspace-scoping bugs (#164
  re-review #1/#2), Dream UX parity (#3/#5/#7), or i18n coverage (#4) — those
  stay in `agent-dream-followups`.
- **NOT** reminder-cache staleness (TASKS item *(f)*) or checkpoint shape-version
  hygiene (item *(g)*) — adjacent but orthogonal; see Open questions Q1/Q2. Default
  is to leave both out and keep this plan to the compaction-survival spine.

## Design

1. **Compaction-survivable Dream coverage (the fix).** The fork-prefix boundary
   (`evidenceStart`) is expressed in **pre-compaction** message coordinates; the
   bug is treating those coordinates as still valid against a compacted payload
   whose summary collapses the excluded prefix into message 0. The fix: when a
   run's live `payloadId` no longer matches the cursor's `payloadId`, the prefix
   exclusion is **stale** — the new compacted payload is fresh evidence in its
   entirety and must be Dreamed from index 0, not re-excluded. The dev settles the
   exact representation (e.g. scope the prefix-exclusion to "up through payload P;
   once P is superseded, the successor payload is fully pending"); **the invariant
   below is what is pinned, not the mechanism.**

2. **The invariant to pin (the contract).** *Compaction is evidence-preserving.*
   For every run, across any sequence of auto/manual compactions, the union of
   (already-Dreamed content) ∪ (still-pending content) covers **100%** of the
   run's semantic content — no message content is ever both un-Dreamed **and**
   unreachable. State this in `agent-data-model.md` as a memory invariant.

3. **Lock the resolution path with a compaction regression test.** A source pinned
   *before* compaction must, *after* compaction, still resolve to the same evidence
   text **or** fail loud (`NOT_ON_ACTIVE_BRANCH` / `SOURCE_NOT_FOUND`) — never
   silently return different content. This guards the already-robust path against
   regression rather than changing it.

4. **Spec sync (A6).** Correct `docs/spec/agent-architecture.md:107` — the row
   overstates the debt as "positional indexing + watermark fragility"; the precise
   truth is "sources are already ID-pinned; the residual gap is the positional Dream
   watermark under fork+compaction." Flip that status row to ✅ on ship; fold the
   pinned invariant (Design 2) into `agent-data-model.md`; archive this plan `done`.

## Open questions (for PM ratification)

- **Q1 — fold in reminder-cache staleness (item *f*)?** Keying `run.memoryReminderCache`
  on a memory seq/version is adjacent (memory freshness under concurrent mutation)
  and cheap, but it touches the reminder cache, not source binding.
  **Recommend: leave out** — keep this plan to the compaction spine; *(f)* is
  bounded-by-run-lifetime and orthogonal.
- **Q2 — fold in checkpoint shape-version hygiene (item *g*)?**
  **Recommend: leave out** — different subsystem (the replay seq-checkpoint, not
  memory binding).
- **Q3 — test harness.** Extend an existing fixture (`agentCompaction.test.ts`,
  `agentDreamExtraction.test.ts`, or `agentRuntimeSubagents.test.ts`) vs. a new one
  driving a real auto-compaction → fork → Dream sequence. Dev to locate the
  cheapest fixture that can stage a real compaction.

## Acceptance

- [ ] New regression test reproduces the **fork + compaction permanent-skip**:
      fails on `main`, passes after the fix.
- [ ] New regression test: a source pinned **before** compaction resolves
      **after** compaction to the same text, or fails loud — never silently wrong.
- [ ] A test exercises **auto + manual compaction in sequence** and asserts the
      evidence-preserving invariant (Design 2) holds.
- [ ] `bun run typecheck` + `bun run test:core` green (no regression vs the known
      2-fail baseline).
- [ ] `agent-architecture.md` status row flipped ✅ + the precise wording fix;
      invariant folded into `agent-data-model.md`; this plan moved to
      `docs/plans/archive/` `status: done`.

## Collision self-check (2026-06-10)

- `gh pr list --state open` → **zero open PRs**; no claim overlaps.
- Files this plan will touch: `src/main/agentRuntime.ts`,
  `src/core/agentEventLog.ts` (watermark cursor only — no source-schema change),
  `src/main/agentSubagentTranscript.ts` / `agentPastChats.ts` (resolution test
  surface), `tests/core/agent{Compaction,DreamExtraction,RuntimeSubagents}.test.ts`,
  `docs/spec/agent-architecture.md`, `docs/plans/agent-data-model.md`. No overlap.
- **Owner: a dev agent** (cc / cc-2 / codex / anti) after PM ratification — the
  main agent does not build.
