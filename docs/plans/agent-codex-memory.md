# Codex Memory On Outliner Nodes

## Goal

Add Codex-style durable Memory as a complete extension of the canonical
Thread/Turn/ThreadItem core while making Outliner Nodes the only published
Memory data model. Codex's eligibility rules, two-phase extraction and
consolidation pipeline, citations, usage ranking, forgetting, and bounded
retrieval remain the behavioral foundation; Tenon publishes their durable
results into one canonical Node subtree instead of a filesystem artifact tree.

The same Memory Nodes are visible and editable in the Outliner, read by the
agent through the existing Node tools, cited from `agentMessage` ThreadItems,
and used to build bounded Thread context. There is no parallel Memory card
store, file backend, renderer DTO, or hidden copy of the published knowledge.

This is one complete feature in one PR and depends on `agent-codex-core`. It may
run in parallel with `agent-codex-automations` after the core PR lands because it
owns only the Memory extension, pipeline control store, canonical Memory Node
subtree, and settings integration.

This is a clean replacement against empty userData. Old Dream data, `#d-*`
memory Nodes, chat-source bindings, schedules, ledgers, and storage are deleted
outside the runtime. Product code never detects, imports, migrates, or adapts
them.

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

The deliberate Tenon adaptation is the publication substrate: Codex Markdown
artifacts become ordinary Nodes under one reserved Memory root, and artifact
path/line citations become Node citations. This follows the same concepts
without creating a filesystem product inside an Outliner product.

## Non-goals

- Restore Dream as a Thread type, schedule, button, skill, history boundary, or
  user-facing metaphor.
- Preserve the former per-day `#d-memory`, `#d-episode`, `#d-belief`,
  `#d-question`, or `#d-guidance` taxonomy. Memory identity comes from containment
  under the canonical Memory root, not tags or journal dates.
- Add a `MemoryNode` type, hidden Memory blob, filesystem artifact root, vector
  store, embedding index, or second search implementation. Memory uses ordinary
  Outliner Nodes and the existing document index.
- Treat the whole Outliner as Memory or scan every Node automatically. Ordinary
  Nodes become evidence only when a Thread reads or mutates them, the user
  references them, or the user explicitly adds a Memory Inbox note.
- Let a foreground agent rewrite consolidated Memory as an untracked side
  effect. Explicit remember/forget/update requests create ordinary Inbox Nodes;
  the bounded consolidation pipeline reconciles them into published knowledge.
- Automatically install executable Skills from generated Memory. Reusable
  procedures remain Memory Nodes until a user explicitly promotes one through
  the Skill system.
- Read, convert, preserve, or delete old Memory selectively. Development
  userData is wiped in full before validation.

## Design

### 1. Ownership and canonical concepts

Add the feature under the core layout established by `agent-codex-core`:

```text
src/core/agent/
  memory.ts

src/main/agent/extensions/memory/
  MemoryExtension.ts
  MemoryControlStore.ts
  MemoryPipeline.ts
  MemoryNodeStore.ts
  Phase1.ts
  Phase2.ts

src/renderer/agent/memory/
  memorySettings.ts

<userData>/agent/
  memories.sqlite

Outliner document / Library
  Memory
    Summary
    Knowledge
    Sources
    Inbox
```

Memory uses five public concepts only:

- `ThreadMemoryMode`: `enabled | disabled`
- `Stage1Output`: one extracted raw Memory and rollout summary for a source Thread
- canonical Memory Nodes under the reserved root
- `MemoryCitation` attached to an `agentMessage` ThreadItem
- `Memory Reset` as a confirmed user command

Jobs, leases, fingerprints, usage counters, publication generations, reset
epochs, evidence cutoffs, and publication journals are private pipeline control
state. They are not Memory objects and are never rendered as Nodes or
ThreadItems.

`memories.sqlite` contains only that control state: source Thread versions,
job ownership and retry data, source Node IDs and hashes, selected versions,
usage counters, publication generation, subtree fingerprints, the current reset
epoch, per-Thread reset cutoffs, and prepared/finalized operation rows.
Model-readable Memory content is never canonical in SQLite; it is canonical only
in Nodes.

### 2. Canonical Memory subtree

`MemoryNodeStore` ensures one reserved, locked `Memory` root as a direct child of
`LIBRARY_ID`, plus four reserved structural children with deterministic IDs:

- `Summary`: bounded high-signal Memory loaded into enabled Threads
- `Knowledge`: consolidated preferences, decisions, facts, failure shields, and
  reusable procedures
- `Sources`: runtime-owned per-Thread Stage 1 evidence
- `Inbox`: user- or agent-authored remember/forget/update intent awaiting
  consolidation

The root and four structural containers are locked against rename, move, trash,
and deletion. Their descendants are ordinary content Nodes. Summary and
Knowledge descendants are user-editable and user changes are authoritative
inputs to the next consolidation. Inbox descendants are ordinary editable
Nodes. Sources descendants are runtime-owned and read-only because they preserve
extracted evidence and exact source provenance.

Each selected source Thread has one deterministic Source Node. Its own content
is the compact rollout summary; normalized raw Memory is represented by bounded
descendant Nodes. The control row binds that subtree to `threadId`, the ordered
eligible-origin evidence version, output hash, and usage data. Source Nodes are
inspectable and navigable but cannot become a second transcript or an execution
entity.

The locked Memory root also carries one private, non-model-readable operation
receipt in document metadata. A receipt contains only operation identity,
generation, and hashes needed to reconcile a committed Loro transaction with
the SQLite control journal after a crash. It is pipeline metadata, never a
second copy of Summary, Knowledge, Sources, Inbox, or model output, and is not
returned by Node tools or search.

No tag or Node type identifies Memory. Containment under the reserved root is
the complete membership rule. Standard Node IDs, RichText, references, search,
projection, Loro persistence, document commands, undo history, and Outliner UI
remain the only document machinery.

### 3. Eligibility and per-Thread mode

Persistent interactive root Threads default to `ThreadMemoryMode.enabled`.
Users can switch a Thread to `disabled`; the mode is persisted as Thread
configuration and affects both Memory use and generation for subsequent Turns.

The pipeline wakes after the document, stores, and ThreadService start and when
an eligible root Thread becomes idle. Each wake performs one bounded scan rather
than creating a timer per Thread. Phase 1 may claim only a persistent,
non-ephemeral interactive root Thread with no active Turn whose rollout passed
the idle grace period, remains inside the configured age window, and whose
eligible-origin evidence version changed since its last successful extraction.

Subagent Threads, standalone Automation Threads, `memory_consolidation` Threads,
Threads without memory-relevant user-authored work, and disabled Threads are
ineligible. A normal user Thread remains eligible when an Automation targets it,
but every automation-origin Turn is excluded from its evidence. A valid
extraction that finds no durable signal completes as `succeededNoOutput` and
publishes no Source Node.

Completing a web search or another result explicitly marked as external context
sets a private `polluted` extraction flag for that Thread. A polluted Thread is
excluded from Phase 1; if one of its prior outputs is currently selected, the
transition enqueues Phase 2 so unsupported Source and Knowledge Nodes can be
removed. `polluted` is pipeline control, not a third user-selectable Memory mode.

Disabling Memory removes Summary context and Memory-root discovery from the
Thread's Node-tool scope. A user can still attach or explicitly reference a
Memory Node as ordinary input; the runtime does not secretly use the rest of the
subtree.

### 4. Phase 1: Thread rollout to Source Nodes

Phase 1 reads the canonical rollout and first applies immutable Core provenance.
It rejects every Turn whose `TurnProvenance.trigger` is
`{ kind: "feature", feature: "automation", ... }`, including such Turns inside
an otherwise ordinary user Thread. It then rejects every inherited fork Item:
only Items whose ultimate `ItemProvenance.originThreadId` is the current Thread
are local evidence. A defensive global uniqueness check ensures that one
`originItemId` can contribute to at most one extraction even if the same history
is materialized in multiple Threads.

From that provenance-filtered rollout, Phase 1 retains only Memory-relevant
evidence:

- user messages and completed final agent messages
- completed command, file-change, MCP, dynamic-tool, and Node-tool calls and
  results
- explicit verification and task outcomes
- user corrections, repeated constraints, stable preferences, durable repo or
  workflow facts, and reusable failure prevention

It excludes developer/hook instructions, `AGENTS.md` and Skill injections,
reasoning, stream deltas, compaction machinery, transient status, and unrelated
runtime metadata. Node content enters Memory only through the bounded tool
arguments/results or explicit user references recorded in that Thread; the
pipeline never performs an unbounded document scan.

The source version is a deterministic fingerprint of the ordered eligible
`originItemId` plus each Item's canonical content hash. It is not the Thread's
`updatedAt`: excluded Automation Turns, copied fork prefixes, display-only edits,
and other irrelevant Thread changes cannot make old evidence new. Reset cutoffs
further remove all local Item positions at or before the recorded barrier.

One bounded internal extraction Turn produces `rawMemory`, `rolloutSummary`, and
an optional stable `rolloutSlug`. Secrets are redacted before publication. A
successful output is normalized into the deterministic Source subtree and
written through one canonical document-command transaction. Only after that
transaction commits does `memories.sqlite` mark the claimed source version
successful and record its Node IDs and output hash.

Claims use compare-and-set ownership tokens, lease expiry, bounded retry, and
source-version idempotence. A crash before the document transaction leaves no
published output; a crash after it is reconciled through the deterministic IDs
and hash, so retry cannot create duplicate Source Nodes. Every claim carries the
current reset epoch and rechecks it plus the Thread cutoff immediately before
publication; stale extraction work cannot cross a Reset.

### 5. Phase 2: global Node consolidation

Phase 2 acquires one global leased job and selects a bounded current set of
Source Nodes. It excludes sources beyond the unused-retention window and ranks
the rest by `usageCount`, then `lastUsage` or generation time, matching Codex's
current selection behavior.

The pipeline builds a bounded `MemoryChangeSet` from:

- added, changed, and removed selected Source subtrees since the last successful
  publication
- the current Summary and Knowledge subtrees
- unconsumed Inbox Nodes
- the last successful subtree fingerprints and publication generation

This Node change set replaces Codex's filesystem workspace diff; it has the same
purpose without creating Markdown files as another product surface. If selected
inputs and the Memory subtree are unchanged, Phase 2 succeeds without spending
a model Turn.

When work exists, Phase 2 starts an ephemeral internal Thread with
`threadSource=memory_consolidation`. It disables Memory, collaboration,
subagents, apps, plugins, network, and unrelated tools. The consolidation Turn
works against an isolated in-memory copy of the Memory subtree through the same
Node read/create/edit/delete semantics as the product. It may update Summary and
Knowledge, reconcile Inbox intent, and remove knowledge whose supporting Source
Nodes disappeared; it cannot mutate Sources or any Node outside the Memory root.

After the Turn succeeds, the host validates the resulting outline, computes its
canonical Node command set, and checks that every live Memory Node fingerprint
still matches the snapshot. A conflicting user edit aborts publication and
enqueues a fresh bounded attempt; it is never overwritten.

A conflict-free result crosses the Loro/SQLite boundary through a durable
publication journal:

1. SQLite first commits a `prepared` publication containing a unique
   `publicationId`, reset epoch, input fingerprints, selected source versions,
   consumed Inbox IDs, expected output hash, and canonical Node-command hash.
2. One DocumentService transaction applies the validated Node commands and
   writes the matching publication receipt into the locked Memory-root metadata.
3. SQLite then marks that prepared publication `finalized` and advances selected
   versions, consumed Inbox inputs, fingerprints, and publication generation
   from the prepared row. It never reconstructs those values from mutable live
   Nodes.

Startup reconciles this journal before any pipeline worker starts. A matching
root receipt proves the document transaction committed, so recovery only
finalizes SQLite and never reruns the model or treats that publication as a user
conflict. A user edit made after the receipt does not invalidate it: recovery
finalizes the publication first, then the changed live fingerprint or input
revision becomes input to the next consolidation. A prepared row without a
matching receipt did not publish; it is discarded and retried from a fresh
snapshot, with its model result reusable only when the reset epoch and every
input fingerprint still match. Any prepared row from an older reset epoch is
discarded without publication.

Failure leaves the live Outliner unchanged and releases or expires the lease for
bounded retry. There is no filesystem staging tree, Git baseline, partial Node
publication, or second document mutation path.

### 6. Node retrieval, explicit intent, and citations

Enabled Threads receive a bounded serialization of Summary descendants as
trusted application context. Detailed recall uses the existing `node_search` and
`node_read` tools constrained to the Memory root; the Memory extension does not
define parallel list/read/search tools or a private renderer backend.

When the user explicitly asks to remember, forget, or update something, the
foreground agent uses `node_create` to add one uniquely identified intent Node
under Inbox. It may read existing Memory Nodes to make the request precise, but
does not directly patch consolidated Knowledge. Inbox creation advances the
durable input revision and wakes Phase 2 immediately. Users may directly edit or
delete Summary, Knowledge, and Inbox descendants in the Outliner; those document
commands are authoritative and trigger the same reconciliation wakeup.

`agentMessage.memoryCitation` entries contain `nodeId` and `note`, plus the
supporting `threadIds`. Clicking a citation opens the Memory Node and can navigate
to the source Threads. A completed cited agent message updates the referenced
source evidence's `usageCount` and `lastUsage`; accounting is keyed by distinct
`originItemId`, so citations through an inherited fork cannot increase ranking a
second time. List/read/search operations alone do not count as use.

Deleting a Memory Node makes an old citation explicitly unavailable. Reusing an
ID for unrelated content is forbidden. Supporting Thread IDs remain the durable
route back to rollout evidence.

### 7. Reset and user surface

The user-visible noun is always `Memory`. The canonical Memory surface is the
Outliner subtree, not a card grid or duplicate Memory viewer. Library navigation
and search open ordinary Memory Nodes; Settings exposes the global feature
control, active Thread mode, pipeline freshness/error state, an Open Memory
command, and a confirmed Reset command.

Memory Reset means "forget current Memory and learn only from future evidence."
It never makes pre-reset history eligible again. Under the document/pipeline
write gate, the host records a monotonic `resetEpoch` and, for every existing
Thread, the stable terminal local-Item position that forms its evidence cutoff.
A Thread created after Reset starts beyond no cutoff and can contribute from its
first eligible local Item; an existing Thread can contribute only local Items
created after its recorded cutoff.

Reset itself uses a durable cross-store journal:

1. SQLite commits a `reset_prepared` row with `resetId`, next epoch, every
   per-Thread evidence cutoff, and the expected document-command hash. Preparing
   the row blocks new pipeline claims.
2. One DocumentService transaction clears every non-structural descendant under
   Summary, Knowledge, Sources, and Inbox and writes the matching reset receipt
   into locked Memory-root metadata.
3. SQLite finalizes the epoch and cutoffs, clears derived source jobs, leases,
   selections, Inbox consumption, usage, fingerprints, and publication rows,
   then unblocks claims. It preserves the reset epoch/cutoff rows and per-Thread
   `ThreadMemoryMode` choices.

Startup reconciles Reset before publication reconciliation or worker startup. A
matching root receipt completes SQLite finalization; a prepared Reset without a
receipt reapplies its idempotent document transaction and then finalizes. Work
from an older epoch cannot publish. Clearing jobs is therefore not equivalent to
clearing the historical barrier, and old rollouts inside the age window cannot
repopulate Memory. A future user-requested re-extraction of old history would be
a separately designed `Memory Rebuild`, not Reset behavior.

Renderer state contains only ordinary Outliner selection/expansion plus settings
status. Paths, line numbers, artifact trees, Dream history, memory cards, and a
second transcript do not exist.

### 8. Destructive replacement and documentation authority

The Core plan deletes the old Dream runtime, Channel, run profiles, Memory
actions, and agent event model before this plan begins. This plan additionally
deletes the old `memory-dream` Skill, Dream schedule/settings, `#d-*` prompts and
tags, chat-source Memory references, memory-owner identities, old Memory i18n,
and all obsolete tests and specs.

No product path recognizes an old Memory Node or directory. Fresh-userData tests
assert that only the new reserved Memory subtree and current control database are
created. A legacy-residue guard rejects Dream and the former timeline-memory
vocabulary in source, active specs, persisted keys, i18n, and UI; archived plans,
historical changelog entries, and this destructive removal section are the only
allowlist.

Add `docs/spec/agent-memory.md` as the sole current Memory authority. Core,
Thread rendering, Node tools, and settings specs link to it rather than
duplicating the subtree or pipeline model. The main integration gate archives
superseded plans and updates `docs/TASKS.md` and `CHANGELOG.md` after shipping.

### 9. Risks and mitigations

- **Memory becomes document clutter:** one reserved Library root contains the
  complete system; runtime-owned Sources stay grouped and collapsed instead of
  appearing on daily timelines.
- **Recursive or low-signal Memory:** source eligibility excludes child,
  standalone Automation and consolidation Threads; immutable Turn provenance
  excludes Automation Turns inside user Threads, and Phase 1 applies a strict
  no-output gate.
- **Fork-amplified evidence:** inherited Items preserve ultimate origin IDs;
  Phase 1 uses only locally originated Items and usage ranking counts each
  `originItemId` once.
- **Stale Node facts:** ordinary Nodes enter Memory only through Thread evidence,
  while current document questions continue to use live `node_read` results.
- **User edits overwritten by consolidation:** subtree fingerprints and an
  optimistic publication check abort on any conflicting edit.
- **Cross-store crash ambiguity:** prepared SQLite journals and locked-root
  receipts make publication and Reset idempotently reconcilable before workers
  start.
- **Reset resurrects forgotten history:** the retained reset epoch and per-Thread
  evidence cutoffs permanently exclude pre-reset rollout positions.
- **Partial document changes:** consolidation runs against an isolated copy and
  publishes one validated document transaction.
- **External context becomes personal Memory:** pollution removes the Thread from
  extraction and enqueues forgetting when it previously contributed.
- **Dual Memory truth:** SQLite contains only pipeline control; all published,
  model-readable, and user-visible Memory exists exclusively as Nodes.

### 10. Collision result

At drafting time, open PR #422 owns unrelated renderer date-count files. There
is no overlap. This plan consumes the Thread/Turn/MemoryCitation and mutation
causation contracts from `agent-codex-core`, then owns the Memory extension and
reserved Node subtree. It uses existing document commands and does not reopen
the shared ThreadItem union or Automation files.

## Open questions

None. Ratifying this plan ratifies Codex's two-phase Memory behavior on a
Node-only publication and retrieval model, the reserved Library subtree,
user-authoritative editable knowledge, read-only source evidence, Node citations,
and complete removal of Dream and all old Memory data.

## Implementation checklist

- [ ] Confirm `agent-codex-core` is merged and have the main agent add this plan
  to `docs/TASKS.md`; open the Draft PR claim.
- [ ] Define reserved Memory Node IDs, Node-backed `MemoryCitation`,
  `ThreadMemoryMode`, and the control-only `memories.sqlite` schema, including
  operation journals, reset epochs, and per-Thread evidence cutoffs.
- [ ] Implement root/container invariants, Memory-root Node visibility, settings
  navigation, and empty-userData creation.
- [ ] Implement bounded eligibility, leased Phase 1 extraction, deterministic
  Source Node publication, provenance filtering, origin evidence deduplication,
  redaction, no-output, and source-version idempotence.
- [ ] Implement bounded Phase 2 selection, Node change sets, isolated
  consolidation, fingerprint conflict detection, atomic document publication,
  receipt-based crash reconciliation, and forgetting.
- [ ] Integrate Summary context and Memory-root `node_search`/`node_read` scope
  for enabled Threads; prove disabled Threads receive neither implicitly.
- [ ] Implement Inbox intent creation and immediate coalesced consolidation
  wakeup; prove user edits win publication races.
- [ ] Implement Node citation navigation and citation-driven source usage
  accounting.
- [ ] Implement journaled Memory Reset with permanent history cutoffs while
  preserving structural Nodes and per-Thread modes; prove restart cannot
  repopulate Memory from pre-reset evidence.
- [ ] Delete Dream, `#d-*`, chat-source Memory, old profiles/actions/settings,
  old data readers, and all compatibility logic; add source/storage terminology
  guards.
- [ ] Rewrite active Memory, Node-tool, settings, and architecture specs around
  the canonical subtree.
- [ ] Validate from empty userData with `bun run typecheck`,
  `bun run test:core`, `bun run test:renderer`, focused provenance, fork, Reset,
  publication-crash, and E2E coverage,
  `bun run docs:check`, and `git diff --check`.
