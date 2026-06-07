---
status: draft
priority: P2
owner: unassigned
created: 2026-06-07
updated: 2026-06-07
---

# Agent Dream — Scheduled Memory Consolidation

## Essence

> **Waking hours = everyday thinking. Sleep = reorganization.** A human does not
> re-file their long-term memory after every sentence; they think in the moment
> and consolidate while asleep. Tenon's agent should work the same way.

During a conversation ("awake") the agent only **reads** durable memory — the
per-turn `<agent-memory>` reminder injection plus the read-only `recall` tool.
It never writes memory inline. Durable memory is (re)written by **Dream**: a
single **scheduled, offline** pass — gated by **time + activity + lock** — that
reads the raw evidence accumulated since the last pass and updates the memory
line (extract new facts **and** consolidate existing ones) in one sweep.

This plan supersedes the **per-turn trigger** shipped in #159, not the worker
itself: #159's span builder, extraction prompt, action parser, and
isolation/provenance-checked apply path are all reused. Only the **trigger** and
the **evidence range** change, and a **consolidation** step is added.

## Goal

- Make durable memory write-back a **scheduled Dream pass**, not a per-turn
  reaction. One pass per cycle instead of one per completed turn.
- A single Dream pass does both jobs over the since-last-pass evidence:
  1. **Extract** — propose `add`/`update`/`forget` from raw conversation/run
     evidence (the #159 mechanism).
  2. **Consolidate** — dedupe / merge related / prune stale-or-low-value /
     resolve contradictions across the existing memory line.
- Drop the per-turn cadence entirely (it is the most wasteful gate setting).

## Non-goals (explicitly unchanged)

- **Read surface** — `recall` (read-only, single tool) stays exactly as #158.
- **Human write path** — Settings/Profile list/edit/forget stays.
- **No model-visible memory write tool** — the #157 write-authority decision
  stands; Dream remains a runtime-owned writer.
- **Per-turn `<agent-memory>` reminder injection** — this is "everyday thinking"
  (read-only) and stays per-turn; only the *write-back* moves to a schedule.
- **Storage format, isolation tiers, `originWorkspace`, provenance, undo
  invalidation** — all from #157/#158/#159 stand unchanged.

## Design

### Trigger — time + activity + lock (the `autoDream` gate)

Dream fires only when **all** hold:

- **Activity** — there is un-Dreamed evidence since the last successful pass
  (a per-agent watermark advanced past the last processed event). No new
  activity → no pass.
- **Time** — an idle/periodic signal (e.g. N minutes idle, or a periodic
  wall-clock tick while the app is running). The exact signal set is an open
  question below; the worker needs the app alive + online to make a model call.
- **Lock** — no Dream pass is already running for this agent (a single in-flight
  pass; serialize like #159's `dreamMemoryExtractionTail`).

Replaces the per-turn `queueDreamMemoryExtractionAfterTurn` call sites in
`AgentRuntime`. `dreamMemoryExtractionEnabled` becomes the scheduled trigger's
config flag.

### Watermark / cursor

Add a per-agent (and isolation-respecting) **Dream watermark** — the last event
id processed by a successful pass — to the event store. Each pass:

1. Reads raw evidence (conversation messages + run records) **after** the
   watermark, bounded by a char/chunk budget (reuse #159's transcript budgets);
   chunk a large backlog across passes.
2. Runs extraction + consolidation against the **currently visible** memory
   (scoped by the session/agent isolation tier).
3. Advances the watermark on success only.

A periodic full-set re-consolidation (independent of the watermark) keeps the
memory line tidy even when little new evidence arrives — open question on cadence.

### Reuse from #159 (keep, don't rewrite)

- `buildDreamMemoryExtractionSpan` → generalize from "the last run" to
  "evidence since the watermark" (bounded/chunked). The source/provenance shape
  is unchanged.
- `buildDreamMemoryExtractionRequest` / `parseDreamMemoryActions` /
  `normalize*` — reused; extend the prompt + action schema to cover
  consolidation (merge/prune/contradiction-resolve) in addition to add/update/forget.
- `applyDreamMemoryActions` — reused verbatim for the write path, so the
  **isolation/provenance/dedup invariants and their regression tests carry over**:
  `read-only-global` writes nothing; `isolated` only touches in-scope entries;
  `add` tags `originWorkspace`, `update` preserves the entry's own; same-key
  update is a no-op; out-of-scope `memoryId` is skipped.

### Cost

One model call per Dream cycle instead of one per completed turn — a large
reduction for chatty sessions, and facts are extracted only after they have
settled (less add-then-forget churn).

### Foreground isolation (unchanged)

Dream stays fire-and-forget on a serial queue; a Dream failure can never break
or block a foreground turn (the #159 property, preserved).

## Open questions

- **Trigger signal set.** Which concrete signals: idle-timeout (value?),
  periodic wall-clock tick, app background/blur, explicit "consolidate now"? A
  model call needs the app alive + online, so `before-quit` can't host a long
  pass — likely idle-timer-while-running + periodic, with a best-effort short
  flush elsewhere. (The main process can use real timers; runtime scripts can't
  use `Date.now()`.)
- **Compaction's role.** Pure time-based per the PM direction — but
  `compaction.completed` already carries an addressable both-ends `source` range
  ([[agent-conversation-model]] distillation backbone). Is a compacted span a
  useful *unit* for a Dream pass to process, or is the watermark range enough?
  (Locator, not trigger.)
- **One pass vs two phases.** Extraction and consolidation in a single model
  call over (new evidence + current memory), or two sequential phases? Single
  pass is simpler; two phases may give cleaner consolidation prompts.
- **Watermark granularity / multi-conversation.** Per agent, per conversation,
  or per workspace? How to fold evidence from several conversations touched since
  the last pass.
- **Backlog budget / chunking.** Max evidence per pass; how to drain a large
  backlog without a huge single completion.
- **Full re-consolidation cadence.** How often to re-sweep the whole memory set
  (not just new evidence) for dedupe/contradiction-resolve.
- **Visibility.** Should a Dream pass surface in the future per-agent task panel
  (M2) as an observable background task?

## Relationship to existing work

- **Supersedes** the per-turn *trigger* from #159 (`agent-dream-extraction`);
  reuses its worker internals. Spec note: when this ships, update
  `agent-tool-design.md` / `agent-pi-mono-implementation.md` /
  [[agent-conversation-model]] §Memory to describe the scheduled trigger and
  flip the `- [ ] Offline consolidation pass (gated time + activity + lock)`
  item — this plan is that item's detailed design.
- **Depends on**: the M0 foundation (event log, run/conversation records),
  the #157/#158/#159 memory line (store, isolation, provenance, recall).
- **Builds toward**: memory v3 consolidation (M3) is the deeper cross-session
  version of the consolidation step introduced here.

## Checklist

- [ ] Define the Dream trigger gate (time + activity + lock); pick the concrete
  signal set (resolve the trigger open question with the PM).
- [ ] Add a per-agent Dream watermark/cursor to the event store; advance on
  successful pass only.
- [ ] Remove the per-turn `queueDreamMemoryExtractionAfterTurn` call sites; drive
  the worker from the scheduler. Repurpose `dreamMemoryExtractionEnabled`.
- [ ] Generalize the span builder to "evidence since watermark" (bounded,
  chunked); keep provenance shape.
- [ ] Extend the prompt + action schema with consolidation
  (dedupe/merge/prune/contradiction-resolve); keep `applyDreamMemoryActions`
  isolation/provenance invariants.
- [ ] Periodic full-set re-consolidation pass (cadence per open question).
- [ ] Tests: scheduled trigger fires once per cycle (not per turn); watermark
  advances and isn't reprocessed; consolidation dedupes/merges/resolves;
  isolation + `read-only-global` skip hold; foreground never blocked.
- [ ] Spec updates + flip the conversation-model offline-consolidation item.
