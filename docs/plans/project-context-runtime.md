# Project Context Runtime

**Shape:** Two independently complete features: bounded execution-context
discovery/publication, and the optional Project catalog with its entire
membership, confirmation, deletion, and Automation lifecycle. Each is one PR
under the [Agent Capability-First Development Workbench](project-development-workbench.md).

## Goal

Give every executable Tool Task and Turn a replayable, provenance-bearing view
of the directory and project facts that were actually used, without making a
Project or Thread directory a permission boundary.

## Non-goals

- A universal detector that chooses commands or binds Projects automatically.
- Project facts in the stable system prompt.
- A model-facing refresh or workspace tool.
- A second execution, Git, or context ledger.
- Blocking ordinary Full Access work because discovery is incomplete.

## Design

### Ownership

The Host owns collection and admission. The existing context evidence store
owns immutable payloads and generations. `ContextProjector` owns provider
projection. `ProjectCatalogStore` owns only display identity, saved root hints,
and Chat grouping. It does not own runtime root identity,
Tool Tasks, Turns, Git facts, checks, or permissions.

### Execution address and snapshot

For each admitted Tool Task, resolve:

```text
ExecutionAddress
  requestedCwd + resolvedCwd + canonical targets/scope anchors
  root/worktree identity per admitted scope

ContextSnapshot
  instruction/profile sources + Git observations + checks
  target-to-source applicability + scope completeness
  content hashes + generation + capture time + degradation reasons
```

The address and snapshot are immutable for that task. A later cwd requires a
new task address; refreshed observations create new snapshot generations, never
edits to an admitted task's reference. A saved Project root
is only a candidate used to prefill or inspect a task; it is never runtime
truth. Non-Git directories are valid and can have degraded or empty profiles.

### Collection

Collection uses an ordered set of canonical scope anchors chosen by the
capability, not one universal cwd:

| Capability | Instruction/profile scope anchor |
| --- | --- |
| Bash or native launcher | Admitted `resolvedCwd`; internal `cd`, absolute command operands, and vendor tool calls do not silently replace this scope. |
| File read/edit/write | Parent directory of each canonical file target, even when its absolute path is outside cwd. A new file records the nearest existing canonical ancestor and intended suffix. |
| Directory read or recursive search | Canonical directory argument; glob/grep uses the non-pattern search root. Per-file observations retain deeper applicable scopes when discovered. |
| Delete or rename | Directory entry actually mutated: parent of each source/destination. Deleting a symlink scopes the link entry, not the untouched referent; a content edit following a symlink scopes the referent. |

For each anchor, walk its canonical ancestors from outermost to innermost and
record applicable instructions/profiles in that order. Nested rules apply only
to their descendants; sibling scopes do not override each other. A recursive
search does not assert it loaded every descendant's instructions. A later edit
admits the exact target scope again. Snapshot payloads map each canonical target
to its applicable sources, source hashes, and scope completeness; shared source
bytes may be deduplicated, but their applicability cannot be flattened away.
Git observations use the same target roots. Detection produces candidates;
required checks become active only through explicit user choice or a trusted
project source.

For `file_edit(/repo-b/src/file)` from cwd A, the snapshot records B and its
nested `src` scope, not A's instructions. Cwd remains path-resolution metadata.
Cache/reuse identity includes capability scope semantics and the complete
canonical anchor set; snapshots for different targets in one cwd cannot alias.
Bounded or failed collection reports unknown scopes explicitly, including in
S0. An unresolved target needed for admission fails before mutation. Merely
selecting a Project does not substitute its root for a file's instruction scope.

A failed inspection records a degradation reason and returns the task result.
It does not fabricate a complete context and does not block ordinary
Full Access execution. Address validation, capability admission, worktree
claims, and requested isolation are prerequisites and cannot be deferred as
discovery. Unknown Git/profile observations are distinct from an unavailable
identity needed to enforce a claim or isolation policy.

### Snapshot admission and discovery lifecycle

For an address without a validated reusable snapshot, the Host performs this
ordering using the existing context evidence store and Tool Task admission:

1. Resolve and validate the address and policy.
2. Persist snapshot S0 with `generation: 0`, `collectionState: pending`,
   `degradationReasons: [discovery_pending]`, empty instruction/profile/check
   observations, and explicit unknown Git observations. Empty observations mean
   unknown, not "no instructions" or "all checks passed". Capture the address
   reference, source scope, and time even when no discovery facts exist.
3. Durably admit the task with address, policy, and `contextSnapshotRef: S0`.
   Only then may execution start. Failure to persist these execution facts
   returns structured non-success before side effects.
4. Bounded asynchronous discovery publishes S1 with `generation: 1`,
   `predecessorRef: S0`, `collectionState: complete`, capture times, source
   hashes, and complete or degraded observations. Generation numbers belong to
   the series rooted at S0, not to a Thread or Project. The original task and
   its terminal receipt keep S0.

The collector commits a typed observation with the initiating Turn/task
identity and S1's reference through existing task evidence/delivery ownership.
Its provider-facing context evidence is appended at the consuming boundary,
not inserted into the initiating Turn's history after that position was sent.
This adds no model tool or second task ledger. Persist payload bytes and their
retention dependency before publishing the referencing event. One successor
publication per predecessor is committed
idempotently; duplicate completion callbacks cannot overwrite a snapshot or
publish competing successors. A later refresh creates a further generation.

S1 describes facts captured after admission, possibly after the task modified
the directory. It cannot attest to what the original task or model knew before
execution. Later tasks may use S1 only after address/freshness validation and
record their own admission references. If S1 is not ready, those tasks may
reuse validated S0 as explicitly pending evidence. Reusing an in-flight
collection never waits for it or changes an already admitted task.

Failure publishes a successor with `collectionState: failed`, concrete failure
reasons, and any successfully captured sources. S0 remains durable even if the
failure event cannot be stored. Restart reconciles the task before resuming
bounded discovery; it restores committed observations exactly, or retries
collection when no successor was committed. It never repeats the business
operation to fill context. Unreferenced payloads follow ordinary evidence-store
cleanup. Replay is read-only and never performs fresh discovery.

### Turn admission

Admission is required for every executable root, fork, child, delegated,
scheduled, and resumed Turn. A Turn records the exact context reference for
each Tool Task; a Turn can therefore use multiple directories. A child may
reuse a parent reference only after Host validation that its address remains
available. Otherwise Host captures a fresh generation or returns structured
non-success before execution.

Compaction and replay retain the exact references used by the original Turn.
They never substitute a later snapshot. Context facts do not change the stable
prompt fingerprint.

### Provider projection

Implement the common
[Execution Context Publication](../spec/agent-model-runtime.md#execution-context-publication)
contract through `CanonicalContextProjector` and the existing evidence store:

```text
immutable task/observation evidence
  -> source- and scope-aware effective state
  -> frozen baseline or semantic delta at a consuming boundary
  -> appended system-reminder
```

Task references and snapshot generations remain exact audit data. Provider
text identifies readable sources, applicable paths, meaningful changes, and
degradation; it does not enumerate task slots or expose internal refs as model
syntax. A Task B admission using Task A's unchanged S1 retains B's own receipt
without repeating S1's instruction body. Host admission and model visibility
are distinct, including when a reused snapshot was not yet published to the
request that selected B's call.

Use source identity, fact kind, authority/purpose, and applicability scope for
semantic comparison. A/B/A directory work must preserve both sets of applicable
rules rather than globally switching one active directory. An unchanged body
with a new scope needs the new applicability statement; identical bytes from
different authorities are not interchangeable. Pending, failed, unavailable,
and explicitly empty discoveries are different states. A newer snapshot ref
alone is not a reason to republish the same semantic state.

Discovery contributes a bounded observed baseline or delta, never an automatic
Skill invocation. Skill candidates flow through the existing catalog owner and
its `planSkillCatalogEvidence` journal; bodies enter through `skillInvocation`.
Collection must not create another catalog or inject those bodies twice.
Project check profiles contribute command/input-scope declarations. They never
select root Configuration Profiles, tools, a model, or conversation identity.

For Task A admitted with S0, later S1 is announced as observed after admission;
A's receipt remains S0. Persist the canonical contribution and bundle boundary
before provider preparation. A result arriving after the boundary selection
waits for the next one. When A's Turn has ended, pending observation delivery
uses the next eligible Turn's tail while preserving A as source provenance.
It neither backfills old messages nor starts a Turn solely to publish discovery.
Reset/rollback/fork/deletion fences and duplicate delivery follow the shared
contract. A late obsolete observation cannot override a known newer state.

Compaction extends Unit A's checkpoint with scoped instruction/profile state
and the baseline actually restored to model input, using exact payload
dependencies rather than fresh discovery. Preserve scope, invalidations,
degradation, and distinctions between historical observations and current
validation. Optional omitted content must be eligible for later announcement;
a model that no longer has the body cannot receive only its private reference.
In-memory cache eviction changes neither rule validity nor historical input.
Full model-input removal uses canonical compaction/reset, not slot trimming.

### Implementation references

- `planSkillCatalogEvidence` in `SkillContextReducer` supplies deterministic
  baseline/delta and unchanged-state suppression; reuse its pattern while
  retaining this feature's multi-source applicability semantics.
- `CanonicalContextProjector.projectAdditionalThreadState` supplies explicit
  semantic invalidation without rewriting old messages. Extend projection
  publication to freeze bundles across provider boundaries, not just Turns.
- `planContextCompaction` and `buildCompactionRestoredState` own the existing
  checkpoint and dependency graph. Extend them rather than adding a context
  ledger or relying on the inspection-only diagnostics payload.
- `TurnDiagnosticsCollector` supplies prepared-prefix and post-adapter request
  evidence. Cache topology remains in `ProviderCache`; discovery does not own it.

### Project catalog and deletion

Creating or selecting a Project stores a user relationship and optional root
hint. It does not change the current or future Tool Task address by itself. An
Agent proposal requires a Host confirmation action.

Deleting a Project first fences new Project-based admission, then atomically
removes catalog metadata and detaches membership from the complete canonical
Thread lineage, including forks, child, delegated, and hidden Threads. The
lineage relation, not membership rows, enumerates descendants. It does not
cancel active Tool Tasks or invalidate their self-contained receipts. Active
and paused Automations whose hints reference the Project block deletion, as do
pending claims that still depend on it, including claims of an exhausted
schedule. Completed history retains self-contained dispatch references and
cannot resume a historical run. Reactivating a completed definition requires
fresh hint validation. The scheduler and deletion fence share the lifecycle
ordering in [Agent Automations](../spec/agent-automations.md#project-deletion-and-reactivation).
Internal isolated resources have a Tool
Task/Goal cleanup owner and a deleted-parent fence; they cannot retain a
dangling Project dependency.

The catalog persists deletion intent before releasing the lifecycle lock; its
durable fence rejects new dependencies until the membership/catalog transaction
commits or deletion is refused and the intent is cleared. Startup reconciles
that intent with Automation claims before scheduling. An in-memory mutex alone
cannot provide this guarantee across restart.

### Catalog implementation boundary

The catalog feature is one complete PR, built in the following internal order:

1. Define closed Project request/response codecs and a `ProjectCatalogStore`
   sharing the Thread metadata SQLite connection. Store display name, optional
   canonical root hint, revision, membership, and durable deletion intent here.
   Project metadata and membership removal commit in one transaction. A saved
   root remains a hint; it is never a Thread cwd or automatic tool default.
2. Inherit membership through canonical parent/fork edges during Thread
   creation. Explicit changes apply to the selected root and its complete
   descendant lineage, including hidden execution Threads. Traverse lineage
   rather than using membership rows as an approximation. Host confirmation
   binds the exact Project revision, canonical path, and affected root; stale
   confirmation cannot authorize a different binding. Plain new Chats remain
   ungrouped, while New chat in project explicitly chooses membership.
3. Share the Automation scheduler lifecycle lock for catalog deletion and
   Project-backed hint admission. Capture Project display/root/revision values
   into each claim's immutable snapshot. Definition edits, resume, new claims,
   and reactivation validate live catalog state under that lock. Existing
   claims and accepted Turns use their recorded snapshots, including when the
   saved root changes. Reconcile accepted pending claims before deciding which
   remaining references block deletion. Startup resolves persisted deletion
   intents before waking the scheduler; completed history needs no catalog.
4. Route renderer operations and root-Agent proposals through the same Host
   service. Add compact Project grouping and actions to the existing Thread
   chooser, an optional membership control near the composer, and Project
   choices alongside directory hints in the Automation editor. Reuse native
   confirmation and existing dialog/input/menu primitives. Root selection
   never changes permissions, provider configuration, or task addresses.

Verification covers stale revisions and cancelled confirmations; membership
inheritance through forks and hidden children; deletion with missing membership
rows and concurrent Thread creation; active/paused/completed Automation hints,
accepted and unaccepted claims, root edits, and reactivation; crash recovery
on both sides of deletion commit; and unchanged task receipts and user files.
Renderer checks cover ungrouped Chat, new Chat in Project, reassignment,
Project editing/deletion, and unavailable Automation references in both themes.

### Protocol clean cut

The pre-release cut removes persisted `Thread.cwd`, `defaultWorkspaceRef`, and
task-target fields from the planned development protocol. Update codecs,
metadata, fork/child creation, Automation snapshots and dispatch, delegation,
diagnostics, preload, renderer DTOs, and restart readers in the same unit.
No compatibility reader or silent fallback remains. A fresh userData tree is
the only supported format.

The cut includes [local tools](../spec/agent-tool-design.md#local-files-and-commands),
[delegation context](../spec/agent-delegation.md#task-execution-context), and
[Automation](../spec/agent-automations.md), alongside Agent Core, permissions,
model runtime, and the active delegation plan. Unit A delivers the durable S0
admission, receipt, and scoped publication contract as a complete execution
refactor; Unit B adds bounded discovery and its successor events to that
working mechanism. It must not defer mandatory snapshot persistence to Unit B.

## Requirements

- **FR-1:** Every Tool Task records immutable address and context snapshot refs
  before execution, including an explicitly pending S0 on first discovery.
- **FR-2:** Every executable Turn records each context ref used by its tasks.
- **FR-3:** Context generations preserve prior evidence and publish scoped
  semantic additions, replacements, and invalidations through appended reminders.
- **FR-4:** Project metadata is optional, non-authoritative, and never a
  permission boundary.
- **FR-5:** Child, fork, delegated, scheduled, and resumed Turns validate
  inherited context before execution.
- **FR-6:** Project deletion leaves no dangling Thread, Automation, or isolated
  resource reference.
- **FR-7:** The clean cut removes old cwd/workspace readers and writers.
- **FR-8:** Discovery publishes immutable successors as later observations;
  it never revises the initiating task's admission context or receipt.
- **FR-9:** File contexts follow canonical target scopes, with per-target
  applicability and nested rules; Bash contexts follow the admitted cwd.
- **FR-10:** Publication, scoped deduplication, late delivery, and compaction
  restore follow the shared model-runtime contract without rewriting old input.

## Acceptance criteria

- **AC-1:** A projectless Chat executes two directories and records separate
  task addresses in one Turn.
- **AC-2:** A Project-hinted Chat executes another directory without rebinding
  or switching Project.
- **AC-3:** Invalid cwd fails before execution-start; discovery failure is
  degraded evidence, not fabricated success.
- **AC-4:** Canonical receipts and Trajectory retain exact context refs and
  generations for every Tool Task, separately from later observations. Provider
  text communicates applicable facts; prepared-input provenance identifies what
  was actually published without requiring private refs in model-visible prose.
- **AC-5:** Child/fork/delegated/scheduled/resumed execution with stale context
  refreshes or returns structured non-success.
- **AC-6:** Project deletion detaches the full Thread lineage, blocks active or
  paused Automation references and dependent pending claims, and leaves
  completed history readable but non-resumable. Reactivation revalidates hints.
- **AC-7:** No codec, Automation, fork, child, diagnostics, or restart path
  reads a retired cwd/default-workspace/task-target field.
- **AC-8:** With discovery held pending, Task A starts only after S0 and its
  admission are durable. Releasing discovery publishes S1; A still uses S0,
  the next provider boundary labels S1 as later evidence, and Task B may use S1.
- **AC-9:** Discovery failure or restart never mutates S0, substitutes a
  snapshot during replay, or reruns Task A to reconstruct missing facts.
- **AC-10:** Editing an absolute path in B while cwd is A collects B's enclosing
  and nested rules only. New files, symlink content edits, symlink deletion,
  sibling targets, and recursive-search-then-edit retain their distinct scopes.
- **AC-11:** Repeated unchanged tasks emit no repeated instruction bodies;
  A/B/A work, source/authority differences, and explicit invalidation preserve
  applicability and already-published prefixes.
- **AC-12:** Late discovery across Turn completion or retry appends once at the
  consuming boundary. Reset, rollback, fork, and deletion cannot deliver stale
  pending observations into a different effective history.
- **AC-13:** Repeated compaction restores scoped state and its announced baseline
  without reviving invalid rules or treating old observations as freshly checked.

## Tests and evidence

Add codec and invalid-state tests, multi-cwd Turn replay, ancestor scope tests,
Project confirmation/deletion tests, Automation/fork/child/resume tests, and
fresh-userData clean-cut tests. Capture a trajectory fixture proving each Tool
Task's context reference. The implementation must include these deterministic
fixtures:

| Fixture | Required evidence |
| --- | --- |
| First task with delayed discovery | S0 exists before execution-start; admission and terminal receipt both name S0; S1 is a separate observation. |
| Discovery fails or is cancelled | S0 remains pending historical evidence; committed failure successor is degraded; command success does not imply discovery success. |
| Two directories, out-of-order completion | Independent scope/source state; late X discovery cannot replace Y, create an active cwd, or backfill published input. |
| Restart before/after successor publication | Uncommitted payload cannot enter projection; committed S1 is restored once; business mutation is never replayed. |
| Duplicate collector callback | At most one successor event for the same predecessor. |
| Replay after files change or Project deletion | Original S0/S1 references, kinds, publication order, and frozen boundary contributions remain exact; missing bytes show unavailable. |
| Local tools and delegated isolation | Relative/absolute targets use task addresses; a mismatched isolated resource fails admission without ancestor fallback. |
| File targets outside cwd and in nested scopes | Canonical target-to-source mappings survive replay; A/B and sibling contexts cannot share a cache entry solely because cwd matches. |
| Repeated unchanged tasks and A/B/A visits | Receipts remain complete while instruction bodies are not repeated; new applicability remains visible. |
| Retry without intervening assistant output | New evidence forms a later bundle; the previous request's reminder bytes and content boundaries stay unchanged. |
| Origin Turn ends before discovery | The next eligible consuming Turn receives the observation once; completed history is not modified. |
| Reset, rollback, fork, or deletion before delivery | Old pending observations do not cross the boundary; no discovery callback starts business work. |
| Changed rule, memory eviction, and repeated compaction | Invalidation remains effective; eviction does not clear rules; restored/omitted bodies produce the correct next delta. |
| Skill discovered in a visited directory | Catalog eligibility and invocation use existing Skill owners; no duplicated body or implicit configuration change. |

Unit A adds codec fixtures rejecting retired Thread/start-request fields and a
production-source guard covering `ThreadMetadataStore`, `ThreadCatalogOps`,
`DelegationCoordinator`, `InternalDelegationSessionRuntime`,
`ExternalAgentCliLauncher`, `agentLocalTools`, Automation
dispatch, configuration/identity lookup, and restart readers. Combine type
checks that remove the old fields with a source guard against old metadata
accessors and ancestor worktree fallback; a text-only search for `thread.cwd`
is insufficient because aliases can hide readers. Existing receipt cwd fields
remain valid task facts. This guard belongs to the implementation cut, when
the old runtime readers are removed, not to this design-only PR.
The cut must also retire the task-discovery route into
`composeStablePrompt`/`startupContextBlocks`; repository observations belong to
canonical evidence, not the former `repository-startup` L1 block. Explicit
conversation configuration remains the stable prompt's own input.

## Open questions

- The relative-cwd Host default is implementation detail only and must not be
  persisted as Thread state.
- A future native context refresh command needs evidence that automatic
  admission and next-boundary projection are insufficient.
