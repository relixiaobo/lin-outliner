---
status: done
priority: P3
owner: codex
phase: memory-realignment PR-4 (last; read side of the 3-level zoom)
created: 2026-06-10
updated: 2026-06-12
---

# Memory D4: retrieval upgrade — lexical → hybrid

**Shape: (a) ONE complete feature in one PR.** The acknowledged largest memory
debt; deliberately last (D1's strength signal and D3's reverse index feed it).

> **PM gate closed for this PR:** no embeddings. PR-4 ships BM25-class lexical
> ranking + retrieval strength + query-time `sources[]` co-citation association
> for `recall`; resident briefing uses retrieval strength plus source co-citation
> support, with no current-turn cue. Local/API embeddings remain separately
> ratifiable later upgrades.

## Goal

Replace the lexical top-N ranking in `recall` and the briefing's relevance
scoring with a **hybrid retriever**:

- lexical (BM25-class) for cued `recall`
- composed with D1's retrieval strength (accessibility) and
- light association expansion via D3's index (entries sharing sources/episodes
  with strong hits get a secondary boost — spreading-activation-lite, **without
  storing a graph**: associations are derived from `sources[]` co-citation at
  query time).

Same `recall` tool surface, same briefing caps — only the ranking inside gets
smarter. No new tools (settled: the single `recall` is the surface).

## Hard constraints

- No stored graph (the family-② rejection stands; associations are derived).
- No new stored fields; embeddings, if ratified, live in a rebuildable sidecar
  index keyed by entry id (wipe-and-rebuild on format change, per the
  no-back-compat policy).
- The recall tool contract (`query/limit/include_evidence/max_chars`) is
  unchanged.

## Acceptance

- [x] A retrieval eval fixture (queries with known-relevant entries, including
      paraphrase cases lexical ranking misses) shows strictly better hit-rate
      than the lexical baseline; the fixture lands as a regression test.
- [x] Briefing + recall both use the hybrid ranker; latency budget measured
      (A9 — measure before trading; per-turn briefing must not regress
      perceived latency).
- [x] Sidecar index (if any) has a rebuild path + test. Not applicable: the
      PM-ratified PR-4 default uses no embeddings and no sidecar index.
- [x] `bun run typecheck` + `bun run test:core` vs baselines; data-model
      Retrieval row updated; plan archived `done`.

## As built

The production ranker is `src/core/agentMemoryRetrieval.ts`. `recall` uses the
hybrid query path: BM25-class lexical relevance + retrieval strength +
query-time `sources[]` co-citation association. The resident briefing uses the
same module's cue-less chronic-activation path: retrieval strength remains the
base signal, while `sources[]` co-citation lightly boosts facts that travel with
already-accessible entries. It does not use the current turn as a cue, so
automatic association remains deferred. The regression fixture compares the old
lexical baseline against the hybrid ranker with neutral memory ids and verifies
strictly better top-k hit-rate for co-cited paraphrases; an event-store test
pins the production query path.

## Collision self-check (plan time 2026-06-10)

Touches recall/briefing ranking + possibly a sidecar index. Strictly after D1
(strength signal) and ideally after D3 (association source). Close the provider
gate with the PM at claim time; re-verify anchors + `gh pr list`.
