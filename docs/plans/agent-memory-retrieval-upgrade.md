---
status: draft
priority: P3
owner: unassigned
phase: memory-realignment PR-4 (last; read side of the 3-level zoom)
created: 2026-06-10
updated: 2026-06-10
---

# Memory D4: retrieval upgrade — lexical → hybrid

**Shape: (a) ONE complete feature in one PR.** The acknowledged largest memory
debt; deliberately last (D1's strength signal and D3's reverse index feed it).

> **Carries one open PM gate (directional — must close before build):** the
> embedding provider. Options: (a) local model (offline, private, adds a binary
> + RAM); (b) provider API embeddings (quality, but memory text leaves the
> machine — a privacy step the plaintext-at-rest decisions never took); (c) no
> embeddings — upgrade to BM25 + strength + association signals only. The
> privacy dimension makes this the PM's call, not a dev local.

## Goal

Replace the lexical top-N ranking in `recall` and the briefing's relevance
scoring with a **hybrid retriever**:

- lexical (BM25-class) ∪ semantic similarity (if the gate ratifies embeddings)
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

- [ ] A retrieval eval fixture (queries with known-relevant entries, including
      paraphrase cases lexical ranking misses) shows strictly better hit-rate
      than the lexical baseline; the fixture lands as a regression test.
- [ ] Briefing + recall both use the hybrid ranker; latency budget measured
      (A9 — measure before trading; per-turn briefing must not regress
      perceived latency).
- [ ] Sidecar index (if any) has a rebuild path + test.
- [ ] `bun run typecheck` + `bun run test:core` vs baselines; data-model
      Retrieval row updated; plan archived `done`.

## Collision self-check (plan time 2026-06-10)

Touches recall/briefing ranking + possibly a sidecar index. Strictly after D1
(strength signal) and ideally after D3 (association source). Close the provider
gate with the PM at claim time; re-verify anchors + `gh pr list`.
