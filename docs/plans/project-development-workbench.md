# Agent Capability-First Development Workbench

**Shape:** One complete architectural design composed of independently
shippable child features. The design makes the Agent's execution context the
runtime authority and keeps Project optional product organization.

## Goal

Let an Agent work on any local project with the fewest artificial restrictions.
The user can start with a normal Chat, name a directory when needed, let the
Agent inspect and modify files, run project checks, correct failures, review a
diff, and explicitly publish a result. A Project is useful for durable
organization but never required for source work and never acts as a sandbox.

```text
request -> choose execution address -> inspect -> edit -> verify -> review
        -> optional explicit publication -> recover from durable evidence
```

## Non-goals

- A Project, Workspace, or Thread-level cwd as an execution permission boundary.
- A model-facing project, workspace, target, or sandbox tool.
- Approval prompts for ordinary work already authorized by the user request.
- Automatic Project binding because the Agent visited a path.
- Implicit commit, push, merge, force-push, or publication.
- A second Git, check, permission, process, or transcript ledger.
- A portable OS sandbox claim before a backend and failure behavior are proven.

## Design

### First principle

The Agent needs freedom to choose procedures and directories. The Host needs
truthful ownership of facts, capability admission, process lifecycle, and
durable side effects. Therefore the primary runtime fact is the context of one
actual Tool Task, not the Project or Chat that requested it.

### Product and runtime entities

```text
Thread
  conversation history, provider configuration, optional Project membership

Turn
  one model interaction and ordered references to the context used by its calls

Tool Task
  one foreground/background process or host operation

ExecutionAddress
  requested/resolved cwd, canonical root/worktree identity

ExecutionPolicy
  capability decision, read-only ceiling, isolation decision

ContextSnapshot
  Git observations, instruction/profile sources, checks, generation, degradation

Project
  optional display identity, saved root hints, context presets, Chat grouping
```

`ToolTask.executionContext` contains immutable references to
`ExecutionAddress`, `ExecutionPolicy`, and `ContextSnapshot`. All three
references are fixed and durable before spawn. A later command with another
cwd receives a new address and snapshot. No Thread stores `cwd`,
`defaultWorkspaceRef`, task target, or a second path alias.

Project stores user-facing relationship and context presets only. A saved root
hint is a lookup/display value, not runtime truth, a permission boundary, or a
Workspace authority. Changing it never rebinds an active or historical Tool
Task. Internal managed directories may exist for scratch storage or isolation,
but they are Host resources owned by Tool Tasks/Goals, not user-facing
execution entities.

### Bash execution contract

The existing Bash surface gains one strict optional `cwd` field. The Host:

1. validates the field before execution;
2. resolves relative paths against the documented Host default;
3. canonicalizes the path and captures root/worktree identity when available;
4. resolves capability and isolation before spawn; and
5. records the complete execution context on the Tool Task receipt.

Under explicit Full Access, an absolute path outside any Project is valid.
`cwd` changes process-relative path resolution only. It cannot bind a Project,
create a Workspace, widen capabilities, or alter a later task's default. An
invalid, missing, or unresolvable path returns a structured non-success result
without an execution-start event.

Absolute paths inside a command remain valid Full Access inputs, but do not
create a remembered cwd. A Skill or repository instruction may recommend a
directory; only the Host resolves and records the actual address.

The same address contract applies to every local file or process capability.
File reads, writes, edits, deletes, and background producers must either carry
the optional task-scoped `cwd` or use an explicit path that the Host
canonicalizes into an `ExecutionAddress`. No local mutation may resolve from a
retired Thread cwd, an unrecorded prompt value, or a Skill-local directory.
The resulting Tool Task receipt always names the canonical target and its root
or worktree identity.

### Context admission and injection

The Host collects bounded facts for the actual task address:

```text
cwd / Git / instruction files / profile / checks
  -> ContextSnapshot with provenance and generation
  -> persisted context evidence
  -> ContextProjector replacement/diff/clear
  -> existing system-reminder envelope
  -> provider input
```

The stable prompt contains only cross-project rules:

- **L0:** security, capability, process ownership, evidence, recovery, and
  untrusted-data rules.
- **L1:** how to use Bash, Skills, Tool Tasks, checks, and evidence.

Per-Turn context facts and source-labelled repository instructions are injected
as evidence, never into the stable prompt fingerprint. They cannot override
Host authority or user intent. Each context contribution carries a stable
`contextSlotKey = { turnId, toolTaskId, contextSnapshotRef }`; projection
operations are keyed `upsert` or `clear` by that slot. A later task adds or
replaces its own slot and cannot clear an earlier task's evidence. Slots
distinguish context used at admission from observations published afterward.
Replay reconstructs the ordered slot map from canonical admission, observation,
and projection events and marks the latest admitted task as current without
collapsing the other slots. Discovery completion never moves that marker.

Context admission is required for every executable Turn: root, fork, child,
delegated, scheduled, and resumed. A Turn records the exact context reference
used by each Tool Task. A child may reuse a parent snapshot only after recording
the reference and validating that the address is still available. Otherwise it
gets a fresh snapshot or a structured non-success result. A Turn may reference
multiple snapshots when its Tool Tasks use multiple directories; there is no
single Turn-wide cwd.

Before the first task in a directory starts, the Host persists an immutable
generation-0 snapshot with pending discovery, unknown observations, and a
degradation reason. Its admission and terminal receipt retain that reference.
Discovery publishes generation 1 as a separate, later observation slot at the
next provider boundary; only later admissions may consume it as execution
context. Failure, restart, and replay never fill in or rewrite generation 0.
The exact ordering is defined by the
[snapshot lifecycle](project-context-runtime.md#snapshot-admission-and-discovery-lifecycle).
Discovery degradation does not block ordinary Full Access work; mandatory
address, policy, claim, and isolation validation still completes before spawn.

### Project and user interaction

New Chat starts without a Project and without a visible project status row. The
user can name a directory in natural language, attach a folder, open/clone a
Project, or simply continue chatting. The Agent uses task-scoped `cwd` as
needed. A Project selection adds context and grouping; it does not lock the
Chat to one directory.

`New chat in project` creates a new Thread with a Project hint. It does not
copy execution authority. Cross-directory work remains one Chat:

```text
Bash(cwd: ~/Coding/frontend, command: "bun test")
Bash(cwd: ~/Coding/backend, command: "git diff --stat")
Bash(cwd: ~/Coding/frontend, command: "bun run typecheck")
```

The task cards show the actual cwd. Project status, when present, stays compact
near the composer. Full Access and isolation details appear only on relevant
task details.

The Agent may propose a durable Project only after the user expresses lasting
intent. The Host shows the canonical path and consequences in a confirmation
card. Ordinary file/process work never requires that confirmation.

### Authority and safety

Precedence is:

1. Host security and capability admission.
2. Accepted user intent and explicit constraints.
3. Host-labelled execution facts.
4. Repository instructions, profiles, and Skills.
5. Files, command output, and prior transcript as untrusted evidence.

Full Access is the default execution contract. Read-only ceilings, isolated
worktrees, and OS sandboxing are optional Host policies for delegated or
explicitly isolated work. Requested isolation fails closed when unavailable;
explicit Full Access remains truthful and is recorded as `unsandboxed` where no
OS sandbox is enforced.

Skills and project instructions describe procedure only. They cannot change
cwd, grant capability, approve publication, attest to process results, or own a
second ledger.

### Concurrency, deletion, and recovery

Tool Tasks are the only process ledger. A mutating task claims the canonical
worktree identity atomically (Git worktree realpath when available, otherwise
the canonical non-Git root realpath); a conflicting mutation returns `worktree_busy`
and an isolated-worktree action instead of silently queueing behind the claim.
The claim releases only after terminal receipt or restart reconciliation.

Project deletion is a catalog transaction. It detaches Project membership from
the complete Thread lineage, including fork, child, delegated, and hidden
Threads, by querying the canonical parent/child lineage relation rather than
assuming membership rows enumerate descendants. The transaction first fences
new Project-based admission, then detaches every affected Thread and removes
Project metadata. It does not cancel active Tool Tasks, delete user files, or
invalidate receipts: active tasks retain self-contained address, policy, and
snapshot facts. Isolated resources have their own cleanup owner and parent
fence; cleanup receives a deleted-parent tombstone and cannot resolve a
missing Project. Active or paused Automations whose hints reference the Project,
and pending claims that still depend on it, block deletion. Completed Automation
history retains self-contained dispatch snapshots and cannot resume historical
runs; reactivating a definition requires fresh hint validation.

Automation scheduling is keyed by definition identity, stable context-hint
identity, and occurrence identity. Those keys are not paths or repository
identities. Each new dispatch resolves its claimed hint into an immutable
address/policy/context snapshot; recovery uses that captured dispatch evidence,
not the current Project catalog. Every subsequent Tool Task still owns its
actual execution context. Cursor, overlap, edit, deletion, continuity, and
managed-worktree recovery rules have one authority in
[Agent Automations](../spec/agent-automations.md).

Restart reconciles unfinished Tool Tasks before resuming. Missing terminal
evidence is `lost` or `stopped`, never success. A lost provider response never
replays a mutation by assumption.

### Verification and publication

Project profiles may declare required and optional checks. Tool Tasks run them
and retain bounded output, exit state, context references, and worktree identity.
A user-started Goal may compose `inspect -> edit -> check -> correct -> rerun`
with a finite iteration/token budget and a durable stop reason. It cannot
publish implicitly.

Review uses existing Git/hosting CLIs through Bash and Tool Tasks. Its snapshot
records staged, unstaged, untracked, renamed, deleted, and binary paths. Every
path has a canonical identity, file kind, size, and content/diff digest that is
recomputed before commit. A mismatch requires a refreshed review. Commit,
push, and PR operations record their factual result and reconcile uncertainty
before retrying.

## Reference selection

| Reference | Adopt | Exclude |
|---|---|---|
| Codex CLI | task `workdir`, typed WorldState, process ownership, recovery | full app-server and policy matrix before demand exists |
| Claude Code 2.1 | any-directory workflow, layered instructions, Skills, background tasks | prompt/memory as execution truth or approval authority |
| Pi | minimal kernel, reload/compaction, extension seams | extensions changing Host authority without admission |
| Tenon | Thread/Turn/Item, Tool Tasks, Goals, Host/renderer seam, evidence projection | Project-specific permission layer or parallel ledger |

The architecture is execution-first like Codex, the user workflow is
directory-first like Claude Code, and the extension boundary is minimal like
Pi. Tenon owns the product and persistence model.

## Requirements

- **FR-1:** Thread has no execution cwd, task target, or workspace permission.
- **FR-2:** Bash accepts strict optional task-scoped `cwd` and records its
  canonical resolution.
- **FR-2a:** Every local file/process capability uses the same task-scoped
  address contract and records its canonical target; none reads a Thread cwd.
- **FR-3:** Project is optional organization and context; it cannot narrow
  Full Access or silently redirect an existing Chat.
- **FR-4:** Every Tool Task has immutable address, policy, and snapshot facts
  durably recorded before execution, even while discovery is pending.
- **FR-5:** Every executable Turn records the context used by every Tool Task.
- **FR-6:** Context is projected through typed evidence and system-reminder.
- **FR-7:** Requested isolation fails closed; ordinary Full Access remains usable.
- **FR-8:** Same-worktree mutation claims are atomic and recoverable.
- **FR-9:** Project deletion leaves no dangling Thread or Tool Task reference.
- **FR-10:** Verification and self-iteration are bounded and evidence-backed.
- **FR-11:** Review verifies untracked and binary content before publication.

## Acceptance criteria

- **AC-1:** A projectless Chat edits and verifies two directories in one Chat.
- **AC-2:** A Project-hinted Chat performs a task in another directory without
  Project switching.
- **AC-3:** Invalid `cwd` produces no execution-start event.
- **AC-3a:** A file read/write/edit/delete using a relative, absolute, or
  task-scoped path resolves one canonical address and appears in its Tool Task
  receipt; no path uses retired Thread cwd state.
- **AC-4:** A Turn with multiple directories records one context reference per
  Tool Task and replays them in order. Later discovery has separate observation
  slots and never changes an executed task's reference.
- **AC-5:** Child, fork, delegated, scheduled, and resumed Turns cannot execute
  without a valid context reference.
- **AC-6:** Project deletion cannot leave dangling lineage or active-task
  references; completed history remains readable and non-resumable.
- **AC-7:** Concurrent mutation returns `worktree_busy` or an isolated action;
  it is never silently queued behind the worktree claim.
- **AC-8:** Review detects post-review changes to untracked, renamed, deleted,
  and binary files before commit.
- **AC-9:** A bounded correction loop reports factual checks, budget use, and
  stop reason without implicit publication.
- **AC-10:** Restart never turns missing execution evidence into success or
  replays a mutation by assumption.
- **AC-11:** The same workflow succeeds for Tenon and a second project with a
  different toolchain.

## Delivery units

### Unit A: Execution-context protocol and Bash cwd

Define codecs, admission, Tool Task receipt fields, capability interaction,
context references, and recovery for task-scoped `cwd`. Remove planned
Thread/workspace execution authority and update all fork, child, Automation,
delegation, diagnostics, preload, and renderer consumers in the same clean cut.
This is one complete execution refactor: it includes durable generation-0
snapshots and their admission/receipt/projection path, so all tools work before
Unit B adds richer discovery. No consumer implements against a partial protocol.

The specs in this design PR describe the intended replacement contract; they
do not claim that the runtime cut has shipped. Unit A must reconcile code and
all of these authorities together: `agent-tool-design`, `agent-tool-permissions`,
`agent-subagent-threads`, `agent-model-runtime`, `agent-thread-rendering`, `agent-core`,
`agent-automations`, and the active `agent-delegation-runtime` plan. This includes
local path resolution, child resource inheritance/orphan recovery, configuration
source lookup, transcript indexes, task-relative renderer links, and removal of
a single working directory from Turn environment evidence. Add codec rejection
and production-reader guards specified in the
context plan, not only tests of the new Bash field.

Automation's complete adapter change is in this same unit: replace
`AutomationProjectBinding` and `AutomationRun.projectBindingKey` in
`src/core/agent/automation.ts`; change `AutomationStore` cursor/claim/continuity
queries, `AutomationScheduler` occurrence admission, `AutomationService`
definition and lifecycle validation, `AutomationDispatcher.dispatch` and
`recoverAcceptedTurn`, and `AutomationWorktree.prepare`, `resumePrepared`, and
`snapshotAndRemove`. DTOs, codecs, model-tool schema, preload, renderer editing,
and recovery fixtures must consume the final hint/dispatch-snapshot contract.
This adds no parallel scheduler, workspace store, or compatibility reader.

### Unit B: Context projection and optional Project catalog

Implement bounded root inspection, instruction/profile snapshots, generations,
degraded facts, system-reminder projection, Project grouping, and confirmed
Agent binding requests. Extend Unit A's generation-0 mechanism with immutable
successors and observation events, including failure/restart/replay behavior.
Project metadata remains non-authoritative; its catalog deletion fence uses
Unit A's Automation lifecycle contract.

### Unit C: Verification and bounded self-iteration

Compose Tool Tasks, Goals, Skills, and project checks into a finite
inspect-fix-rerun workflow with restart and incomplete-check recovery.

### Unit D: Git review and explicit publication

Implement review snapshots, content digests, selected-path commit admission,
remote reconciliation, and explicit push/PR previews through existing CLIs.

### Unit E: Isolation and interactive process evidence

Record actual sandbox enforcement and run the tmux experiment through Bash and
Tool Tasks. Add native persistent process semantics only after a reproducible
ownership or recovery gap is measured.

## Implementation contracts

- [Project context runtime](project-context-runtime.md) defines Unit B's
  context collection and Project catalog boundary.
- [Verification and bounded self-iteration](verification-self-iteration.md)
  defines Unit C's check and Goal contracts.
- [Git review and publication](git-review-publication.md) defines Unit D's
  review and publication evidence.
- [Execution sandbox and interactive processes](execution-sandbox-process.md)
  defines Unit E's isolation receipt and tmux experiment.

The shared protocol/codec changes in Unit A land before consumers. Every child
plan must use the entities and invariants in this plan; a child plan cannot
reintroduce Thread cwd, defaultWorkspaceRef, task target, Project-owned runtime
identity, or a parallel ledger.

Collision self-check (2026-09-07): `gh pr list --state open` found this claim,
PR #639, and #643 (Settings Unit D, Skill configuration/lifecycle). #643 claims
Skill/settings implementation, with no changed files at inspection; its scope
does not overlap this documentation batch. `docs/TASKS.md` still carries the
delegation dependency below. The batch has **no file overlap**; runtime and
configuration consumers must use the final merged mechanisms at implementation.

Unit A is the semantic predecessor of the execution-context consumers in the
active `agent-delegation-runtime` plan. Main must rebase that plan on Unit A
before marking that board item eligible: Session policy may request an isolated
worktree, but Session or Runner must never become the owner of a sticky cwd or
a second execution ledger.

## Verification strategy

Run protocol/codec, lifecycle, restart, concurrency, digest, renderer, and
cross-project end-to-end tests. Before a PR is ready, run:

```text
bun run typecheck
bun run test:core
bun run test:renderer
bun run docs:check
git diff --check
```

Run E2E for the complete workflow and process/restart changes. Fold shipped
behavior into `docs/spec/` in the same change and archive this plan only after
the main-agent gate.

## Open questions

- The Host default for a relative `cwd` is an implementation detail and must
  not become a Thread-owned persisted fact.
- Publication confirmation semantics remain governed by the explicit Git
  review/publication contract.
