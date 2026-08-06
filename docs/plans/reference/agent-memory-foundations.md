# Memory foundations — the academic model that binds our docs, prompts, and tools

A standing reference (like `nodex-parity-decisions.md`), not a unit of work.
**PM directive 2026-06-10:** the memory subsystem follows the academic
definitions of memory; PM examples are illustrative, never requirements. This
document is the binding glossary: every memory-related doc, prompt, and tool
description uses these terms with these meanings. The implementation mapping
lives in `agent-data-model.md` § *Canonical memory vocabulary*; this file owns
the definitions and the authoring rules. Rewritten 2026-06-10 per the
memory-theory realignment charter (`agent-memory-realignment` D-1/D-4/D-6) —
the previous revision equated the episodic store with the raw ledgers and
filed gist under the index; both were category errors, corrected below.

It is an engineering-binding glossary, not a literature review — each entry is
the textbook consensus plus the one source worth naming.

## 0. The ground truth is below memory

The raw conversation + run ledgers are the **world record** — the immutable,
event-sourced ground truth of what happened. They are *not* a memory store:
memory is **constructed over** the record, never identical with it (a person's
episodic memory is not the universe's history; it is their organized,
addressable take on it). Everything in the memory system — episodes, gist,
facts, schema nodes — is a derived, rebuildable structure whose down-pointers
bottom out in the record. This is the 源 (source) → 索引 (index) → 萃取
(distillation) frame: the source is below memory; the memory system starts at
the index.

## 1. Taxonomy of stores

The standard taxonomy (Squire's long-term memory taxonomy; Atkinson–Shiffrin
for the short/long split; Baddeley for working memory):

| Store | Definition | Key source | Ours |
|---|---|---|---|
| **Working memory** | the small-capacity active workspace holding what is currently in use; not a durable store | Baddeley & Hitch | the assembled context of one turn — the resident briefing is memory's slice of it |
| **Episodic memory** | declarative memory for specific experienced events, bound to their context ("what happened, when, where") | Tulving (1972) | the **episodic layer**: `AgentMemoryEpisode` units + their memory-owned gist, constructed over raw conversation/run ledgers |
| **Semantic memory** | declarative memory for context-free knowledge ("what I know"), detached from the episode that taught it | Tulving (1972) | `MemoryEntry` pools per Principal — a pool is one principal's **self-model**, keyed by its owner/believer (D-1) |
| **Procedural memory** | nondeclarative memory for skills and procedures ("what I can do"), expressed in performance rather than recollection | Squire | skills |

Structural models we adopt at the architecture level:

- **Hippocampal memory indexing** (Teyler & DiScenna 1986): the hippocampus
  stores an *index* binding distributed neocortical detail traces, not the
  details themselves; retrieval is pattern completion through the index. →
  our index layer is **pure bidirectional pointers** binding semantic facts to
  episodic evidence: `MemoryEntry.sources[]` fact→episode downward, episode →
  citing-facts reverse lookup upward. The index points; it never copies
  — and it never *holds content*: summaries/gist are episodic-layer content,
  not index (the previous revision's misfiling).
- **Autobiographical memory hierarchy / Self-Memory System** (Conway 2000):
  knowledge at graded abstraction — themes → general events → event-specific
  detail — with retrieval descending the hierarchy (generative retrieval) or
  jumping straight to a level (direct retrieval). → our **zoom ladder**
  (D-6): schema node → fact → episode gist → raw span, down-pointers at every
  step. Model-visible provenance zoom covers the lower three; full raw replay
  stays runtime-internal.
- **Complementary Learning Systems** (McClelland, McNaughton & O'Reilly 1995):
  a fast instance-learning store (hippocampus) and a slow generalizing store
  (neocortex), integrated by offline replay. This is *why* there are two stores
  and why consolidation is a background process, not a foreground action.
- **Transactive memory** (Wegner 1985): a group remembers by knowing *who
  knows what* and retrieving from each other, rather than every member copying
  everything. → the membership read: co-members subscribe to each other's
  semantic stores; nothing is copied across pools.

## 2. Two kinds of summary — production motive decides what is memory

Summary-shaped artifacts exist on both sides of the memory boundary; what
separates them is **why they were written** (R2/R6, PM-confirmed 2026-06-10):

- **Context-management artifacts** (compaction summaries, segment summaries)
  are **working-memory artifacts** — written to *continue a task* within a
  context budget. They live below memory, beside the raw record. They may
  serve as **locators** (a map to find candidate spans) but are **never
  evidence**: consolidating from them trains the system on a model's
  interpretation of a model's interpretation, amplifying omissions and topic
  bleed.
- **Episode gist** is **memory's own product** — written by the memory system
  to *remember* (autobiographical motive), and it is the consolidated evidence
  carrier. One node shape may serve both producers; only memory-owned
  production is part of the memory system. (The #178 "Dream reads compaction
  summaries as evidence" path had exactly this flaw and is replaced by
  fact → episode gist → raw span provenance.)

## 3. Processes

| Process | Definition | Key source | Ours |
|---|---|---|---|
| **Encoding** | the formation of a trace at experience time; depth of processing and *prediction error / novelty* modulate what gets encoded | Craik & Lockhart (levels of processing); novelty/PE-modulated encoding | what Dream's extraction instructions select from the evidence span |
| **Consolidation** | the offline (sleep-associated) process by which episodic traces are replayed and integrated into the semantic store; *systems consolidation* over time makes knowledge hippocampus-independent | CLS; sleep-replay literature | Dream: scheduled offline replay distilling into the semantic store; watermark = the consolidation frontier. Dream records memory-owned episode gist and facts cite the episode, never context-management summaries |
| **Semanticization** | the gradual transformation of repeated episodic content into context-free semantic knowledge | Tulving lineage | repeated evidence consolidating into a stable `fact` (we keep the receipts; see §5) |
| **Retrieval** | reactivating a trace from a cue: *cued recall* (cue → trace), *recognition*, *pattern completion* through the index; governed by **encoding specificity** (a cue works when it matches the encoding context) | Tulving & Thomson (encoding specificity) | three modes ([[agent-memory-realignment]] usage contract): chronic activation (the resident briefing), deliberate cued retrieval (`recall`, with source access down the index), automatic association (deferred — current turn as cue, runtime-surfaced) |
| **Forgetting** | loss of *access*, not erasure: an item's **storage strength** (how well learned) never decreases; its **retrieval strength** (current accessibility) decays with disuse | Bjork & Bjork, New Theory of Disuse | injection ranking by retrieval strength; entries fall out of the working set, never get deleted |
| **Retrieval practice (testing effect)** | the act of retrieval itself strengthens future retrievability — substantially more than re-exposure/restudy | Roediger & Karpicke (2006) | a `recall` hit strengthens an entry strongly; passive briefing injection weakly; both append `memory.accessed` events — the data the deferred associative mode needs |
| **Reconsolidation** | an accessed trace becomes temporarily labile and can be updated before re-stabilizing | Nader et al. (2000) | the update/invalidate path when review or new evidence touches an existing entry — updating on access is the *expected* dynamic, not corruption |
| **Metamemory** | knowing what one knows (feeling-of-knowing) before attempting retrieval | Nelson & Narens | the schema/overview layer: the briefing's breadth axis tells the model what it knows before it decides to dig; no-query `recall` returns the same overview |
| **Reconstructive retrieval** | human recall *reconstructs* from schemas + fragments and confabulates details | Bartlett (1932) | what we deliberately do NOT do — see §5 |

## 4. Agent-memory lineage (the bridge literature)

How the cognitive model has been carried into agent systems — the works our
mapping is consistent with:

- **CoALA** (Sumers et al. 2023): working / episodic / semantic / procedural as
  the standard agent-memory decomposition — our four stores follow it.
- **Generative Agents** (Park et al. 2023): memory stream + retrieval +
  *reflection* citing its supporting observations — Dream's shape, including
  provenance.
- **MemGPT** (Packer et al. 2023): explicit in-context vs external memory with
  paged retrieval — the resident-briefing vs `recall` split.
- **Sleep-time compute** (Letta 2025): background consolidation on idle —
  Dream's scheduling model.
- **HippoRAG** (2024): hippocampal indexing implemented over a corpus —
  validates index-not-copy as an engineering pattern.

## 5. Deliberate divergences from human memory (engineering, intentional)

State these in any doc that compares us to the human system; they are features:

1. **No reconstructive retrieval.** Human downward retrieval reconstructs and
   confabulates (Bartlett; misinformation effects). Ours is *lookup*: the raw
   record is immutable, `sources[]` dereference returns the original bytes or
   fails loud. Memory for an unreliable rememberer must be auditable.
2. **Receipts survive semanticization.** Humans typically lose the source
   episode once knowledge is semanticized; we keep `sources[]` forever, because
   an LLM's facts need verifiable provenance.
3. **Forgetting never deletes.** Bjork taken literally: only retrieval strength
   decays; removal from the pool is an explicit, logged `invalidate`.
4. **Pools are principal-isolated by construction.** Human memories blur
   together; our cross-principal boundary is a hard gate (distilled facts may
   cross by membership; raw evidence never does).
5. **Organization is projection, never stored state.** Strength, confidence,
   salience, episodes, schema nodes — anything organizational is a derived,
   rebuildable structure over the event log, not a stored field on an entry.

## 6. Binding authoring rules (docs, prompts, tools)

1. **Use the literature's exact term or none.** No invented near-academic
   vocabulary (banned by example: "heat tiers", "proves relevant"; corrected:
   "spacing effect" misused for the retrieval-practice effect).
2. **Every design anchor is one of:** an academic concept (cite it), a
   PM-ratified decision (link it), or verified code (`file:line`). A PM
   illustration may motivate a design; it may never *specify* one.
3. **Prompts speak the process they implement.** The Dream prompt is
   *consolidation* instructions and frames selection as *encoding* policy
   (what deserves a durable trace, with novelty/prediction-error weighting);
   the briefing presents itself as the *working-memory* slice of the semantic
   store; `recall`'s description is *cued retrieval* with optional *source
   access* — not ad-hoc phrases like "durable memory entries".
4. **Forgetting language never says delete.** User-facing copy says an entry
   is inactive/invalidated or has fallen out of the working set.
5. **Anthropomorphic framing is bounded by §5.** Docs may use the human-memory
   vocabulary precisely because the divergences are stated; never imply we
   reconstruct, blend, or irreversibly forget.
6. **One phrasing rule for stored facts** ([[agent-memory-realignment]] D-2):
   third-person-singular, subject-elided predicates in every pool; the subject
   stays normalized in the pool key; render is zone-tagged bullet lists — no
   subject prepending, no conjugation, no fully-named sentences (denormalizing
   the subject stales every fact on a rename).

The language-surface alignment to these rules shipped as
`agent-memory-academic-alignment` (#181, subsuming the former D2
encoding-signal delta). Realigning production/storage/use to the layering above
is the **`agent-memory-realignment`** program (PR-1 person rule + read
surfaces; PR-2 episodic layer; PR-3 forgetting + PR-5 schema/overview; PR-4
retrieval engine; automatic association deferred on a data gate).
