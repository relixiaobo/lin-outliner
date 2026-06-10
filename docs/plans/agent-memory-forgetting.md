---
status: draft
priority: P2
owner: unassigned
phase: memory-D1 (post-M3-B)
created: 2026-06-10
updated: 2026-06-10
---

# Memory D1: forgetting — the two-strength model

**Shape: (a) ONE complete feature in one PR.** Part of the canonical memory
frame (`agent-data-model.md` § *Canonical memory vocabulary*); closes the
standing "per-turn memory injection budget" open question.

## Goal

Give the semantic store a principled **forgetting** process (Bjork's two-strength
model): every memory entry has

- **storage strength** — how established the fact is; never decays; the only way
  out is the existing explicit `invalidate`;
- **retrieval strength** — how accessible it is *now*; decays with time and
  disuse, **rises when the entry is recalled or injected and proves relevant**.

Retrieval strength (composed with lexical relevance) governs the resident
briefing's ranking and budget — replacing the current "score-ranked relevant ∪
latest, dedupe to N" heuristic with one that lets stale entries *fall out of the
working set without being deleted*. Forgetting = falling off the briefing,
never erasure; `recall` can always reach low-strength entries (and doing so
restrengthens them — the spacing effect for free).

## Hard constraints (settled — do not re-open)

- **No new stored fields on `MemoryEntry`.** `confidence`/`salience`-like fields
  were explicitly rejected in the agent-memory-model review. Both strengths are
  **rebuildable projections** over events: createdAt, access events, invalidation.
- **Memory events are the single authority** ([[agent-event-log-one-shared-abstraction]]).
  If access tracking needs a new memory-ledger event type (e.g. `memory.accessed`
  with `{entryId, via: 'briefing'|'recall'}`), that is a protocol-surface addition —
  coordinate per A4, keep it replay-neutral, and consider write-amplification
  (batch per turn, not per entry; the #116/#117 lesson).
- **Never deletion.** Entries leave the briefing by strength, leave the pool only
  by explicit `invalidate`.

## Design sketch (dev settles the formula; the *shape* is pinned)

1. **Access events** appended when an entry is injected into a briefing or
   returned by `recall` (batched per turn).
2. **Strength projection** in the memory projected-state cache: retrieval
   strength = decay(time since last access) × boost(access count, recency);
   storage strength = monotone in (age, access count). Exact curve = reversible
   local (note in the PR; spaced-repetition literature is the guide).
3. **Briefing selection** (`buildMemoryReminder` path) ranks by
   retrieval-strength-weighted relevance under the existing entry cap; the cap
   itself can stay.
4. **Spec sync:** flip the data-model "Forgetting" row from target → built;
   close the injection-budget open question; archive this plan `done`.

## Non-goals

- NOT embedding/hybrid retrieval (D4); NOT changing what gets *written*
  (D2/Dream); NOT cross-principal behavior (strengths are per-pool, per-reader
  semantics unchanged).
- NOT a user-facing "importance" control — strengths are autonomous epistemic
  curation; the user's lever stays edit/invalidate in Settings.

## Acceptance

- [ ] Projection unit tests: decay over simulated time; restrengthen on access;
      invalidated entries excluded regardless of strength.
- [ ] Briefing test: a stale-but-active entry falls out of the briefing as
      fresher entries accumulate, and returns after a `recall` hit.
- [ ] Rebuild oracle: strength projection rebuilt from the event log equals the
      cached projection (the standing projection invariant).
- [ ] No per-entry write amplification (events batched per turn — assert in test).
- [ ] `bun run typecheck` + `bun run test:core` green vs baselines; spec synced.

## Collision self-check (plan time 2026-06-10)

Touches the memory ledger event union (protocol surface — coordinate per A4),
the memory projected-state cache, and the briefing path. Scheduled post-M3-B
(M3-B touches the same briefing path). Re-verify anchors + `gh pr list` at
claim time.
