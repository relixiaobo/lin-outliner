---
status: draft
priority: P2
owner: main
created: 2026-06-12
updated: 2026-06-12
---

# Agent Ledger Hygiene: Dead Events, Compat Fields, Spec Sync, Spine Oracle

**Shape: (a) ONE complete feature in one PR.** The four items below are build
order within that single PR, not separate releases. Fast-track sized but
plan-tracked because it touches the persisted write path.

## Authority / origin

Findings from the 2026-06-12 post-parallel data-structure audit (PM-reviewed in
conversation). Verdict there: the core model (7 primitives, 3 ledgers, derived
kind, bipartite parentage) is clean and needs NO restructuring — this plan
clears the residue the audit surfaced, all of it pre-Channel debt or
documented-compat leftovers. Read first: `docs/plans/agent-data-model.md`
(write/read path + invariants), `docs/spec/agent-architecture.md` (ledger
section), `src/main/agentEventStore.ts` (`appendSplitEvents` /
`isRunLogEvent`).

## Goal

The conversation ledger holds only events something actually reads; the
projection carries no dead compatibility fields; the spec states the real
invariants (including the new run-spine parentage rule); the subtlest read-path
code (visible-transcript reconstruction) is pinned by an oracle test.

## Non-goals

- No change to the three-ledger architecture, the write-time split, or the
  ratified mixed-resolution replay (run events joined at read time is BY
  DESIGN — do not "fix" it).
- No change to the run-spine parentage mechanics shipped in #202/#203.
- No migration/back-compat: pre-release, format-affecting removals are
  clean-cut; wipe `~/.lin-outliner-*` dev userData (confirm no dev app running
  first) and bump checkpoint/index versions if replay shapes change.

## Design

### 1. Dead platform events out of the conversation ledger

Symptom: event types are appended to the conversation log but
`applyAgentEvent` (`src/core/agentEventLog.ts`) has no handler and no other
reader exists — inert storage from the era when the event log doubled as a
global event bus. Audit candidates: `task.*`, `notification.*`,
`config.change`, `review_card.*`, `metric.recorded`, `debug.snapshot.created`.

Rule to apply (verify per type, do not trust the candidate list blindly):

- For each event type appended to the conversation log, find (a) its replay
  handler in `applyAgentEvent`, (b) any non-replay reader (indexes, meta
  updaters, debug surfaces, tests).
- **No handler and no reader → delete the append call site** (and the type, if
  nothing else references it).
- **A real reader exists outside conversation replay → move the write to where
  that reader looks** (its own store/file), not the conversation ledger.
- Record the per-type disposition table in the PR body.

`checkpoint.created`, `compaction.completed`, `dream.finished`, payload events
are load-bearing — listed here so nobody "cleans" them by pattern-match.

### 2. Projection compatibility fields die

- `queuedMessages` (always `[]` since #202 killed queue-all) — remove the
  field, its `agentRenderProjection.ts` plumbing, and any renderer reads.
- `activeRunAgentId` (single-run-renderer compat) — migrate remaining readers
  to `activeRuns` / `activityEntries`, then remove.
- Grep renderer + tests for both names; the e2e mock
  (`installElectronMock`) may also carry them.

### 3. Spec sync (A6)

- `docs/plans/agent-data-model.md`: restate the conversation-log volumetric
  claim to match reality — the WRITE path stores communication only (~2
  events/turn, by `appendSplitEvents` routing on `runId`); full detail appears
  via the read-time run-log join (mixed-resolution replay, ratified). Kill the
  ambiguity that made an audit read the join as contamination.
- `docs/spec/agent-architecture.md` (+ `agent-data-model.md` where stored
  shapes are listed): document the **bipartite parentage invariant** from
  #202/#203 — a run's first segment parents to its `addressedByMessageId`
  (concurrent peers fan out as siblings); every later segment parents to the
  run's own tail (`lastMessageId`), never the shared `selectedLeafMessageId`;
  `parentMessageId` remains the regenerate/branch anchor. Also record the two
  fields #202 added (`assistant_message.started.addressedByMessageId`,
  `assistant_message.completed.addressedTo`) in the stored-shape listing.
- Update the "Execution staging (2026-06-11)" note in
  `agent-architecture.md`: the parallel runtime SHIPPED (#202) — rewrite that
  bullet to describe current behavior (concurrent dispatch, completion-order
  delivery, cap) instead of pointing at the plan.

### 4. Visible-transcript reconstruction oracle test

`getAgentEventVisibleTranscriptPath` (active path + off-path run-spine
grafting) is the subtlest read-path code. Add a property-style core test:

- Build conversations with concurrent multi-segment Channel runs (tool calls,
  completion orders permuted, hand-offs, a regenerate branch).
- Oracle: every persisted message of every completed run appears **exactly
  once** in the visible transcript; segments of one run appear contiguously in
  spine order; the active branch renders its full spine; order is stable
  across replay.
- Lives next to the existing channel runtime tests
  (`tests/core/agentChannelRuntime.test.ts` or a sibling file).

## Acceptance

- A grep of conversation-log append call sites shows every appended event type
  has a replay handler or a documented non-replay reader; the disposition
  table is in the PR body.
- `queuedMessages` / `activeRunAgentId` no longer exist in projection,
  renderer, mocks, or tests.
- Spec passages updated in the SAME PR (data-model volumetrics, bipartite
  parentage, #202 fields, execution-staging note rewritten).
- New oracle test passes; `bun run typecheck` + full `test:core` +
  `test:renderer` clean; e2e smoke unaffected.
- If any replayed shape changed: checkpoint/search-index version bumped, dev
  userData wipe noted in the PR body.

## Collision check (at plan time)

In flight: file-attachments feature PR (codex-3 — document/asset layer, no
overlap). Upcoming: UX Feature A touches `agentRuntime.ts` conversation
creation — this plan's runtime touches are small append-site deletions; this
PR is small and merges FIRST, Feature A rebases over it. Re-run `gh pr list`
at claim time.
