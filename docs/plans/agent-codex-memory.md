# Codex Memory On Daily Timeline Nodes

## Goal

Add Codex-style durable Memory as a complete extension of the canonical
Thread/Turn/ThreadItem core while preserving Tenon's native product model:
Memory and the daily timeline are one editable Outliner graph. Codex's
eligibility rules, two-phase extraction and consolidation pipeline, citations,
usage ranking, forgetting, reset behavior, and bounded retrieval remain the
behavioral foundation; their durable results are published as ordinary tagged
Nodes beneath source-date Daily Nodes.

Each date has at most one generated-headline `#d-memory` container. Its
`#d-episode` descendants record durable episodes or observed patterns;
`#d-belief`, `#d-question`, and `#d-guidance` descendants express stable model
updates, unresolved tension, and future handling. These are the only public
Memory categories. There is no separate Library Memory root, Summary,
Knowledge, Sources, Inbox, card store, filesystem artifact tree, or hidden copy
of published Memory.

The same Memory Nodes are visible and editable on the timeline, read by the
agent through existing Node tools, cited from `agentMessage` ThreadItems, and
used to derive bounded Thread context. Codex supplies the pipeline; Tenon's
daily outline supplies the canonical product expression.

This is one complete feature in one PR and depends on the complete
`agent-codex-core` replacement. It may run in parallel with
`agent-codex-automations` after Core lands because it owns only the Memory
extension, pipeline control store, tagged timeline Nodes, and settings
integration.

This is a clean replacement against empty userData. Old Dream data, chat-source
bindings, schedules, ledgers, and stores are deleted outside the runtime. The
`#d-*` vocabulary is intentionally selected again for the new design, but no old
Node, tag identity, prompt, watermark, or persistence format is detected,
imported, migrated, or treated as compatible.

The reference baseline is OpenAI Codex commit
`841e47b8fb113a201b68e0f1f5790ba22836a241`, especially:

- `codex-rs/memories/README.md`
- `codex-rs/memories/write/src/start.rs`
- `codex-rs/memories/write/src/phase1.rs`
- `codex-rs/memories/write/src/phase2.rs`
- `codex-rs/memories/write/templates/`
- `codex-rs/memories/read/`
- `codex-rs/state/src/runtime/memories.rs`
- `codex-rs/state/memory_migrations/0001_memories.sql`

The deliberate Tenon adaptation is the publication substrate. Codex Markdown
artifacts become a date-oriented Node graph, artifact citations become Node and
Thread provenance, and Codex's generated summary becomes a bounded derived
briefing rather than another stored Memory object.

## Non-goals

- Restore Dream as a Thread type, Channel, schedule, button, Skill, transcript,
  history boundary, or user-facing metaphor. Memory consolidation is an
  internal Core extension workflow.
- Preserve any old Dream or timeline-memory data. Reusing the five category
  names is a current product decision, not a migration or compatibility layer.
- Add a reserved Library Memory root, `MemoryNode` type, hidden Memory blob,
  filesystem artifact root, vector store, embedding index, or second search
  implementation.
- Treat the whole Outliner as Memory or scan every Node automatically. Ordinary
  Nodes become evidence only when a Thread reads or mutates them, the user
  references them, or the user explicitly requests a Memory change.
- Record an assistant-action diary. An episode must preserve a durable fact,
  correction, preference, decision, workflow pattern, or unresolved tension
  about the user or work; routine transcript texture and narration that the
  agent performed a task are excluded.
- Automatically install executable Skills from generated Memory. Reusable
  procedures remain `#d-guidance` until a user explicitly promotes one through
  the Skill system.
- Add model-callable Memory-specific tools. Retrieval and explicit user-directed
  changes reuse the canonical Node tools.

## Design

### 1. Ownership and canonical concepts

Add the feature under the Core layout established by `agent-codex-core`:

```text
src/core/agent/
  memory.ts

src/main/agent/extensions/memory/
  MemoryExtension.ts
  MemoryControlStore.ts
  MemoryPipeline.ts
  TimelineMemoryStore.ts
  Phase1.ts
  Phase2.ts

src/renderer/agent/memory/
  memorySettings.ts

<userData>/agent/
  memories.sqlite

Outliner document / Daily Notes
  2026-07-21
    <generated daily memory headline>  #d-memory
      <episode or observed pattern>    #d-episode
        <stable model update>          #d-belief
        <unresolved tension>           #d-question
        <future handling note>         #d-guidance
```

Memory uses these public concepts only:

- `ThreadMemoryMode`: `enabled | disabled`
- `Stage1Output`: bounded daily episode candidates extracted from one source
  Thread version
- the five ordinary tagged timeline Node categories
- `MemoryCitation` attached to an `agentMessage` ThreadItem
- `Memory Reset` as a confirmed user command

Jobs, leases, fingerprints, usage counters, publication generations, reset
epochs, evidence cutoffs, immutable Turn admission snapshots, active-Turn
exclusions, generated-node lineage, and publication journals are private
pipeline control state. They are not Memory objects and are never rendered as
Nodes or ThreadItems.

`memories.sqlite` contains only that control state: source Thread versions, job
ownership and retry data, generated Node IDs and hashes, selected episode
versions, evidence lineage, usage counters, publication generation, timeline
fingerprints, the current reset epoch, per-Thread reset cutoffs, immutable
per-Turn Memory admission rows, excluded active Turn IDs, and prepared/finalized
operation rows. Published model-readable Memory content is canonical only in
Nodes.

### 2. Canonical daily Memory graph

`TimelineMemoryStore` declares these deterministic current tag identities:

| Tag | Fixed Node ID |
|---|---|
| `#d-memory` | `tag:d-memory` |
| `#d-episode` | `tag:d-episode` |
| `#d-belief` | `tag:d-belief` |
| `#d-question` | `tag:d-question` |
| `#d-guidance` | `tag:d-guidance` |

At document startup, before renderer or agent document mutations are admitted,
the host ensures all five through Core's already-landed
`ensure_document_system_tag_definition` contract. Their definitions keep the
same identity and canonical name, cannot be renamed, moved, trashed, deleted,
merged, retyped, unlocked, or replaced through public commands, and survive
feature disable and Memory Reset. Users and causation-authorized foreground Node
tools may still apply or remove the tags from content Nodes. Memory does not
recognize old tag identities or adopt a same-named personal tag. Standard Node
IDs, RichText, tags, references, Daily Nodes, search, projection, Loro
persistence, document commands, and Outliner UI remain the only content
machinery.

The generated canonical shape is:

- one direct `#d-memory` child under a source-date Daily Node, created only when
  that date has durable Memory worth publishing
- a concise generated daily headline as the container content, never the fixed
  label "Memory"
- one or more direct `#d-episode` children for replayed episodes or observed
  patterns
- zero or more `#d-belief`, `#d-question`, and `#d-guidance` descendants under
  the episode whose evidence they share

An episode does not need every child category. Beliefs are concise,
self-contained statements that name their subject. Questions exist only for
useful unresolved uncertainty; guidance exists only when it should change future
behavior. Prior Memory is a belief graph to reconcile, never self-confirming
evidence.

Source date is the local calendar date of the eligible source Turn or explicit
user Memory request, not the date on which a background worker happens to run.
On the first eligibility claim for an origin Turn, Memory resolves its
`startedAt` through the then-current application timezone and persists that
`YYYY-MM-DD` assignment with the origin evidence row. Retries, later Thread
versions, and timezone changes reuse the assignment rather than moving old
Memory between dates. Phase 1 groups a Thread's evidence by source date. A
multi-day Thread may ensure and update multiple Daily Nodes in one atomic
publication, while retries reuse the same prepared Node IDs and cannot create a
second same-day container.

All published Memory descendants are ordinary user-editable Nodes. Users may
edit, move within the canonical daily Memory shape, merge, or trash them. A
direct user edit is authoritative pipeline input: optimistic fingerprints prevent
a concurrent consolidation from overwriting it, and the next attempt reconciles
from the user's version. Removing a category tag or moving a Node outside a
`#d-memory` container removes it from canonical Memory; adding a reserved Memory
tag makes a Node canonical Memory only when it satisfies the same date/container
hierarchy. A canonical `#d-memory` container is the Reset ownership boundary, so
everything intentionally nested beneath it moves and is deleted with that
container even when a child is untagged or has a malformed category placement.
A reserved-tag placement outside every canonical container remains ordinary
non-Memory outline content and is surfaced in diagnostics; the pipeline neither
ingests, deletes, nor silently relocates it.

Memory consumes Core's generic projection-neutral `DocumentSystemReceipt`. Its
receipt is scoped by namespace `agent.memory` and `DAILY_NOTES_ID`, but lives in
Core's private document receipt map rather than on any Daily or Memory Node. It
contains only operation identity, generation, and a digest needed to reconcile a
committed Loro transaction with SQLite after a crash. It cannot enter Node
projection, tools, search, renderer IPC, or model context.

Publication and Reset use Core's host-only
`put_document_system_receipt` command in the same non-user-undoable
DocumentService transaction as their Node commands. Tag initialization uses the
already-landed host-only `ensure_document_system_tag_definition` command. This
plan adds no Node field or shared command. Phase 1 model work may run
independently, but every Phase 1, Phase 2, explicit host reconciliation, and
Reset document commit is serialized through one Memory document-write gate, so
the single latest receipt for `(agent.memory, DAILY_NOTES_ID)` cannot be
overwritten before its SQLite row is finalized.

### 3. Eligibility and per-Thread mode

Persistent interactive root Threads default to `ThreadMemoryMode.enabled`.
Users can switch a Thread to `disabled`; the mode is persisted as Thread
configuration and affects both Memory use and generation for subsequent Turns.

Mode changes and Turn admission are serialized by the same per-Thread admission
barrier. Before a root-user Turn is accepted, the Memory extension durably writes
an immutable admission row keyed by `turnId` with `eligibleAtAdmission` and the
current `resetEpoch`; ThreadService does not record its first Item or start side
effects until that write commits. A missing admission row fails closed as
ineligible. Orphan rows prepared for Turns that never become durable are removed
during startup reconciliation.

`eligibleAtAdmission` is true only when the Thread is an eligible persistent
interactive root and its mode is `enabled` at that exact admission boundary. It
never changes afterward. Disabling a Thread therefore excludes every later Turn
accepted while disabled; re-enabling affects only newer Turns and cannot make
the disabled interval eligible retroactively. An already active Turn keeps its
admission value because mode changes apply to subsequent Turns.

The pipeline wakes after the document, stores, and ThreadService start and when
an eligible root Thread becomes idle. Each wake performs one bounded scan rather
than creating a timer per Thread. Phase 1 may claim only a persistent,
non-ephemeral interactive root Thread whose current mode is `enabled`, with no
active Turn, whose rollout passed the idle grace period, remains inside the
configured age window, and whose eligible-at-admission evidence version changed
since its last successful extraction.

Subagent Threads, standalone Automation Threads, `memory_consolidation` Threads,
Threads without memory-relevant user-authored work, and currently disabled
Threads cannot be claimed. A normal user Thread remains claimable when an
Automation targets it, but every automation-origin Turn is excluded from its
evidence. A valid extraction that finds no durable signal completes as
`succeededNoOutput` and publishes no container or episode.

Completing a web search or another result explicitly marked as external context
sets a private `polluted` extraction flag for that Thread. A polluted Thread is
excluded from Phase 1; if it previously contributed generated Memory, the
transition enqueues Phase 2 to reconcile unsupported Nodes. `polluted` is
pipeline control, not a third user-selectable Memory mode.

Disabling Memory removes the derived Memory briefing and implicit tagged-memory
discovery from the Thread. A user can still attach or explicitly reference a
Memory Node as ordinary input; the runtime does not secretly use the rest of the
timeline Memory graph.

### 4. Phase 1: Thread rollout to daily episodes

Phase 1 reads the canonical rollout and first applies immutable Core provenance.
It first rejects every Turn whose durable Memory admission row is missing or has
`eligibleAtAdmission=false`; this decision is never recomputed from the Thread's
current mode. It then rejects every Turn whose `TurnProvenance.trigger` is
`{ kind: "feature", feature: "automation", ... }`, including such Turns inside
an otherwise ordinary user Thread. It then rejects inherited fork Items: only
Items whose ultimate `ItemProvenance.originThreadId` is the current Thread are
local evidence. A defensive global uniqueness check ensures one `originItemId`
can contribute to at most one extraction even when history is materialized in
multiple Threads.

From that provenance-filtered rollout, Phase 1 retains only Memory-relevant
evidence:

- user messages and completed final agent messages
- completed command, file-change, MCP, dynamic-tool, and Node-tool calls and
  results
- explicit verification and task outcomes
- user corrections, repeated constraints, stable preferences, durable repo or
  workflow facts, decisions, and reusable failure prevention

It excludes developer/hook instructions, `AGENTS.md` and Skill injections,
reasoning, stream deltas, compaction machinery, transient status, and unrelated
runtime metadata. Node content enters Memory only through bounded tool
arguments/results or explicit user references recorded in that Thread; the
pipeline never performs an unbounded document scan.

The source version is a deterministic fingerprint of ordered eligible
`originItemId` values plus each Item's canonical content hash. It is not the
Thread's `updatedAt`: excluded Automation Turns, copied fork prefixes,
Turns admitted while Memory was disabled, display-only edits, and other
irrelevant Thread changes cannot make old evidence new. Reset cutoffs remove
local Item positions at or before the barrier, and retained Reset exclusions
remove every Item belonging to a Turn active at that barrier regardless of when
the Item completed.

One bounded internal extraction Turn produces a high-signal `Stage1Output`
grouped by source date. Each non-empty group contains an episode summary plus
optional candidate beliefs, questions, and guidance. Secrets are redacted before
publication. The output is normalized into the canonical tagged daily shape and
written through one document-command transaction. New generated Nodes use IDs
allocated in a `stage1_prepared` control row, so a retry reuses exactly the same
IDs and same-day container rather than duplicating Memory. The same transaction
invokes `put_document_system_receipt` with the Stage 1 operation ID, reset epoch,
and digest of its expected Node commands and output hashes.

Only after that transaction commits does `memories.sqlite` finalize the source
version and record its Node IDs, evidence lineage, and hashes. Claims use
compare-and-set ownership tokens, lease expiry, bounded retry, and
source-version idempotence. On startup, a matching system receipt finalizes the
prepared row without rerunning extraction; a row without a matching receipt is
retried from a fresh snapshot. A later user edit is handled after finalization as
new authoritative input rather than mistaken for a failed Stage 1 publication.

Every claim carries the current reset epoch and rechecks it, the Thread cutoff,
and the active-Turn exclusion set immediately before publication. Stale
extraction work cannot cross Reset.

### 5. Phase 2: global timeline consolidation

Phase 2 acquires one global leased job and selects a bounded current set of
generated and user-edited `#d-episode` Nodes. It may exclude untouched generated
evidence beyond the unused-retention window; an episode authored or edited by
the user is never removed merely because it is old. It ranks the remaining
generated evidence by `usageCount`, then `lastUsage` or generation time,
matching Codex's current selection behavior.

The pipeline builds a bounded `MemoryChangeSet` from:

- added, changed, and removed selected episode groups since the last successful
  publication
- the current relevant `#d-memory` containers and category descendants on their
  source dates
- direct user edits and explicit foreground Memory operations since the last
  publication
- the last successful timeline fingerprints and publication generation

This Node change set replaces Codex's filesystem workspace diff. If selected
inputs and the relevant timeline graph are unchanged, Phase 2 succeeds without
spending a model Turn.

When work exists, Phase 2 starts an ephemeral internal Thread with
`threadSource=memory_consolidation`. It disables Memory, collaboration,
subagents, apps, plugins, network, and unrelated tools. The consolidation Turn
works against an isolated in-memory copy of the selected daily Memory graph
through the same Node read/create/edit/move/delete semantics as the product. It
may merge duplicate episodes, update beliefs, expose or resolve questions,
revise guidance, remove unsupported generated Memory, and regenerate affected
daily headlines. A user-edited headline is authoritative input and is not
blindly regenerated. The Turn cannot mutate ordinary Nodes outside the selected
`#d-memory` containers.

After the Turn succeeds, the host validates the tagged hierarchy, computes its
canonical Node command set, and checks that every live selected Memory Node
fingerprint still matches the snapshot. A conflicting user edit aborts
publication and enqueues a fresh bounded attempt; it is never overwritten.

A conflict-free result crosses the Loro/SQLite boundary through a durable
publication journal:

1. SQLite commits a `prepared` publication containing a unique
   `publicationId`, reset epoch, input fingerprints, selected episode versions,
   affected Daily and Memory Node IDs, expected output hash, and canonical
   Node-command hash.
2. One DocumentService transaction applies the validated Node commands and
   invokes Core's host-only `put_document_system_receipt` with the matching
   publication ID, generation, and prepared-record digest.
3. SQLite marks the publication `finalized` and advances selected versions,
   fingerprints, lineage, usage state, and publication generation from the
   prepared row. It never reconstructs them from mutable live Nodes.

Startup reconciles this journal before any pipeline worker starts. A matching
system receipt proves the document transaction committed, so recovery only
finalizes SQLite and never reruns the model or treats that publication as a user
conflict. A later user edit does not invalidate the receipt: recovery finalizes
first, then the changed fingerprint becomes input to the next consolidation. A
prepared row without a matching receipt did not publish; it is discarded and
retried from a fresh snapshot, with its model result reusable only when reset
epoch and every input fingerprint still match. A prepared row from an older
reset epoch is discarded without publication.

Failure leaves the live Outliner unchanged and releases or expires the lease for
bounded retry. There is no filesystem staging tree, Git baseline, partial Node
publication, or second document mutation path.

### 6. Retrieval, explicit intent, and citations

Enabled Threads receive a bounded derived briefing assembled from current
high-ranked `#d-belief` and `#d-guidance` Nodes, with Node IDs for provenance.
The briefing is recomputed and never stored as Summary, a hidden Memory object,
or a duplicate Node. Detailed recall uses existing `node_search` and `node_read`
over the five Memory tags inside Daily Notes; the Memory extension defines no
parallel list/read/search tools or private content backend.

When the user explicitly asks to remember something in a Turn admitted with
Memory enabled, the foreground root Thread uses ordinary Node commands to ensure
today's single `#d-memory` container and create or update the appropriate episode
and category Nodes. Explicit update or forget requests search and read the
relevant Memory Nodes, then edit, move, or trash them directly. These
user-directed changes are authoritative immediately and wake Phase 2 for global
reconciliation. There is no Memory Inbox or delayed intent object.

Unsolicited foreground Memory writes are excluded by prompt and tool policy. A
Memory-graph mutation is any document transaction whose pre/post image applies
or removes a reserved tag, edits/moves/deletes a reserved-tagged Node, mutates a
descendant of a canonical container, or changes ancestry so content enters or
leaves the canonical hierarchy. The Node command path preflights that entire
change set and validates command causation: direct renderer/user edits, explicit
foreground root-user Turns, and host-owned MemoryExtension publications are
valid; Automation, Subagent, and unrelated feature Turns cannot mutate Memory or
turn a stray tagged Node into canonical Memory. This is a content-integrity
invariant, not an approval or filesystem permission mode.

For an explicit foreground root-user Turn, the Node-tool adapter also resolves
its immutable Memory admission row. A Memory-graph mutation is allowed only
when that row has `eligibleAtAdmission=true`, its `resetEpoch` equals the current
epoch, and its `turnId` is absent from the retained Reset exclusion set. A Turn
admitted while Memory is disabled receives a structured Memory-disabled result
for explicit remember/update/forget; the user can still edit the Nodes directly.
Every Memory-graph mutation, including a direct renderer edit, first acquires the
Memory document-write gate; Reset holds that gate from its snapshot through epoch
finalization. Validation occurs before the enclosing command's
DocumentService transaction applies any Node command, so rejection cannot create
canonical Memory or partially apply that transaction. Direct renderer/user edits
waiting behind Reset remain valid afterward because they are new intentional
document actions; host-owned MemoryExtension publications use their journaled
current epoch. An old active Turn may continue ordinary work after Reset, but
any delayed explicit remember/update/forget mutation returns a structured
stale-Memory-epoch failure and cannot recreate Memory.

Generated-node lineage in `memories.sqlite` maps each Memory Node to supporting
`threadId`, `turnId`, and distinct `originItemId` values. It is rebuildable
provenance/index state, not Memory content. The Outliner can navigate from a
generated Memory Node to its supporting Threads without embedding an old
`[[chat:...]]` syntax or creating source child Nodes.

`agentMessage.memoryCitation` entries contain `nodeId` and `note`, plus
supporting `threadIds`. Clicking a citation opens the Memory Node in its Daily
Node context and can navigate to source Threads. A completed cited agent message
updates the referenced evidence's `usageCount` and `lastUsage`; accounting is
keyed by distinct `originItemId`, so an inherited fork cannot increase ranking a
second time. List/read/search operations alone do not count as use.

Deleting a Memory Node makes an old citation explicitly unavailable. Reusing an
ID for unrelated content is forbidden. Supporting Thread IDs remain the durable
route back to rollout evidence.

### 7. Reset and user surface

The user-visible noun is always `Memory`; episode, belief, question, and guidance
are its visible timeline categories. The canonical surface is the Daily Notes
outline, not a separate Memory viewer. Settings exposes global feature control,
active Thread mode, pipeline freshness/error state, an Open Memory command that
opens a tagged timeline search, and a confirmed Reset command. Selecting a
result opens its actual Daily Node context.

Memory Reset means "forget current Memory and learn only from future Turns." It
never makes pre-reset history or a Turn already active at Reset eligible again.
Reset acquires both the document/pipeline write gate and ThreadService's
Turn-admission barrier. No root Thread or Turn can be accepted while Reset
snapshots current rollouts and prepares its durable operation.

For every existing persistent interactive root Thread, the host records the
stable terminal local-Item position as its evidence cutoff plus the ID of its
currently active Turn, if any. Phase 1 requires that an Item is after the cutoff
and its ultimate `originTurnId` is absent from the retained Reset exclusion set.
The active Turn remains excluded as one indivisible unit even if it later records
tool results, agent messages, steering input, or terminal state. Reset does not
interrupt it or roll back its side effects. A Thread or Turn accepted after the
barrier is released is post-reset and may contribute from its first eligible
local Item.

Reset itself uses a durable cross-store journal:

1. SQLite commits a `reset_prepared` row with `resetId`, next epoch, every
   per-Thread evidence cutoff, every excluded active Turn ID, all canonical
   daily Memory container IDs, and the expected document-command hash.
   Preparing the row blocks new pipeline claims.
2. One confirmed, non-user-undoable DocumentService transaction permanently
   deletes only the snapshotted canonical `#d-memory` containers through the
   existing `delete_node` command, then invokes Core's host-only
   `put_document_system_receipt` with the matching Reset ID, epoch, and
   prepared-record digest. A reserved-tag Node that is not inside a valid
   source-date Daily Node/container hierarchy is ordinary non-Memory content: it
   and its complete subtree survive Reset unchanged and remain diagnostic-only.
   The five protected tag definition Nodes remain available for future Memory.
3. SQLite finalizes the epoch and cutoffs, clears generated-node lineage, source
   jobs, leases, selections, usage, fingerprints, and publication rows, then
   releases the Turn-admission barrier and unblocks claims. It preserves the
   reset epoch, cutoff rows, immutable Turn admission rows, active-Turn
   exclusions, and per-Thread modes.

Startup reconciles Reset before ThreadService accepts a Turn, before publication
reconciliation, and before any worker starts. A matching receipt completes
SQLite finalization; a prepared Reset without a receipt reapplies its idempotent
document transaction and then finalizes. Old timeline Memory and post-reset
completions of an excluded Turn cannot repopulate Memory through extraction or
direct Node-tool mutation. Re-extracting old history would be a separately
designed `Memory Rebuild`, not Reset behavior.

The Reset regression contract is explicit: a user message accepted before
Reset, plus tool results, steering input, and a final agent message written by
that same Turn after Reset, contribute no evidence; an attempted reserved-tag
Node mutation from that Turn is atomically rejected; and the first eligible Turn
accepted after the barrier does contribute. A stray tagged Node and its untagged
descendants survive Reset byte-for-byte, while a canonical daily Memory
container is deleted. The same results must hold after a crash at each journal
boundary and restart.

Renderer state contains only ordinary Outliner selection/expansion, the tagged
search projection, and settings status. Paths, line numbers, artifact trees,
Dream history, memory cards, and a second transcript do not exist.

### 8. Destructive replacement and documentation authority

Core deletes the old Dream runtime, Channel, run profiles, Memory actions, and
agent event model before this plan begins. This plan additionally deletes the
old `memory-dream` Skill, Dream schedule/settings, prompts, chat-source syntax,
memory-owner identities, old Memory i18n, and all obsolete tests/specs. It then
defines fresh current tag identities and new pipeline behavior for the five
retained `#d-*` names.

No product path recognizes an old Memory Node, tag ID, ledger, or directory.
Fresh-userData tests assert that the current tag definitions, tagged daily
Memory graph, and current control database are the only Memory structures
created. A residue guard rejects Dream, the fixed
`Memory/Summary/Knowledge/Sources/Inbox` container hierarchy, old chat-source
syntax, and old scheduler/storage vocabulary in current behavior; it explicitly
permits the five ratified daily Memory category names.

Add `docs/spec/agent-memory.md` as the sole current Memory authority. Core,
Thread rendering, Node tools, Daily Notes, tags, and settings specs link to it
rather than duplicating the pipeline or hierarchy. The main integration gate
archives superseded plans and updates `docs/TASKS.md` and `CHANGELOG.md` after
shipping.

### 9. Risks and mitigations

- **Daily timeline clutter:** publish nothing for no-signal dates, enforce at
  most one generated-headline container per date, and downselect aggressively.
- **Distributed graph becomes hard to bound:** the five-tag index, source-date
  hierarchy, control fingerprints, retention window, and usage ranking bound
  selection without a Library root.
- **Recursive or low-signal Memory:** eligibility excludes child, standalone
  Automation, and consolidation Threads; immutable Turn provenance excludes
  Automation Turns inside user Threads; Phase 1 applies a strict no-output gate.
- **Fork-amplified evidence:** inherited Items preserve ultimate origin IDs;
  Phase 1 uses only locally originated Items and usage ranking counts each
  `originItemId` once.
- **Prior Memory self-confirms:** generated Memory is a hypothesis graph;
  consolidation requires current Thread evidence or authoritative user edits.
- **User edits are overwritten:** timeline fingerprints and optimistic
  publication checks abort on any conflict and retry from the user version.
- **Cross-store crash ambiguity:** prepared SQLite journals and Core system
  receipts make publication and Reset idempotently reconcilable before workers
  start.
- **Reset resurrects forgotten history:** retained cutoffs exclude pre-reset
  positions, retained active-Turn IDs exclude their later completions, and old
  admission epochs reject their delayed reserved-tag mutations.
- **Reset deletes ordinary notes:** only canonical daily `#d-memory` containers
  are deletion units; invalid reserved-tag placements remain diagnostic-only
  ordinary content and survive with their subtrees.
- **Disabled evidence is backfilled:** immutable per-Turn admission rows exclude
  Turns accepted while disabled even after the Thread is re-enabled.
- **Reserved tag identity drifts:** fixed `tag:d-*` IDs are installed and locked
  through Core's host-only system-tag contract before public document mutation.
- **External context becomes personal Memory:** pollution excludes the Thread and
  enqueues reconciliation when it previously contributed generated Memory.
- **Dual Memory truth:** SQLite holds control/provenance only; all published,
  model-readable, and user-visible Memory content exists exclusively as tagged
  Daily Nodes.

### 10. Collision result

At drafting time, open PR #422 owned unrelated renderer date-count files. There
is no overlap. This plan consumes Core's Thread/Turn/MemoryCitation, mutation
causation, extension admission-barrier, projection-neutral system-receipt, and
protected system-tag-definition contracts. It uses existing Daily Node, tag,
search, and Node command machinery plus the already-landed host-only receipt and
tag-ensure commands; it does not reopen `src/core/types.ts`,
`src/core/commands.ts`, the shared ThreadItem union, or Automation files.

## Open questions

None. Ratifying this plan ratifies Codex's two-phase Memory behavior over the
five-category daily timeline graph, source-date publication, generated daily
headlines, fixed protected tag identities, admission-time Memory eligibility,
user-authoritative edits, derived briefing plus Node-tool retrieval, Node/Thread
citations, canonical-container-only Reset deletion, complete removal of Dream,
and complete deletion rather than migration of all old Memory data.

## Implementation checklist

- [ ] Confirm the complete `agent-codex-core` replacement is merged and have the
  main agent add this plan to `docs/TASKS.md`; open the Draft PR claim.
- [ ] Define current deterministic tag identities, `ThreadMemoryMode`,
  Node-backed `MemoryCitation`, tagged hierarchy validation, and the control-only
  `memories.sqlite` schema, including journals, lineage, immutable Turn admission,
  reset cutoffs, and retained active-Turn exclusions.
- [ ] Ensure and lock the five fixed `tag:d-*` definitions through Core's
  host-only system-tag contract before public document mutation; prove same-ID
  restore and public definition-mutation rejection.
- [ ] Implement source-date grouping, at-most-one generated-headline
  `#d-memory` container per date, no-output behavior, and empty-userData tag
  creation.
- [ ] Implement bounded Phase 1 eligibility, immutable provenance filtering,
  admission-time mode filtering, origin evidence deduplication, tagged episode
  publication, redaction, prepared-receipt reconciliation, source-version
  idempotence, and pollution handling.
- [ ] Implement bounded Phase 2 selection, tagged Node change sets, isolated
  consolidation, daily headline/category reconciliation, fingerprint conflict
  detection, receipt-based crash recovery, and forgetting.
- [ ] Integrate the derived bounded briefing and tagged `node_search`/`node_read`
  recall for enabled Threads; prove disabled Threads receive neither implicitly.
- [ ] Implement explicit foreground remember/update/forget through existing Node
  tools, pre/post Memory-graph causation validation across tag and ancestry
  changes, and immediate coalesced consolidation wakeup.
- [ ] Implement Memory citation navigation, source-Thread navigation, and
  citation-driven evidence usage accounting.
- [ ] Implement journaled Reset across all daily Memory containers with
  permanent history cutoffs, active-Turn exclusions, stale-epoch mutation
  rejection, and stray-tag preservation; prove restart cannot repopulate Memory
  from extraction or direct Node mutation.
- [ ] Delete Dream, old chat-source Memory, profiles/actions/settings, old tag
  identities, old readers, and every compatibility path while retaining only the
  five ratified category names; add storage and terminology guards.
- [ ] Rewrite active Memory, Node-tool, Daily Notes, tags, settings, and
  architecture specs around the canonical timeline graph.
- [ ] Validate from empty userData with `bun run typecheck`,
  `bun run test:core`, `bun run test:renderer`, focused hierarchy, provenance,
  fork, Automation/Subagent exclusion, disable/activity/re-enable, user-edit and
  retention races, active-Turn Reset evidence and Node mutation, stray-tag Reset
  preservation, fixed-tag identity/locking, every publication-crash boundary,
  and E2E coverage, `bun run docs:check`, and `git diff --check`.
