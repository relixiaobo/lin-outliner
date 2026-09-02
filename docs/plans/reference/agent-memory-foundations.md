# Memory Foundations — Binding Vocabulary

This standing reference defines the academic terms used by Memory documents,
prompts, and tools. It is not a unit of work and it does not own runtime status.
Current behavior and implementation authority live in
`docs/spec/agent-memory.md`; active work, if any, lives only in
`docs/TASKS.md`.

The product mapping below follows the current Daily Timeline Memory model. The
superseded Conversation/Run memory program, `MemoryEntry` pools, resident Memory
briefing, and model-visible `recall` tool are historical designs and reserve no
current protocol.

## Evidence Is Below Memory

Canonical Thread, Turn, and Item history is the record of what happened. It is
evidence, not memory. Memory is constructed from eligible evidence and published
as ordinary editable Nodes on the Daily Notes timeline.

This separation is load-bearing:

- raw Items remain canonical evidence;
- generated Memory Nodes are a public, editable interpretation of that evidence;
- exact `originItemId` lineage connects each generated statement to its support;
- private SQLite rows coordinate extraction, consolidation, ranking, rollback,
  and crash recovery, but contain no second public knowledge graph;
- compaction summaries exist to continue a Turn under a context budget and are
  not a substitute for source evidence.

## Store Taxonomy

The vocabulary follows the standard long-term-memory taxonomy (Squire), the
short/long distinction (Atkinson–Shiffrin), and working memory (Baddeley and
Hitch).

| Store | Academic meaning | Tenon mapping |
| --- | --- | --- |
| **Working memory** | The small-capacity active workspace holding what is in use now; not a durable store. | One Turn's assembled model context. Memory contributes compact routing instructions and, only when the model deliberately retrieves them, bounded Outline CLI results. |
| **Episodic memory** | Declarative memory for specific experienced events bound to context: what happened, when, and where. | Ordinary `#d-episode` Nodes under a canonical daily `#d-memory` container, with exact statement-level lineage to source Items. |
| **Semantic memory** | Declarative, context-reduced knowledge such as stable facts and preferences. | Ordinary `#d-belief` Nodes distilled from one or more supported episodes. |
| **Procedural memory** | Nondeclarative knowledge expressed as skills and procedures. | Skills. Procedural memory is outside the Memory extension and follows `docs/spec/agent-skills.md`. |

`#d-question` and `#d-guidance` are useful product categories inside an episode;
they are not additional academic memory stores. A question preserves unresolved
uncertainty. Guidance records a supported instruction for future handling.

## Processes

| Process | Academic meaning | Tenon mapping |
| --- | --- | --- |
| **Encoding** | Forming a trace from experience; depth, novelty, and prediction error influence selection. | Phase 1 selects durable signal from eligible canonical Items and produces bounded, source-dated episode groups. |
| **Consolidation** | Offline replay and integration that stabilizes or generalizes memory. | Phase 2 reconciles the bounded Daily Timeline Memory graph, merges duplicate generated episodes, preserves exact support, and never overwrites user-authoritative Nodes. |
| **Semanticization** | Repeated episodic content becoming context-reduced knowledge. | Supported episode statements may become or update `#d-belief` Nodes while retaining lineage. |
| **Retrieval** | Reactivating memory from a cue; cue quality depends on encoding context. | An eligible root Turn receives routing guidance and deliberately uses public `outline find` and `outline get`; no Memory-specific tool or passive prose injection exists. |
| **Reconsolidation** | An accessed trace becoming available for correction before restabilization. | Direct user edits are immediately authoritative; later model consolidation may modify only still-generated content from a newly validated snapshot. |
| **Forgetting** | Reduced access or deliberate removal of retained information. | Users can edit, move, trash, or delete ordinary Memory Nodes. Consolidation may remove unsupported generated subtrees, and confirmed Reset deletes canonical generated Memory containers. |

Retrieval practice, associative recall, metamemory, and strength-decay models are
research concepts, not implied product capabilities. They require an explicit
plan and evidence before acquiring runtime state or protocol.

## Structural Models

Three research models explain the chosen architecture without becoming extra
product entities:

- **Hippocampal indexing** (Teyler and DiScenna, 1986): an index binds detail
  traces rather than copying them. Tenon keeps bounded lineage from public
  Memory statements to canonical source Items.
- **Autobiographical hierarchy** (Conway, 2000): memory can move from specific
  events toward more general knowledge. Tenon's episode-to-belief hierarchy
  reflects that direction while preserving source links.
- **Complementary Learning Systems** (McClelland, McNaughton, and O'Reilly,
  1995): fast experience recording and slower generalization are distinct.
  Tenon's bounded Phase 1 extraction and Phase 2 consolidation preserve that
  separation.

Transactive memory and per-agent belief pools are not part of the current
single-product-agent Agent Core architecture. Do not infer either from the
academic literature.

## Engineering Divergences

Human-memory analogy stops where product correctness requires stronger rules:

1. **Public memory is inspectable.** Memory prose is ordinary outline content,
   not a hidden model state.
2. **Support remains auditable.** Generated statements retain exact Item
   lineage; the model may not invent or reconstruct evidence during retrieval.
3. **User edits outrank generation.** Editing text, category, tags, date, or
   parent identity relinquishes generated ownership rather than inviting a
   background overwrite.
4. **Forgetting may be destructive.** Ordinary deletion and confirmed Reset
   intentionally remove public Memory Nodes. Do not reuse the older
   "forgetting never deletes" rule.
5. **Retrieval is pull-based.** The model receives routing instructions, not a
   resident briefing, automatic associative injection, or a private recall API.
6. **Control state is not knowledge.** Eligibility, fingerprints, lineage,
   ranking, journals, and rollback rows remain private coordination data; they
   never become a second editable Memory store.

## Authoring Rules

1. Use an academic term only with its standard meaning. Do not invent
   near-academic labels or present a metaphor as implemented behavior.
2. Separate evidence, Memory content, and control state in every design. Items
   are evidence; Daily Timeline Nodes are public Memory; SQLite is coordination.
3. Describe extraction as encoding and offline graph reconciliation as
   consolidation. Do not call compaction, prompt assembly, or ordinary search
   consolidation.
4. Describe retrieval as the current public Outline CLI flow. Do not mention a
   resident Memory briefing, `recall`, principal pool, or automatic association
   unless a future approved plan deliberately reintroduces one.
5. Say `#d-episode`, `#d-belief`, `#d-question`, and `#d-guidance` when the
   product category matters. Do not flatten all four into generic facts.
6. State provenance precisely: generated statements cite exact source Items;
   user-authored or user-edited Nodes are authoritative even when no generated
   lineage remains.
7. Treat `docs/spec/agent-memory.md` as the behavior authority. This glossary
   constrains language and conceptual boundaries, not implementation details.
