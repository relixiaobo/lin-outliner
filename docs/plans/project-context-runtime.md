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

The address and snapshot are immutable for that task. A later cwd or refreshed
observation creates a new task reference and generation. A saved Project root
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
Full Access execution.

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
contains source, generation, resolved cwd, and degradation. `upsert` replaces
only that slot; `clear` removes only that slot; a later task cannot clear an
earlier task's evidence. The provider projection includes an ordered bounded
list of retained slots and a separate `currentToolTaskId` marker. The marker
does not collapse or authorize any slot. Repository instructions and Skills are
source-labelled evidence and cannot change Host capability or execution
address.

The first task against a new cwd may execute before collection completes. The
receipt exposes the collected facts; the next provider boundary receives the
new reminder.

### Project catalog and deletion

Creating or selecting a Project stores a user relationship and optional root
hint. It does not change the current or future Tool Task address by itself. An
Agent proposal requires a Host confirmation action.

Deleting a Project first fences new Project-based admission, then atomically
removes catalog metadata and detaches membership from the complete canonical
Thread lineage, including forks, child, delegated, and hidden Threads. The
lineage relation, not membership rows, enumerates descendants. It does not
cancel active Tool Tasks or invalidate their self-contained receipts. Active
and paused Automations block deletion. Completed Automation history retains a
self-contained non-resumable snapshot. Internal isolated resources have a Tool
Task/Goal cleanup owner and a deleted-parent fence; they cannot retain a
dangling Project dependency.

### Protocol clean cut

The pre-release cut removes persisted `Thread.cwd`, `defaultWorkspaceRef`, and
task-target fields from the planned development protocol. Update codecs,
metadata, fork/child creation, Automation snapshots and dispatch, delegation,
diagnostics, preload, renderer DTOs, and restart readers in the same unit.
No compatibility reader or silent fallback remains. A fresh userData tree is
the only supported format.

## Requirements

- **FR-1:** Every Tool Task records immutable address and context snapshot refs.
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

## Acceptance criteria

- **AC-1:** A projectless Chat executes two directories and records separate
  task addresses in one Turn.
- **AC-2:** A Project-hinted Chat executes another directory without rebinding
  or switching Project.
- **AC-3:** Invalid cwd fails before execution-start; discovery failure is
  degraded evidence, not fabricated success.
- **AC-4:** Provider input and trajectory identify the exact context ref and
  generation used by every Tool Task.
- **AC-5:** Child/fork/delegated/scheduled/resumed execution with stale context
  refreshes or returns structured non-success.
- **AC-6:** Project deletion detaches the full Thread lineage, blocks active or
  paused Automation references, and leaves completed history readable but
  non-resumable.
- **AC-7:** No codec, Automation, fork, child, diagnostics, or restart path
  reads a retired cwd/default-workspace/task-target field.

## Tests and evidence

Add codec and invalid-state tests, multi-cwd Turn replay, generation
replacement/clear tests, ancestor scope tests, degraded discovery tests,
Project confirmation/deletion tests, Automation/fork/child/resume tests, and
fresh-userData clean-cut tests. Capture a trajectory fixture proving each Tool
Task's context reference.

## Open questions

- The relative-cwd Host default is implementation detail only and must not be
  persisted as Thread state.
- A future native context refresh command needs evidence that automatic
  admission and next-boundary projection are insufficient.
