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
Startup re-ensures all five definitions through the ordinary Runtime ChangeSet
boundary. A definition with the fixed ID but the wrong lock state or parent is
repaired to a locked direct Schema child; a conflicting name or identity fails
closed instead of silently creating a second definition.

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
Thread, Agent child Threads, inherited fork Items, internal Memory Threads,
ephemeral Threads, and external-context-polluted Threads are excluded by their
canonical provenance. One ultimate `originItemId` can belong to only one
extraction source.

Fresh Agent context excludes the Memory stable-prompt block and routing context.
Memory is root-only by Thread provenance, not inferred from the child's shell or
Skill access. The public Outline Projection is actor-neutral and is never
filtered by Memory eligibility.

[`agent-automations.md`](agent-automations.md) owns the immutable Automation
trigger and reciprocal run binding that this exclusion consumes. Memory never
infers scheduled origin from prompt text, Thread destination, or display labels.

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

Completed tool evidence keeps enough bounded attribution to interpret an outcome:
command evidence includes the canonical tool label, command, host `cwd`, output, and
exit code; MCP and dynamic evidence include the canonical tool label, presentation
arguments, and result. These fields support Memory extraction only. They never
reconstruct provider tool-call history or override the Item's frozen `modelCall`
envelope.

An internal hidden ephemeral `memory_consolidation` Thread runs the configured
model with model tools, Skills, plugins, MCP servers, network, Agent orchestration,
and Memory disabled. Hidden internal Threads do not publish renderer notifications
or invoke ordinary extension admission, context, Item, lifecycle, or tool hooks;
the model receives the exact Memory system prompt without Skill preparation or
the general interactive-agent prompt. Strict bounded JSON produces zero or more
source-date episode groups. Every headline, episode, belief, question, and
guidance statement carries a non-empty, exact set of supplied `originItemId`
values from that source date; lineage is recorded per statement rather than per
day. Known credential formats and high-confidence secret assignments are redacted before
publication; ambiguous prose passes unchanged rather than blocking Memory publication.
A no-signal result withdraws that source's old generated lineage and schedules
global cleanup.

Under the Memory write gate, Stage 1 rechecks modes, exclusions, rollback state,
source version, and pollution, then rebuilds every target from the current graph.
It prepares canonical `node:<uuid>` IDs, exact lineage, feature generation,
reset epoch, ChangeSet digest, target fingerprints and authority states, and a
unique publication generation in `memories.sqlite` without releasing the gate.
It then applies one ordinary Runtime ChangeSet with that publication ID as its
idempotency key and the digest as source evidence. A generated Node whose
fingerprint changed during model work is first promoted to user-authoritative
and is never overwritten. Runtime resolves only after the Operation and
workspace state are durable; SQLite finalizes source state only after that
settlement.

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
producing the Runtime ChangeSet.

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
canonical Changes, output fingerprints, deletion-subtree fingerprints, new
generated records, complete lineage, and rollback IDs without releasing the
gate. Runtime idempotency settlement is the matching receipt; finalization uses
only journaled state, never mutable live Nodes. A rollback is reconciled only
after every remaining
canonical generated Node has current evidence or is deleted.

## Retrieval And Outline CLI

An eligible Turn receives compact routing instructions, not Memory prose. The
instructions tell the model to use `outline find` only when prior preferences,
decisions, commitments, unresolved questions, or recurring workflow facts could
materially improve the answer, then inspect only the one or two most relevant
results with `outline get`. Self-contained requests such as current time,
simple formatting, or questions fully answered by the current Turn skip Memory
lookup. The public CLI is the only retrieval surface.

Runtime does not filter document results by Thread, Agent, or Memory mode. A
disabled or ineligible Turn receives no implicit Memory routing context, but an
explicit user-supplied Node reference remains ordinary input and any deliberate
public CLI read has actor-neutral semantics. Prepared or committed history
rollback suppression remains pipeline control state: suppressed generated Nodes
are not selected as implicit Memory support and are eventually reconciled, but
the public Projection contract itself is unchanged.

There are no model-callable Memory-specific tools. An eligible foreground root
Turn may use the public Outline workflow to remember, update, or forget only
when the user explicitly requests it. Renderer-authored edits remain ordinary
user mutations. Runtime capability is actor-neutral; Memory eligibility does
not create a second authorization layer. Host shell policy, built-in Agent
attestation, protected-definition invariants, and ordinary Diff preconditions
apply exactly as they do to every other Outline mutation.

The Memory extension observes committed Runtime projection deliveries. Each
delivery carries the matching Operation when available, so trusted causation
and source evidence identify the mutation without inspecting a private Core
command or undo stack. `MemoryMutationIndex` applies sparse changed/removed IDs
and maintains canonical ownership, reserved-tag membership, fingerprint inputs,
and ancestor reverse dependencies. A missing generated Node drops its control
row; a changed fingerprint promotes it to user-authoritative. A date rename,
container move, or ancestor entering Trash therefore reconciles affected
generated descendants without rebuilding the full graph.

Memory-owned publications also update the index, but their Operation source
marks them as already settled so they skip user-edit reconciliation and graph
wake scheduling. Other committed mutations coalesce pipeline wakes for at most
500 ms. Observation is non-authoritative: a projection inspection failure is
recorded and recovered by a later full Projection, never used to change a
committed Operation result.

When a final answer relies on a Memory Node, the routing context asks the model
to cite it inline as `[[node://UUID]]`, removing the internal `node:` prefix.
The ordinary Markdown renderer owns
that Node-link affordance; Memory adds no commentary Item, sources section, or
separate disclosure. Shell calls remain visible in process disclosure and
Trajectory. Deleting a source Thread does not delete already published Memory
Nodes or their retained evidence; those Nodes remain user-editable until
ordinary editing, consolidation, or Reset changes them.

Citation ranking records only a bounded set of canonical Memory Nodes returned
by a successful foreground `outline get` in the same eligible Turn. Find
results, ordinary Nodes, failed or background shell calls, malformed output, and
uncited reads do not count. At terminal completion, the extension parses only
rendered final-answer Markdown and records usage when it contains the exact Node
reference; literal markers inside code or existing Markdown links are excluded.

## Rollback And Reset

Completed history remains auditable. Editing the latest user input appends a
Core rollback marker and starts a replacement Turn in the same Thread; it does
not undo file, document, process, MCP, Goal, or external side effects.

Before Core appends that marker, Memory durably prepares an invalidation with
the exact rollback ID, omitted Turn IDs, before/after projection versions, and
the affected generated Node set. The visibility generation advances
immediately, so replacement Turns cannot read stale generated Memory. Commit
withdraws omitted origin and inline-citation usage and enqueues Phase 1 and
Phase 2.
Core retries a failed idempotent commit hook in-process; startup matches any
stranded preparation against the complete durable marker before admitting new
Turns.

Reset means "forget current Memory and learn only from future Turns." Under the
host admission barrier and Memory write gate it advances the reset epoch and
retains every active Turn ID as an indivisible exclusion. Phase 1 accepts only
Turns whose immutable admission snapshot carries the current epoch, so rollback
or replacement cannot move an Item across a positional boundary. One destructive
Runtime ChangeSet purges the snapshotted canonical `#d-memory` containers and
every descendant inside them, including untagged ordinary notes. Its idempotency
key is the Reset receipt. Notes outside those containers and stray tagged
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
Turn-admission preparation is single-flight across Thread initialization and
worker startup. Concurrent callers share one settlement; failure clears the
preparation promise so an explicit Host startup retry can recover cleanly.
A matching Runtime Operation found by idempotency key and source fingerprint
finalizes SQLite without rerunning the model. A non-Reset preparation without a
settled Operation is discarded and retried from a fresh snapshot. A Reset
without settlement idempotently reapplies the same destructive ChangeSet before
finalization. Publication generations are atomically reserved and may have gaps
but never duplicates.

The Runtime serializes renderer, Agent, and Memory mutations. Memory holds its
additional write gate from final validation through SQLite finalization.
Document-dependent planning additionally runs inside the main-process document
mutation queue: it reads Projection and revision only after earlier admitted
document work, then submits that plan before the next queued main-process
mutation. Runtime admission remains the cross-process authority for concurrent
CLI or other-client writes.
Projection delivery carries the originating Operation; Memory publications are
not mistaken for user edits between Runtime commit and control-store
finalization.

## User Surface

Settings exposes the global privacy switch, live worker freshness/error state,
Open Memory, and confirmed Reset. Open Memory reuses the canonical saved tag
search for `#d-memory`, so selecting a result opens the real Daily Notes context.
The Thread Details dialog exposes the per-Thread switch only for persistent root
user Threads.

Memory used by a response appears only as ordinary inline Node references near
the claims they support. Outline shell calls remain inspectable in the process
and Trajectory; there is no separate Memory disclosure, card view, artifact
path, internal Thread, SQLite row, job, fingerprint, or publication state in the
transcript.
