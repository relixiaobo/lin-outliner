---
status: superseded
priority: P2
owner: unassigned
phase: memory-realignment PR-2 (after run-unification, BEFORE M3-B)
created: 2026-06-10
updated: 2026-06-11
---

# Memory D3: the episodic index — episodes as a derived view + reverse lookup

> **Resequenced + reframed 2026-06-10 (PM-ratified, post-#181):** this plan is
> subsumed and upgraded by **memory-theory realignment PR-2** (see
> `docs/TASKS.md` Backlog § memory). Its true identity is **the missing
> episodic layer** (theory: raw ledgers are ground truth *below* memory), not a
> retrieval enhancement. Scope grows: memory-owned episode gist production
> (compaction summaries are a different, working-memory artifact — the #178
> "Dream reads compaction summaries as evidence" stopgap is deleted here);
> `AgentMemorySource` grab-bag → discriminated union
> (`{stream, streamId, range} | {episodeId}`); storage side of the 3-level zoom
> (fact → episode gist → raw span). It moves **before M3-B** and **after
> run-unification** (needs homogeneous `{seq, eventId}`). The realignment
> program one-pager (cc-2) rewrites this plan; the design below is the pre-
> realignment draft kept for its reverse-lookup/episode-view substance.
>
> **Archived 2026-06-11:** superseded by `agent-memory-realignment` PR-2. The
> PR-2 shape is `memory.episode_recorded` + `AgentMemorySource` union + fact →
> episode gist → raw span provenance; this draft's UI browse scope is deferred
> to later memory inspection work.

**Shape: (a) ONE complete feature in one PR.** Makes the index layer
bidirectional; the substrate M3-B cross-agent citing then builds on.

## Goal

The index between the semantic and episodic stores currently answers only one
direction well: *fact → evidence* (`sources[]` dereference, hardened by #178).
This PR adds the other direction and a browsable middle:

1. **Reverse lookup (episode → cognition):** for a conversation / run / span,
   enumerate the memory entries whose `sources[]` cite it — "what did I learn
   here?". Surfaced as (a) a runtime query (the invalidation reconciler already
   needs this internally — promote it to a real seam) and (b) UI: from a
   conversation, see the facts it produced; from a memory entry in Settings,
   jump to its evidence (if only one direction exists today, complete the pair).
2. **Episode as a derived view (not stored):** group a conversation's
   distillation segments into browsable "episodes" (id = span, title = the
   existing segment summary). Pure projection over the ledgers + summaries —
   **no new persisted noun** (the agent-memory-model review settled: an episode
   is *located raw*, not a stored kind).

## Hard constraints

- **No new stored types.** Episode = projection; reverse index = a derived
  index (rebuildable; if persisted as a cache, it follows the standing
  projected-state cache pattern with a rebuild oracle).
- **Principal isolation applies to the reverse direction too:** episode →
  cognition enumerates only entries whose `principal` == the requesting
  reader's own (the M3-B evidence-gate rule, mirrored).

## Design sketch

1. Reverse index projection: `conversationId/runId → entryIds` derived from
   `sources[]` at memory-projection build time.
2. Runtime query seam + the two UI affordances (conversation header / Settings
   memory entry).
3. Spec sync: data-model §4 gains the bidirectional-index statement; archive
   `done`.

## Non-goals

- NOT Zacks-style semantic segmentation of episode *boundaries* — boundary
  quality belongs to the compaction trigger-policy work (data-model OQ), not
  this plan; episodes reuse today's segment boundaries as-is.
- NOT retrieval ranking (D1/D4); NOT cross-principal browsing.

## Acceptance

- [ ] Reverse-lookup query returns exactly the citing entries (fixture with
      multi-source facts); principal-gated negative test.
- [ ] Episode view renders for a conversation with ≥2 segments; entries
      navigate both directions in UI (visual check light + dark).
- [ ] Rebuild oracle for the reverse index if cached.
- [ ] `bun run typecheck` + `bun run test:core` + renderer tests vs baselines;
      spec synced; plan archived `done`.

## Collision self-check (plan time 2026-06-10)

Touches memory projection + Settings/conversation UI. Post-M3-B (shares the
memory projection surface). Re-verify anchors + `gh pr list` at claim time.
