---
status: in-progress
priority: P1
owner: cc-2
created: 2026-06-10
updated: 2026-06-10
---

# Memory-theory realignment program

**Shape: (b) a SET of independent complete features** — Step 0 + PR-1…PR-5,
dependency-ordered, each shippable alone — plus one explicitly deferred mode.

This file is the **ratified-decision record and program charter**, written by
the main agent from the PM design session of 2026-06-10 (post-#181) so the
drafting agent needs no out-of-band context. cc-2's one-pager duties
(trio reconciliation · usage-modes × zoom-ladder table · associative-mode
data-gate threshold · per-PR collision checks) are **discharged and
PM-ratified** — see *Program one-pager* below. Claimed by cc-2 2026-06-10;
**Step 0 + PR-1 shipped (#183)**. Next runnable unit: PR-2, queued behind
run-unification.

## Goal

Realign memory **production, storage, and use** with the theoretical layering
(`agent-memory-foundations`): raw ledgers are ground truth *below* memory; the
episodic layer is constructed (episodes + gist), the index is pure bidirectional
pointers, the semantic store is per-principal, working memory is activation —
and usage follows the three human retrieval modes (chronic activation ·
deliberate recall · automatic association).

## Non-goals

- NOT a rewrite. The substrate is theory-correct and **stays**: event-sourced
  ledgers, per-principal pools, one-writer-per-pool, invalidate-never-delete,
  down-pointer addressability, the cross-principal isolation gate. (Lesson from
  the 2026-06-09 xhigh review: a theory-first draft re-invented half of
  `agent-data-model`; realign by clean cuts on the authority trio.)
- NOT M3-B sharing (it queues BEHIND PR-1 + PR-2; see Sequencing).
- NOT the automatic associative mode (explicitly deferred; see Deferred).
- Pre-release: **no migrations** — format-affecting changes wipe dev userData.

## Ratified decisions (each with its load-bearing rationale)

**D-1 · `principal` = pool owner / believer (whose self-model), NOT "the
subject this fact is about".** The current doc string claims subject-keying,
but the write paths implement believer-keying (each Dream writes only its
owner's pool; facts about others are wrapped as relationship facts). Believer-
keying is also the correct ontology (society of self-models: my knowledge of
you is my belief, living in my pool). Fix the documentation, not the mechanism.

**D-2 · Person rule: ONE phrasing rule for all pools — third-person-singular,
subject-elided predicates; render = zone-tagged bullet lists.** Today agent
pools store base-form ("verify a worktree's HEAD…") and user pools store
3rd-singular ("prefers terse reviews"), i.e. the verb conjugation bakes today's
single reader into storage; the renderer (`agentMemoryBriefing.ts` `toSentence`)
prepends a subject without conjugating, which goes ungrammatical the moment a
pool is read from the other side (user reading own pool as `<self>`; M3-B agent
B reading agent A's pool). Root cause: the **prose render** forces grammatical
subject-verb agreement; no single English verb form serves both 2nd and 3rd
person ("be" is the irreducible counterexample). Therefore: keep elision, drop
prose — zones render as bullet lists under `<self>` / `<principal name="…">`,
no subject prepending, no conjugation anywhere:

```
<memory>
<principal name="lixiaobo">
- prefers terse code reviews
</principal>
<self>
- verifies a worktree's HEAD before trusting a gate run
</self>
</memory>
```

**Explicitly rejected alternative — do NOT "improve" back to it:** storing
fully-named sentences ("lixiaobo prefers…"). It denormalizes the subject (the
pool key already carries it, like a foreign key); a display-name change would
silently stale every stored fact, and per-pool dedupe weakens. Scenario matrix
that drove this: S1 main-agent per-turn briefing · S2 recall · S3 Settings ·
S4 M3-B foreign-agent read · S5 user-as-reader (inward dialogue direction) ·
S6 rename. Elision+bullets passes all six; named sentences fail S6; the current
design fails S2/S4/S5.

**D-3 · `recall` visible output gains `principal`.** Today
`visibleRecallToolData` omits it, so cross-pool results ("prefers terse
reviews" vs "verify HEAD…") are distinguishable only by accidental verb form —
a live model-visible ambiguity since the #173 membership read.

**D-4 · The episodic layer is the missing theory layer; D3 is upgraded into it
(PR-2).** The canonical table currently equates the episodic store with the raw
ledgers; theory (and the PM's 源→索引→萃取 frame) puts raw BELOW memory as
ground truth — episodes as first-class indexed units are absent. Within PR-2:
episode = derived view with **memory-owned gist production**. Compaction
summaries are a DIFFERENT artifact (working-memory/context management, written
to continue a task) from episode gist (autobiographical, written to remember);
the #178 "Dream reads compaction summaries as evidence" path is a **stopgap and
is deleted in PR-2** — Dream reads episode gist; the context assembler may
later consume episode gist (dependency inverted, never the other way).
`DistillationNode` is reclassified as episodic gist content — it is NOT index
(the index is pure pointers; today only `sources[]`, forward-only).

**D-5 · `AgentMemorySource` 9-optional-field grab-bag → discriminated union**
`{stream: 'conversation' | 'run', streamId, range} | {episodeId}` — after
run-unification homogenizes coordinates to `{seq, eventId}`. Same taste ruling
as the #161 `AgentRunAnchor` union: explicit unions over optional-field soup.
Old fields die (pre-release wipe), not deprecated.

**D-6 · The zoom ladder is four levels, down-pointers at every step:**
schema node → fact → episode gist → raw span. Model-visible provenance zoom is
three levels (fact → gist → raw via `recall include_evidence`); full raw replay
stays runtime-internal. Schema nodes (PR-5) reuse PR-2's derived-node machinery
(A7: build the mechanism once) — they are derived, rebuildable, members = fact
ids; NOT stored fields on entries (the standing "strength/confidence/salience
are never stored fields" constraint extends here: organization is projection).

**D-7 · Usage contract = the three human retrieval modes, in this build order
(PM call):** deliberate recall correct first (PR-1) → data built (PR-2) →
**chronic activation** (PR-3 strengths + PR-5 schema overview; the briefing
becomes overview + strength-selected facts instead of bare newest-12; the
schema layer doubles as **metamemory** — feeling-of-knowing before digging) →
deliberate engine (PR-4, hybrid retrieval serving the `recall` tool only) →
**automatic association DEFERRED** (see below). Deliberate `recall` hits append
retrieval events starting PR-3 — the use-strengthens half of the Bjork loop,
and exactly the data the deferred mode needs (bootstrap: association thresholds
need strength data that only deliberate use generates).

**D-8 · Step 0 authority docs are REWRITTEN, not patched** — patching would
leave two generations of narrative interleaved.

**D-9 · Cross-pool duplication is prompt guidance, not mechanism**: the two
Dream prompts' own Good examples currently instruct the same fact into both
pools; agent-Dream guidance becomes "user preferences belong to the user pool
(readable via membership); the agent pool keeps genuinely relational/working
facts".

## Execution units

| Unit | Scope | Prereqs |
|---|---|---|
| **Step 0** | Rewrite `agent-memory-foundations` + `agent-data-model` canonical table + `agent-architecture` § memory per D-1/D-4/D-6 | **shipped #183** (with PR-1) |
| **PR-1** | Person rule (D-2) + recall read surface (D-3, reader-relative `subject`) + Dream prompt guidance (D-9). No schema change; old-format facts handled by manual dev-userData wipe | **shipped #183** |
| **PR-2** | Episodic layer (D-4) + sources union (D-5) + provenance-zoom storage side. Subsumes `agent-memory-episodic-index` | run-unification |
| **PR-3** | Two-strength forgetting (`agent-memory-forgetting`) + retrieval-event append on recall hits (D-7) | PR-2 |
| **PR-5** | Schema/overview layer (D-6) + briefing recomposition + no-query `recall` returns overview | PR-2 (machinery), pairs with PR-3 |
| **PR-4** | Hybrid retrieval engine for deliberate `recall` (`agent-memory-retrieval-upgrade`, rescoped) + zoom read side; embedding-provider PM gate at claim | PR-2 |

## Deferred — automatic associative retrieval

Runtime-owned per-turn background faculty: the current turn is the cue; top-k
relevant facts/gists auto-surface in the `[5]` volatile tail (the `[3]`/`[5]`
cache contract already reserves the slot; association is a digestion-side
faculty, the tool call is the volitional act). **Activation gate (PM): enough
data to associate well** — pool density + accumulated retrieval events; the
one-pager pins the measurable threshold; PM closes the gate at claim time.

## Sequencing & interactions

#179 (M3-A) → run-unification (also the episodic layer's coordinate
foundation) → PR-2; PR-1 + Step 0 run immediately in parallel. **M3-B hard
prerequisites now include PR-1 + PR-2** (cross-reading pools needs the
reader-independent person rule and the final sources union). PR-3-vs-M3-B
relative order is unpinned (both touch the briefing path — collision-check at
claim). Member plans were pointer-reconciled 2026-06-10 (`agent-program`
Phase 2, D1/D3/D4 frontmatter, `agent-cross-agent-memory` deps,
`agent-run-unification` note).

## Program one-pager (cc-2, PM-ratified 2026-06-10)

The four one-pager duties, discharged and ratified (PM: ① program yes ·
② R2 confirmed as restated · ③ gate threshold accepted).

### Reconciliation vs the trio (dispositions)

- **R1** — `agent-data-model` Extension §"The reframe" documents subject-keying
  ("key by who it is about"; "principal is the elided subject … subject and pool
  key are one field"). Per D-1 the Step 0 rewrite **includes the Extension
  wording**, not only the canonical table (D-8: no two-generation narrative).
- **R2 (PM-confirmed)** — `agent-conversation-model` "Dream evidence = raw;
  summaries are locators, not evidence" was written against context-management
  summaries. Restated boundary: **context-management artifacts (compaction /
  segment summaries) are locators only, never evidence; episode gist is
  memory's own product (written-to-remember) and the consolidated evidence
  carrier.** The interpretation-of-interpretation rationale survives — it now
  binds the artifact's *production motive*, not summaries per se.
- **R3** — the trailing "post-M3-B deltas D1/D3/D4" sequencing lines in the
  data-model canonical section and `agent-architecture` § memory are stale
  (PR-2 precedes M3-B); fixed in the Step 0 rewrite.
- **R4** — `agent-architecture` multi-agent table calls M3-B "publish/subscribe
  over distilled pools", contradicting the ratified no-publish-ACL membership
  rule; fixed with Step 0 (same doc).
- **R5** — D3's "no new stored types" hard constraint is restated for PR-2 as:
  **no new authority types**; episodes / gists / schema nodes are derived,
  rebuildable nodes following the projected-state-cache pattern (rebuild
  oracle required). The D3 plan file is rewritten at PR-2 claim time (after
  run-unification moves the anchors), per its own banner.
- **R6** — `DistillationNode` dual identity pinned: **one node shape, two
  producers**. Compaction-produced instances are working-memory artifacts
  (below memory; double as locators); PR-2's memory-owned production is the
  episodic gist of the canonical model. The Index row keeps pure pointers only.

Code verification of the charter's diagnoses (2026-06-10, this clone):
`toSentence` subject-prepend without conjugation (`agentMemoryBriefing.ts:110`);
base-form vs 3rd-singular split across the two Dream framings
(`agentDreamExtraction.ts:362` vs `:342`); the agent-pool Good example baking a
user fact into the agent pool (`:365`, the D-9 target); recall visible output
omitting `principal` (`agentRecallTool.ts:160`); the 9-optional-field
`visibleSource` soup (`:177`, the D-5 target).

### Usage modes × zoom ladder (the usage contract)

Ladder (D-6): **schema node → fact → episode gist → raw span** — model-visible
provenance zoom is the lower three; full raw replay stays runtime-internal.

| Usage mode | Human analog | Surface | Ladder access | Ships |
|---|---|---|---|---|
| **Chronic activation** | what you "just know" without trying; + metamemory (feeling-of-knowing) | resident `[3]` briefing; no-query `recall` returns the overview | breadth: schema overview; depth: strength-selected facts; never below fact level | PR-3 (strengths) + PR-5 (schema); today = newest-12 |
| **Deliberate recall + verification** | trying to remember, then checking the source | the `recall` tool (the volitional act) | query → facts; `include_evidence` zooms fact → episode gist → raw span | read surface correct in PR-1 → data in PR-2 → engine in PR-4 |
| **Automatic association** | what springs to mind unbidden | runtime-injected `[5]` volatile tail (slot reserved by the `[3]`/`[5]` cache contract) | current turn as cue; top-k facts/gists auto-surface | **deferred** (data gate below) |

PM-ratified build order (D-7) unchanged: deliberate recall correct first →
data built → chronic activation → deliberate engine → association when the
data supports it.

### Associative-mode data gate (PM-accepted numbers; PM closes at claim)

All three, each measurable from the live ledgers/projections:

1. **Pool density** — the reader's assembled read set (own + co-member pools)
   ≥ **100 active facts** (top-k=5 then draws from a ≥20× candidate pool, so
   association is selection, not wholesale injection).
2. **Usage data** — ≥ **200 retrieval events** accumulated (PR-3
   instrumentation), of which ≥ **50 are deliberate `recall` hits** (the
   strength signal must separate from pure recency — the use-strengthens half
   of the Bjork loop).
3. **Engine precondition** — PR-4 shipped (association reuses the same hybrid
   engine; no second retrieval stack).

### Per-PR collision checks (`gh pr list` 2026-06-10: #179 M3-A, #182 outliner)

- **Step 0 + PR-1** (one branch — A6: the bullet render and the docs that
  describe it land together): `agentDreamExtraction.ts` /
  `agentMemoryBriefing.ts` / `agentRecallTool.ts` + tests + authority docs.
  None in #179's scope; render signature unchanged → `agentRuntime.ts`
  untouched → **zero file overlap with #179** (verified, not assumed). Soft
  touch-point: #179 exercises the briefing render for foreign pools — whoever
  lands second rebases test expectations. `principal` in recall visible output
  needs no `src/core` protocol change (`AgentMemoryEntry.principal` exists).
  Old-format facts: phrasing-only change → manual dev-userData wipe, **no
  detector** (#180 invariant: content never trips a wipe).
- **PR-2** — sources union touches `src/core/agentEventLog.ts` = protocol
  surface (A4): coordinate at claim, consider interface-first. Strictly after
  run-unification, before M3-B. D3 plan rewritten then.
- **PR-3** — `memory.accessed`-class event = protocol surface (A4, flagged in
  its plan). Shares the briefing path with M3-B; relative order unpinned —
  second claimant re-checks.
- **PR-5** — recomposes the same briefing assembly as PR-3: serialize PR-3 →
  PR-5 or same claimant.
- **PR-4** — embedding-provider PM gate closes at claim.

## Open questions

- ~~Associative-mode gate threshold~~ — **closed 2026-06-10** (one-pager §gate,
  PM-accepted; PM re-confirms at the deferred mode's claim).
- Schema-node granularity & count budget (how many topics; min cluster size).
- PR-3 vs M3-B relative order (unpinned; whoever claims second re-checks).
