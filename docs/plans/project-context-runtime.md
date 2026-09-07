# Project Context Runtime

**Shape:** One complete feature. It implements bounded context collection,
per-task execution addresses, provider projection, and optional Project
catalog metadata under the [Agent Capability-First Development Workbench](project-development-workbench.md).

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
context presets, and Chat grouping. It does not own runtime root identity,
Tool Tasks, Turns, Git facts, checks, or permissions.

### Execution address and snapshot

For each admitted Tool Task, resolve:

```text
ExecutionAddress
  requestedCwd + resolvedCwd + canonical root/worktree identity

ContextSnapshot
  instruction/profile sources + Git observations + checks
  content hashes + generation + capture time + degradation reasons
```

The address and snapshot are immutable for that task. A later cwd requires a
new task address; refreshed observations create new snapshot generations, never
edits to an admitted task's reference. A saved Project root
is only a candidate used to prefill or inspect a task; it is never runtime
truth. Non-Git directories are valid and can have degraded or empty profiles.

### Collection

Collection walks the lexical ancestors of the resolved cwd, discovers bounded
instruction files and profile candidates, and captures Git/worktree facts when
available. Every source records canonical path, scope, content hash,
provenance, and generation. Detection produces candidates; required checks
become active only through explicit user choice or a trusted project source.

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

The collector appends a typed observation event with the initiating Turn/task
identity and S1's reference. This is canonical context evidence, not a new
model tool or a second task ledger. Persist payload bytes before publishing
the referencing event. One successor publication per predecessor is committed
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

The existing provider wire format remains `system-reminder`:

```text
context evidence -> ContextProjector -> add/replace/clear reminder -> provider
```

The reminder is a projection, not authority or history. Each contribution is
keyed by `contextSlotKey = { turnId, toolTaskId, contextSnapshotRef }` and
contains source, generation, resolved cwd, degradation, and contribution kind
`admission` or `observation`. `upsert` replaces
only that slot; `clear` removes only that slot; a later task cannot clear an
earlier task's evidence. The provider projection includes an ordered bounded
list of retained slots and a separate `currentToolTaskId` marker. The marker
does not collapse or authorize any slot. Repository instructions and Skills are
source-labelled evidence and cannot change Host capability or execution
address.

For Task A admitted with S0, its admission slot is `{ turnId, A, S0 }`.
Discovery adds a separate `{ turnId, A, S1 }` observation slot at the next
provider boundary after the observation event commits. The reminder explicitly
labels S1 as observed after A's admission, not as context used by A. Task B
admitted with S1 gets `{ turnId, B, S1 }`; A's receipt still references S0.
Discovery completion does not move `currentToolTaskId`, which follows task
admission only. Late discovery for directory X cannot replace directory Y's
admission or observation slots.

Replay folds both admission and observation events in canonical event order;
it does not reconstruct publication time from a current snapshot cache. Each
provider boundary persists its retained slot keys and keyed clear operations
under the existing evidence projection contract. Bounded eviction removes a
slot from the live reminder only, retaining its event and payload reference for
trajectory/replay. Missing inspection bytes produce unavailable evidence, not
a replacement snapshot or a failed historical Turn.

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

### Protocol clean cut

The pre-release cut removes persisted `Thread.cwd`, `defaultWorkspaceRef`, and
task-target fields from the planned development protocol. Update codecs,
metadata, fork/child creation, Automation snapshots and dispatch, delegation,
diagnostics, preload, renderer DTOs, and restart readers in the same unit.
No compatibility reader or silent fallback remains. A fresh userData tree is
the only supported format.

The cut includes [local tools](../spec/agent-tool-design.md#local-files-and-commands),
[child isolation](../spec/agent-subagent-threads.md#worktree-isolation), and
[Automation](../spec/agent-automations.md), alongside Agent Core, permissions,
model runtime, and the active delegation plan. Unit A delivers the durable S0
admission, receipt, and keyed projection contract as a complete execution
refactor; Unit B adds bounded discovery and its successor events to that
working mechanism. It must not defer mandatory snapshot persistence to Unit B.

## Requirements

- **FR-1:** Every Tool Task records immutable address and context snapshot refs
  before execution, including an explicitly pending S0 on first discovery.
- **FR-2:** Every executable Turn records each context ref used by its tasks.
- **FR-3:** Context generations preserve prior evidence and project replacement,
  addition, and clear semantics through `system-reminder`.
- **FR-4:** Project metadata is optional, non-authoritative, and never a
  permission boundary.
- **FR-5:** Child, fork, delegated, scheduled, and resumed Turns validate
  inherited context before execution.
- **FR-6:** Project deletion leaves no dangling Thread, Automation, or isolated
  resource reference.
- **FR-7:** The clean cut removes old cwd/workspace readers and writers.
- **FR-8:** Discovery publishes immutable successors as later observations;
  it never revises the initiating task's admission context or receipt.

## Acceptance criteria

- **AC-1:** A projectless Chat executes two directories and records separate
  task addresses in one Turn.
- **AC-2:** A Project-hinted Chat executes another directory without rebinding
  or switching Project.
- **AC-3:** Invalid cwd fails before execution-start; discovery failure is
  degraded evidence, not fabricated success.
- **AC-4:** Provider input and trajectory identify the exact context ref and
  generation used by every Tool Task, separately from later observations.
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
| Two directories, out-of-order completion | Independent admission/observation slots; late X discovery cannot replace Y or move the current-task marker. |
| Restart before/after successor publication | Uncommitted payload cannot enter projection; committed S1 is restored once; business mutation is never replayed. |
| Duplicate collector callback | At most one successor event for the same predecessor. |
| Replay after files change or Project deletion | Original S0/S1 references, kinds, publication order, and boundary slot selection remain exact; missing bytes show unavailable. |
| Local tools and delegated isolation | Relative/absolute targets use task addresses; a mismatched isolated resource fails admission without ancestor fallback. |

Unit A adds codec fixtures rejecting retired Thread/start-request fields and a
production-source guard covering `ThreadMetadataStore`, `ThreadCatalogOps`,
`SubagentCollaboration` (or its replacement), `agentLocalTools`, Automation
dispatch, configuration/identity lookup, and restart readers. Combine type
checks that remove the old fields with a source guard against old metadata
accessors and ancestor worktree fallback; a text-only search for `thread.cwd`
is insufficient because aliases can hide readers. Existing receipt cwd fields
remain valid task facts. This guard belongs to the implementation cut, when
the old runtime readers are removed, not to this design-only PR.

## Open questions

- The relative-cwd Host default is implementation detail only and must not be
  persisted as Thread state.
- A future native context refresh command needs evidence that automatic
  admission and next-boundary projection are insufficient.
