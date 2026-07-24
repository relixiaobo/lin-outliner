# Agent Memory

Memory is an Agent Core extension over the canonical Thread, Turn, Item, and
Node models. It is not an Automation, Thread type, card store, hidden document,
or second knowledge graph. The public source of truth is ordinary editable
Nodes on the Daily Notes timeline; private SQLite state only coordinates
eligibility, extraction, consolidation, provenance, ranking, rollback, and
crash recovery.

## Daily Timeline Model

The host owns five deterministic protected tag definitions:

| Category | Tag | Definition ID |
| --- | --- | --- |
| Memory day | `#d-memory` | `tag:d-memory` |
| Episode | `#d-episode` | `tag:d-episode` |
| Belief | `#d-belief` | `tag:d-belief` |
| Question | `#d-question` | `tag:d-question` |
| Guidance | `#d-guidance` | `tag:d-guidance` |

Their identities, names, definition type, lock state, and Schema ownership are
host-controlled. Public commands may apply or remove these tags from content
Nodes but cannot mutate, move, trash, delete, merge, or replace the definitions.

A canonical generated graph has this shape:

```text
Daily Notes
  YYYY-MM-DD  #day
    generated daily headline  #d-memory
      episode                  #d-episode
        stable fact            #d-belief
        unresolved question    #d-question
        future handling        #d-guidance
```

Generation reuses the existing canonical container for a source date and creates
at most one generated container for that date. Category Nodes are descendants of
an episode and remain ordinary RichText Nodes with ordinary tags, references,
navigation, editing, move, and Trash behavior. The source date is frozen from
the origin Turn's local calendar date when evidence is first claimed; later
timezone changes do not move it.

A reserved-tag placement outside a source-date Daily Node and canonical
`#d-memory` container is ordinary non-Memory content. Memory status reports the
current stray-node count without exposing Node IDs; the pipeline does not
ingest, relocate, or delete that content. A canonical container is the Reset
ownership boundary, including malformed or untagged descendants that the user
intentionally nested beneath it.

Direct user edits are authoritative. Text, tag set, category, source date, and
parent identity are all part of the generated fingerprint. Changing any of them
prevents background publication from overwriting the Node. Removing a Node from
the canonical graph drops generated control ownership and leaves the moved Node
as ordinary outline content.

## Modes And Admission

`MemoryFeatureMode` is the global `enabled | disabled` privacy control.
`ThreadMemoryMode` is the matching per-Thread control for persistent root user
Threads. Both default to `enabled`.

Before ThreadService records the first Item of a root Turn, Memory persists an
immutable admission snapshot containing the global and Thread modes, their
derived eligibility, feature generation, reset epoch, visibility generation,
and admission time. Missing snapshots fail closed. Re-enabling Memory never
makes activity admitted during a disabled interval eligible.

Only persistent root user Turns admitted while both modes are enabled may use or
generate implicit Memory. Automation-origin Turns inside an otherwise ordinary
Thread, Subagent Threads, inherited fork Items, internal Memory Threads,
ephemeral Threads, and external-context-polluted Threads are excluded by their
canonical provenance. One ultimate `originItemId` can belong to only one
extraction source.

Global disable is a linearized privacy boundary. It acquires the host Turn
admission barrier and Memory document gate, atomically persists the new feature
generation plus exclusions for active root Turns, suspends and aborts the
current Memory worker, then interrupts and waits for those root Turns. Their
complete Items remain excluded after re-enable. Existing Memory Nodes remain
visible and directly editable, but are neither implicitly read nor generated.

Thread disable applies to subsequent admissions. An already admitted Turn keeps
its immutable admission result. The mode transition uses the same Memory write
gate as publication: after the disable request returns, no publication prepared
under the old mode can commit.

## Extraction

One bounded worker scan considers at most two recent idle root Threads at
startup, within a ten-day age window and after six hours of idle time. Later
eligible idle transitions enqueue the same durable per-Thread job rather than a
timer per Thread.

Phase 1 builds a deterministic source version from every ordered, locally
originated, eligible Item and canonical content hash. The version covers the
complete eligible stream even when model input is limited to the latest 500
Items and 120,000 characters, so a long Thread never stops becoming dirty. It
includes user messages, final agent messages, completed tool evidence,
verification, corrections, stable
preferences, decisions, workflow facts, and reusable failure prevention. It
excludes reasoning, injected instructions, transient status, copied fork
prefixes, Automation Turns, disabled/reset-excluded Turns, and unbounded document
scans. Web or other external context marks the Thread polluted and withdraws its
generated support.

An internal hidden ephemeral `memory_consolidation` Thread runs the configured
model with tools, Skills, plugins, MCP servers, network, collaboration, and
Memory disabled. Hidden internal Threads do not publish renderer notifications
or invoke ordinary extension admission, context, Item, lifecycle, or tool hooks;
the model receives the exact Memory system prompt without Skill preparation or
the general interactive-agent prompt. Strict bounded JSON produces zero or more
source-date episode groups. Every headline, episode, belief, question, and
guidance statement carries a non-empty, exact set of supplied `originItemId`
values from that source date; lineage is recorded per statement rather than per
day. Secret-like content is redacted before publication.
A no-signal result withdraws that source's old generated lineage and schedules
global cleanup.

Under the Memory write gate, Stage 1 rechecks modes, exclusions, rollback state,
source version, and pollution, then rebuilds every target from the current graph.
It prepares canonical `node:<uuid>` IDs, exact lineage, feature generation, reset
epoch, command digest, target fingerprints and authority states, and a unique
publication generation in `memories.sqlite` without releasing the gate. It then
applies all Node commands and one projection-neutral `agent.memory` system
receipt in a single non-user-undo document transaction. A generated Node whose
fingerprint changed during model work is first promoted to user-authoritative
and is never overwritten. The trusted transaction resolves only after workspace
bytes containing both Nodes and receipt are durably flushed; SQLite finalizes
source state only after that durable commit.

## Consolidation

Phase 2 selects a bounded global set of canonical Memory Nodes. User-authored or
user-edited Nodes always remain input. Untouched generated Nodes rank by citation
usage and recency and may age out of selection after ninety unused days, while
unsupported Nodes remain eligible for cleanup.

The internal model receives an isolated bounded graph snapshot and returns an
exact change set. It may keep or update generated headlines and categories,
delete a complete generated subtree, merge duplicate generated episodes by
updating one and deleting the other complete subtree, or create an episode or
category beneath an existing or newly created canonical parent. Every created
or updated Node names selected source Nodes with current terminal evidence. The
host allocates real IDs, replaces the affected Node's complete lineage, and
validates hierarchy, selection, authority, descendants, and evidence before
producing document commands.

Unsupported generated Nodes rank ahead of ordinary consolidation input and are
cleaned in bounded deepest-first batches. A generated ancestor inherits current
descendant evidence when possible. If an ordinary or user-authoritative
descendant makes deletion structurally impossible, the ancestor relinquishes
generated ownership and becomes authoritative rather than keeping rollback
suppression open forever. Each partial batch journals a distinct follow-up job.

Deletion fails closed if any descendant is unselected, ordinary, or
user-authoritative. User-authoritative Nodes cannot be updated or deleted by the
model. Create operations cannot target a deleted or non-canonical parent.

Phase 2 acquires the Memory write gate before preparing publication, then
rechecks every structural input fingerprint, the complete identity of every
deletion subtree including ordinary descendants, mode generation, reset epoch,
and the exact ordered rollback set. It writes a durable journal containing
canonical commands, output fingerprints, deletion-subtree fingerprints, new
generated records, complete lineage, and rollback IDs without releasing the
gate. The document
transaction writes the matching receipt; finalization uses only journaled state,
never mutable live Nodes. A rollback is reconciled only after every remaining
canonical generated Node has current evidence or is deleted.

## Retrieval And Node Tools

An eligible Turn receives a bounded derived briefing from visible beliefs and
guidance. The briefing is recomputed and is never stored as another Memory
object. The existing `node_search` and `node_read` tools remain the detailed
retrieval surface.

Implicit Node-tool projections omit generated Nodes suppressed by a prepared or
committed history rollback, Nodes without current evidence, and all canonical
Memory when the Turn is ineligible. A visible authoritative descendant is
promoted rather than hidden with a suppressed generated parent. If control state
is missing or unreadable, implicit Memory fails closed. A Node explicitly
attached or referenced by the user remains ordinary supplied input and bypasses
implicit discovery filtering.

There are no model-callable Memory-specific tools. An eligible foreground root
Turn may use ordinary Node tools to remember, update, or forget only when the
user message explicitly requests that operation. Renderer-authored edits remain
ordinary user mutations. Automation, Subagent, excluded, stale-generation, and
unrelated feature Turns cannot change the canonical Memory graph. Every agent
Node mutation carries exact Thread, Turn, and Item causation. The mutation
classifier evaluates command owners, targets, and destination parents: creating
an ordinary sibling directly under a Daily Note is not a Memory mutation, while
writing beneath a canonical container or changing a container/date ancestor is.
Agent `outline_undo_stack` undo/redo carries the same causation and passes through
the same coordinator and fail-closed guard because history can restore Memory
that is absent from the current projection.

When a final response used derived Memory, Core appends a canonical commentary
Item containing `memoryCitation`. The renderer treats it as a dedicated,
always-visible citation row immediately below the final response, not as part of
the earlier collapsed process block. Each entry links to the real timeline Node
and the citation links only to supporting source Threads that still exist and
are active/navigable. Archived and deleted Threads produce no dead link. Deleting
a source Thread does not delete already published Memory Nodes or their retained
evidence; those Nodes remain user-editable until ordinary editing, consolidation,
or Reset changes them. Usage counts distinct current `originItemId` values, so
copied fork history cannot inflate ranking.

## Rollback And Reset

Completed history remains auditable. Editing the latest user input appends a
Core rollback marker and starts a replacement Turn in the same Thread; it does
not undo file, document, process, MCP, Goal, or external side effects.

Before Core appends that marker, Memory durably prepares an invalidation with
the exact rollback ID, omitted Turn IDs, before/after projection versions, and
the affected generated Node set. The visibility generation advances
immediately, so replacement Turns cannot read stale generated Memory. Commit
withdraws omitted origin and citation support and enqueues Phase 1 and Phase 2.
Core retries a failed idempotent commit hook in-process; startup matches any
stranded preparation against the complete durable marker before admitting new
Turns.

Reset means "forget current Memory and learn only from future Turns." Under the
host admission barrier and Memory write gate it advances the reset epoch and
retains every active Turn ID as an indivisible exclusion. Phase 1 accepts only
Turns whose immutable admission snapshot carries the current epoch, so rollback
or replacement cannot move an Item across a positional boundary. One document
transaction permanently deletes the snapshotted canonical `#d-memory`
containers and every descendant inside them, including untagged ordinary notes,
then writes the Reset receipt. Notes outside those containers and stray tagged
subtrees survive. SQLite finalization clears generated content indexes, lineage,
source state, citations, rollback invalidations, and jobs while preserving
feature mode, Thread modes, admission snapshots, exclusions, and tag definitions.

Reset does not interrupt active user Turns or reverse side effects. Items that
such a Turn completes afterward remain excluded, and its stale admission epoch
cannot authorize a direct Memory mutation. Stray tagged content survives Reset
with its complete subtree.

## Crash Recovery

`<userData>/agent/memories.sqlite` stores modes, admissions, exclusions,
source versions, origin claims, generated fingerprints, lineage,
citation usage, leases/jobs, publication journals, reset epochs, visibility
generations, and rollback invalidations. Published prose exists only in Nodes.

After Thread rollouts and rollback markers are replayed, but before initial idle
extensions may admit a Goal or feature Turn, startup ensures the protected tags,
reconciles history rollback hooks, removes orphan admissions, and reconciles
every prepared journal. The Memory worker starts only after ThreadService has
finished initialization.
A matching document receipt finalizes SQLite without rerunning the model. A
non-Reset preparation without a receipt is discarded and retried from a fresh
snapshot. A Reset without a receipt idempotently reapplies deletion before
finalization. Publication generations are atomically reserved and may have gaps
but never duplicates.

DocumentService serializes renderer, agent, and Memory mutations through one
coordinator. Memory holds its additional write gate from final validation
through SQLite finalization. Projection-change delivery carries the originating
operation ID; `memory:*` publications are not mistaken for user edits between
the document commit and control-store finalization.

## User Surface

Settings exposes the global privacy switch, live worker freshness/error state,
Open Memory, and confirmed Reset. Open Memory reuses the canonical saved tag
search for `#d-memory`, so selecting a result opens the real Daily Notes context.
The Thread Details dialog exposes the per-Thread switch only for persistent root
user Threads.

Memory citations render beneath the response as Node links plus supporting
Thread links. No Memory card view, artifact path, internal Thread, SQLite row,
job, fingerprint, or publication state is user-facing.
