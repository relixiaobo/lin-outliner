---
status: draft
priority: P1
owner: cc-2 (proposed; claim with the program one-pager)
created: 2026-06-10
updated: 2026-06-10
---

# Memory-theory realignment program

**Shape: (b) a SET of independent complete features** — Step 0 + PR-1…PR-5,
dependency-ordered, each shippable alone — plus one explicitly deferred mode.

This file is the **ratified-decision record and program charter**, written by
the main agent from the PM design session of 2026-06-10 (post-#181) so the
drafting agent needs no out-of-band context. **cc-2's one-pager duties remain:**
reconcile against the `agent-program` / `agent-conversation-model` /
`agent-data-model` trio, produce the usage-modes × zoom-ladder table, pin the
associative-mode data-gate threshold, and run per-PR collision checks. Where
this charter and the trio disagree, surface it — do not silently pick one.

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
| **Step 0** | Rewrite `agent-memory-foundations` + `agent-data-model` canonical table + `agent-architecture` § memory per D-1/D-4/D-6 | none (with PR-1) |
| **PR-1** | Person rule (D-2) + recall read surface (D-3) + Dream prompt guidance (D-9). No schema change; wipe old-format facts | none — **immediate**; zero overlap with #179 / run-unification |
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

## Open questions

- Associative-mode gate threshold (one-pager proposes; PM closes).
- Schema-node granularity & count budget (how many topics; min cluster size).
- PR-3 vs M3-B relative order (unpinned; whoever claims second re-checks).
