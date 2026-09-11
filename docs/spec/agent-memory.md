# Agent Memory

Memory is an Agent Core extension over the canonical Thread, Turn, Item, and
Node models. It is not an Automation, Thread type, card store, hidden document,
or second knowledge graph. The public source of truth is ordinary editable
Nodes on the Daily Notes timeline; private SQLite state only coordinates
eligibility, extraction, consolidation, provenance, ranking, rollback, and
crash recovery.

## Daily Timeline Model

The host owns five deterministic protected tag definitions. The `mem-` prefix
identifies their system ownership and leaves ordinary names such as `memory`,
`episode`, `belief`, `question`, and `guidance` available for user tags:

| Category | Tag | Definition ID |
| --- | --- | --- |
| Memory day | `#mem-day` | `tag:mem-day` |
| Episode | `#mem-episode` | `tag:mem-episode` |
| Belief | `#mem-belief` | `tag:mem-belief` |
| Question | `#mem-question` | `tag:mem-question` |
| Guidance | `#mem-guidance` | `tag:mem-guidance` |

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
    Memory                    #mem-day
      optional episode        #mem-episode
        stable fact            #mem-belief
      unresolved question      #mem-question
```

Generation reuses the existing canonical container for a source date and creates
at most one container for that date, and it is created only when at least one
useful record exists. It initially displays `Memory`. After that local source day
has ended and its eligible evidence has finished processing, consolidation names
it with a short, vivid, memorable title grounded in the day's records, in their
language and within 160 characters. A concrete image or light wordplay may help;
it must not invent events or force humor. The final title is navigation, not an
extra episode or independent evidence. New containers use the normal initially
collapsed Outline state; later publication does not change the user's fold state,
editing selection, focus, or scroll anchor. An episode is optional;
category Nodes may be direct children of the container or descendants of an episode.
All remain ordinary RichText Nodes with ordinary tags, references, navigation,
editing, move, and Trash behavior. The source date is frozen from
the origin Turn's local calendar date when evidence is first claimed; later
timezone changes do not move it.

A reserved-tag placement outside a source-date Daily Node and canonical
`#mem-day` container is ordinary non-Memory content. Memory status reports the
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
and ephemeral Threads are excluded by their canonical provenance. Web/MCP
activity does not exclude an otherwise eligible Thread or revoke prior support. One ultimate `originItemId` can belong to only one
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

Phase 1 fingerprints the complete ordered eligible stream, then reads the oldest
unprocessed complete Items in a batch of at most 500 Items, 120,000 evidence-text
characters, and fourteen source dates. The character count uses the exact text
sent to the model: all original message-part text, including leading/trailing
whitespace and extracted attachment text, or the content string for other Items.
The trimmed comparison string never stands in for the transmitted parts. Accepted origin coverage is private control state,
transactionally committed with source/lineage finalization. Failed batches advance
nothing. Oversized individual Items remain pending with an explicit error rather
than admitting a misleading prefix. A distinct durable continuation job handles
the remaining batch, including after receipt recovery; no in-memory cursor owns
progress. The existing six-hour idle policy is unchanged.

Evidence includes local user messages, final Agent messages and completed tool
outcomes. Reasoning, injected instructions, copied fork prefixes, Automation Turns
and disabled/reset-excluded Turns remain excluded. Mixed-source conversations
remain eligible, including reader decisions and corrections made before or after
web/MCP activity. The Host labels each evidence Item as reader, host, assistant,
tool, web, or mcp. User-shaped messages also retain the boundaries between text,
attachments and Node/Thread references; Host/feature-authored messages are not
labelled as the reader. Source kind and part boundaries participate in the
canonical evidence hash. Web search evidence retains the query, returned URLs,
titles and snippets; MCP evidence retains the actual server/tool, arguments,
result and error. Their content is source data, never worker instructions.

The model judges future value, meaning and attribution. Researched conclusions
or useful external facts may be retained with their source, applicability,
version/date and uncertainty; bulk search-result copies have no automatic value.
An outside assertion is not silently promoted to independently verified truth.
Tool arguments describe the request, while results describe observed outcomes.
The former whole-Thread exclusion flag and its support-deletion path are retired.

The model compares new evidence with at most eighty current canonical records
and 20,000 characters of comparison text. The comparison is not new evidence.
Candidates must name a concrete future use and novel signal, a necessary
correction, or additional independent support for retained content, with narrow
applicability and sufficient context. One-off requests,
routine completion, generic advice, silence, and repeated Agent prose do not
establish useful durable knowledge. Existing project documents, configuration,
and Skills retain their own facts. The Node-only unit still allows supported
stable preferences; direct USER.md routing belongs to the profile unit.

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
source-date record groups. Extraction creates new day containers as `Memory`
and preserves existing titles; it does not generate titles. Episodes are optional; every emitted episode, belief,
question, and guidance statement carries a non-empty, exact set of supplied `originItemId`
values from that source date; lineage is recorded per statement rather than per
day. Known credential formats and high-confidence secret assignments are redacted before
publication; ambiguous prose passes unchanged rather than blocking Memory publication.
Each statement declares whether its subject is the user or contextual knowledge
and includes bounded private future-use and novelty rationales. Subject is
semantic routing, never authorship or permission authority. The Host requires a
personal claim to cite reader-authored text, so web/MCP results, attachments,
references, Host notifications and assistant prose alone cannot establish a user
preference. The model must still distinguish the reader's own statement from a
quotation or a transient instruction; a source label is not semantic proof.
Origin kind and the presence of reader-authored text are immutable private claim
metadata. Each generated Node retains its subject in the control store and
publication journal. These fields survive restart and are supplied to the
consolidation model with its selected Nodes. The Host does not treat model
self-assessment as a quality guarantee. All cited
origins and source dates are validated before deduplication/redaction. Repeated
Agent prose alone cannot support a new statement. A no-signal or empty-date
result accepts its exact coverage without creating a day/container or withdrawing
any previously accepted support. Unknown source availability never acknowledges
an unread batch.

No new wording is required for new support: when the current evidence independently
confirms an existing statement, extraction emits its exact retained text and
category with the new supporting Item IDs and their source date. A no-output
result is reserved for no useful signal or repetition without independent
support. Recalled Memory, copied assistant prose, or a different Item ID alone
does not establish independent support.

Exact repeated canonical statements are reused, across Threads and source dates,
with independent support added only to untouched generated records. Identity
comparison preserves case and normalizes Unicode and whitespace. User edits and
previous independent lineage survive. New records keep their own source dates;
a reused historical episode never becomes a parent for newly dated facts.
Semantic corrections and duplicate reconciliation use the existing consolidation
owner rather than whole-Thread replacement. Ordinary manual deletion cannot
replay already accepted Items; Reset and rollback clear associated coverage with
the existing origin ownership boundaries.

Under the Memory write gate, Stage 1 rechecks modes, exclusions, rollback state,
source version and exact source attribution, then rebuilds every target from the
current graph.
It prepares canonical `node:<uuid>` IDs, exact lineage and coverage, private
candidate rationales, feature generation,
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

The internal model receives an isolated bounded graph snapshot, including each
Node's retained subject and current origin/source metadata, and returns an exact
change set. Every create/update declares its subject. Personal creates and
updates require current reader-text evidence at preparation and again at document
admission. Existing personal Nodes cannot be downgraded to contextual knowledge
to evade this rule. Day titles remain contextual navigation. The same rule
covers extraction-time reuse/promotion of existing records; subject changes are
part of the publication precondition. A generated personal Node with no current
reader support is unsupported even if external origins remain, and cannot supply
derived evidence to another proposal. Model judgment still owns whether the
meaning of a new statement is personal or contextual.

The model may keep or update generated episodes and categories,
delete a complete generated subtree, merge duplicate generated episodes by
updating one and deleting the other complete subtree, or create an episode or
category beneath a container or episode. For a generated day container, a title
update is admitted only when all of its canonical records are selected. The model
sees that exact same-day source list; it cannot cite another day, the container
itself, or a partial newest batch to rename it. Day titles retain the union of
current support from the complete source-day record set. The full subtree
fingerprint is checked after model work and again at document admission, so
concurrent child additions, removal or edits invalidate a stale title proposal.
A manually edited title is authoritative and cannot be overwritten.

Accepted extraction also journals a day-close job for the next local midnight
(or immediately for delayed extraction of a past day). This uses the existing
Phase 2 worker. At execution, the job waits until every eligible source Turn for
that day has completed and all its Items have accepted extraction coverage.
Quarantined or unreadable sources prevent a false completion claim. Disabled or
excluded evidence remains ineligible. A still-pending day is rescheduled without
reporting a learning error; resume/restart uses the durable job. A completed day
is selected as a whole within the existing 240-Node bound; an oversized day keeps
its pending job and placeholder instead of being named from a partial view.
Already named or manually titled containers need no additional naming call. Later
eligible additions can still be reconciled by ordinary consolidation, with the
same completeness and manual-edit gates. Every created
or updated Node names selected source Nodes with current terminal evidence. The
host allocates real IDs, replaces the affected Node's complete lineage, and
validates hierarchy, selection, authority, descendants, and evidence before
producing the Runtime ChangeSet.

Consolidation has three owners: `ConsolidationSnapshot` detaches the graph and
control evidence, `ConsolidationPlan` computes changes without live reads or
writes, and `Phase2` coordinates model work, admission and durable publication.
The worker reads one graph snapshot before the model, one under the Memory write
gate after the model, and one at document admission. Each boundary collects
source readiness once for all dates, using the same eligible-source collection
as extraction. Prepared/committed rollbacks prevent day naming without scanning
source history. Naming completion is evaluated from the resulting plan, including
multiple containers on one date; it does not require another live scan.

Unsupported generated Nodes and their descendants bypass unused-record aging.
Selection reserves bounded space for an unsupported ancestor together with the
descendants that can resolve it; many unsupported parents cannot crowd out all
retained children. Cleanup processes selected Nodes deepest first against the
planned final structure, including model creates and deletes. A generated
ancestor inherits current retained descendant evidence when possible. If an
ordinary or user-authoritative descendant makes deletion impossible, the
ancestor relinquishes generated ownership and becomes authoritative.

An unsupported personal episode cannot inherit external-only support. Its
selected, independently supported generated leaves move directly to the same
day container, deepest first, while unprocessed children keep the episode alive.
The episode is purged only after all retained descendants have left. This works
across many batches and nested subtrees, without requiring a complete subtree
inside one model input. Subjects, current lineage and new parent fingerprints
are journaled; moving content invents no user authorship and adds no model-facing
move operation. Reset subtree scope is unchanged.

Deletion fails closed if the resulting structure still retains any descendant.
User-authoritative Nodes cannot be updated or deleted by the model. Create and
move operations cannot target a deleted or non-canonical parent.

Selected inputs are rechecked after model work. The plan records every structural
and evidence dependency it reads, including complete deletion subtrees, inherited
lineage and destination parents. At document admission, it rechecks these detached
fingerprints, mode generation, reset epoch and the exact rollback records, as well
as title readiness and complete title subtrees. New independent support invalidates
a stale replacement instead of being overwritten. Runtime idempotency settlement
is the matching receipt; finalization uses only journaled state.

A partial cleanup that advances publishes a distinct continuation with an explicit
next-run time. No-progress batches defer for one minute without publishing an
empty marker or immediately repeating model work. If other model changes publish
without advancing cleanup, their journal preserves the deferred continuation
time. Recovery finalizes that exact schedule once. A rollback is reconciled only
after every remaining canonical generated Node has current evidence, has been
released to user authority, or is deleted. Private job payloads distinguish
consolidation from day naming explicitly; the pipeline consumes completed/deferred
outcomes instead of inferring work from reason strings or boolean sentinels.

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

There are no model-callable Memory-content tools. Management uses the separate
domain operations below; an eligible foreground root
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

Reset means "forget current Memory and learn only from future Turns." A native
review names the exact canonical container/descendant counts, including ordinary
notes. Host-private fingerprints bind the workspace, root, ancestry, source date,
ordered descendants and all persisted Node fields to the reviewed reset epoch.
No lock is held while waiting for the person. After confirmation, recheck caller
authority and the exact target inside the Memory gates and document planning
queue; a changed target requires fresh review and creates no deletion intent.
Under the host admission barrier and Memory write gate it advances the reset epoch and
retains every active Turn ID as an indivisible exclusion. Phase 1 accepts only
Turns whose immutable admission snapshot carries the current epoch, so rollback
or replacement cannot move an Item across a positional boundary. One destructive
Runtime ChangeSet purges the snapshotted canonical `#mem-day` containers and
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
without settlement can reapply only its still-matching reviewed target before
finalization. A changed target or definitive Runtime rejection marks the existing
journal `conflicted` and retires its Reset job without advancing the epoch or
discarding admitted exclusions. Conflicted and finalized Reset evidence survives
later Resets. An unavailable receipt lookup stays unresolved, not proof of
non-commit. Pending Reset recovery remains active when global Memory is disabled;
extraction and consolidation remain suspended. Publication generations may have gaps
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
search for `#mem-day`, so selecting a result opens the real Daily Notes context.
The Thread Details dialog exposes the per-Thread switch only for persistent root
user Threads.

Settings and Thread Details use the internal Memory-owned Host facade. These
operations are not model tools:

- Inspection returns bounded status, an exact Thread mode/revision, or
  settlement for one Reset operation identity. No prose, private paths, or Node
  inventory is exposed. Stray counts use the incremental mutation index.
- Management opens the ordinary saved Memory search, changes one Thread
  mode using its observed revision, or requests native-confirmed Reset. The
  window names its exact Thread Details target. Missing, hidden, ephemeral, child,
  or non-user targets are unavailable, never synthesized as enabled.
- Global enablement remains `agent.memory.enabled` in `config/settings.jsonc`.
  The UI uses the existing comment-preserving file writer; only the file watcher
  applies it to Memory. A saved file is not yet proof of application. There is
  no Settings/Configuration CLI, universal setter, or private-store edit route.

Mode revisions increase on actual changes and are rechecked under admission and
publication gates. Re-enabling never overrides provenance exclusions. Reset
results are `prepared`, `finalized`, `conflicted`, or `unknown`; only finalized
means complete. Saved-search creation and acknowledged main-window navigation
have separate outcomes, with no fallback to Daily Notes or success on a missing
acknowledgement. Native review cancellation, caller loss, or shutdown before
admission creates no Reset intent. Cancellation after admission does not erase
recovery obligations.

Memory owns loading, errors, busy state, and completion feedback locally. An
initial read and narrow owner invalidations replace five-second polling; stale
responses cannot replace newer state or another Thread's view, and closing a
surface releases its subscription. Notifications are non-authoritative and
cannot turn a committed operation into failure. Main and Settings windows are
the only renderer callers; child/provider/review windows and subframes cannot
reuse their Memory IPC authority.

Memory used by a response appears only as ordinary inline Node references near
the claims they support. Outline shell calls remain inspectable in the process
and Trajectory; there is no separate Memory disclosure, card view, artifact
path, internal Thread, SQLite row, job, fingerprint, or publication state in the
transcript.

## Node Quality Validation

Deterministic tests cover exact evidence attribution, incremental coverage,
no-output batches, source dates, duplicate reuse, author edits, invalidation and
receipt recovery. Electron smoke uses the real publication builder and Outline
transport to verify default folds, retained user folds, focus, selection and
scroll in light and dark themes. These checks establish ownership and publication
behavior, not a measured improvement in model judgment, token use or cost. The
[frozen bilingual retention corpus](../../tests/fixtures/memoryRetentionCorpus.json) is a comparison fixture for later equal-model
history-only/current/routed evaluation; no quality or cost gain is claimed here.
