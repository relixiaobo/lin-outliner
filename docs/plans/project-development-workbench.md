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
  requested/resolved cwd, canonical target/scope identities

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
The receipt names the admitted address and any targets the Host resolved from
typed file arguments. It does not infer every path a shell or native launcher
will access from command text. Instruction/profile scope for a file call follows
its canonical target; Bash scope follows its cwd, as defined in the context plan.

### Context admission and injection

The Host collects bounded facts for the actual task address:

```text
cwd / Git / instruction files / profile / checks
  -> ContextSnapshot with provenance and generation
  -> persisted context evidence
  -> scoped effective-state reduction
  -> frozen semantic delta at a canonical publication boundary
  -> appended system-reminder envelope
  -> provider input
```

The stable prompt contains reusable rules and explicitly selected configuration:

- **L0:** security, capability, process ownership, evidence, recovery, and
  untrusted-data rules.
- **L1:** how to use Bash, Skills, Tool Tasks, checks, and evidence.
- **L2:** explicitly selected conversation identity and configuration guidance.

Per-Turn context facts and source-labelled repository instructions are injected
as evidence, never into the stable prompt fingerprint. They cannot override
Host authority or user intent. Tool Task receipts retain exact address, policy,
and snapshot references; a reducer derives current scoped knowledge; the provider
receives only decision-relevant additions, changes, and invalidations. These are
representations of the same evidence, not independent stores. Task correlation
keys remain private and do not require a model-visible task-slot list or a
current-task marker. A new task using unchanged instructions does not repeat
their body. Audit evidence and model visibility remain distinct.

The shared authority is
[Execution Context Publication](../spec/agent-model-runtime.md#execution-context-publication).
It owns publication order, semantic equality, source/scope isolation, frozen
bundle boundaries, compaction restoration, cache affinity, and validation.
All child features consume it. They cannot replace earlier reminder text,
insert a late observation into a completed Turn, or use slot eviction to remove
historical model input. Context reset and compaction are explicit history
boundaries with an expected cache cost, not ordinary state updates.

Stable guidance teaches source authority, scoped applicability, and reading
uninspected project instructions before relying on them. Development, checking,
Git publication, and interactive-process recipes live in Skills and use existing
CLIs. Runtime code enforces publication, deduplication, budgets, and restore;
neither a prompt rule nor a Skill is responsible for cache correctness.

Task discovery does not select a root Configuration Profile, persona, model,
or tool catalog. Those follow the explicitly selected conversation configuration
source, including a Project source when explicitly selected through that owner.
Project grouping alone does not apply a configuration change. Project check
profiles describe scoped commands and verification inputs; they are not root
Configuration Profiles. Deliberate configuration or capability changes retain
their existing admission semantics even when they change cacheable input.

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
Discovery publishes generation 1 as a separate, later observation at the
next provider boundary; only later admissions may consume it as execution
context. Failure, restart, and replay never fill in or rewrite generation 0.
The exact ordering follows the current
[task discovery lifecycle](../spec/agent-tool-design.md#local-files-and-commands)
and [execution-context publication](../spec/agent-model-runtime.md#execution-context-publication) contracts.
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

Full Access is the default for ordinary root work. Writable delegation requires
a dedicated worktree under the existing launcher contract; internal read-only
ceilings and external disposable-worktree policies remain distinct. OS
sandboxing is a separate policy with separately recorded enforcement. Requested
or required isolation fails closed when unavailable;
explicit Full Access remains truthful and is recorded as `unsandboxed` where no
OS sandbox is enforced.

Skills and project instructions describe procedure only. They cannot change
cwd, grant capability, approve publication, attest to process results, or own a
second ledger.

### Concurrency, deletion, and recovery

Tool Tasks are the only process ledger. Address claims coordinate tasks that
declare the same canonical scope; they are not a filesystem boundary or a
guarantee that all Full Access writes are serialized.

For tasks requiring mutation coordination, admission derives keys from their
known scope. Bash and native launchers claim their resolved cwd's Git worktree
identity, or their exact
canonical directory when non-Git. Typed file mutations derive keys from their
canonical targets' Git worktrees, or canonical parent directories for non-Git
file entries, independently of cwd; an operation with several known
targets claims all corresponding keys. `ToolTaskStore` persists the immutable
key set and acquires it in one transaction with an active unique claim per
key. A collision rolls back the whole acquisition and returns `worktree_busy`
with an isolated-worktree action where available. Claims are never silently
queued; release follows terminal receipt or restart reconciliation of that task.

Internal tool calls executing within an already claimed launcher task receive
a Host-private reference to that task's claim for the covered keys, not a new
competing lease. Additional keys require ordinary admission. Child completion
cannot release the owning task's claim, and unrelated Sessions cannot inherit
it. Recovery settles covered child work before releasing the owner claim.

Receipts label coverage `known-targets` for typed file operations or `cwd-only`
for shell/native launcher work. Unknown shell effects remain allowed under
Full Access and are explicitly outside claim coverage. No shell parser, new
target tool, or model-supplied target list is treated as proof of complete write
coverage. `bash(cwd: A, command: "git -C B ...")` may modify B without claiming
B; two such tasks are not promised mutual exclusion. Different non-Git scope
keys and writes by editors or external processes have the same limitation.
The development Skill uses the actual repository as cwd for each mutation and
splits cross-repository writes into separate calls when practical. Verification
and commit admission independently revalidate state; they cannot treat this
cooperative claim as isolation or proof that files stayed unchanged.

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
A source manifest and verification revision bind results to the state checked.
Any included-source edit invalidates previous passes; a new revision reruns all
required checks. Aggregation and restart revalidate the full declared scope,
not merely the address or instruction snapshot. Exact rules and the limits of
external-change observation live in the verification plan.
A user-started Goal may compose `inspect -> edit -> check -> correct -> rerun`
with a finite iteration/token budget and a durable stop reason. It cannot
publish implicitly.

Review uses existing Git/hosting CLIs through Bash and Tool Tasks. Its snapshot
records staged, unstaged, untracked, renamed, deleted, and binary paths. Every
path has a canonical identity, file kind, size, and content/diff digest that is
recomputed before commit. Review also captures mandatory HEAD OID, symbolic ref
or detached/unborn state, worktree identity, and index state independently of
optional context discovery. Any baseline or content mismatch requires a
refreshed review, including switching branches at the same OID. Commit,
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
- **FR-8:** Claims on admitted address scopes are atomic and recoverable, with
  explicit coverage limits for unknown or external writes.
- **FR-9:** Project deletion leaves no dangling Thread or Tool Task reference.
- **FR-10:** Verification and self-iteration are bounded and evidence-backed.
- **FR-11:** Review verifies untracked and binary content before publication.
- **FR-12:** Check applicability is bound to a source manifest/revision; stale
  passes never satisfy current verification.
- **FR-13:** Commit admission verifies the reviewed HEAD/ref and file/index
  state independently of optional Git discovery.
- **FR-14:** All producers use the common scoped publication and compaction
  contract; ordinary context changes preserve published prefixes and never
  select a new configuration source or cache affinity implicitly.

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
  evidence and never changes an executed task's reference or earlier model input.
- **AC-5:** Child, fork, delegated, scheduled, and resumed Turns cannot execute
  without a valid context reference.
- **AC-6:** Project deletion cannot leave dangling lineage or active-task
  references; completed history remains readable and non-resumable.
- **AC-7:** Tasks claiming the same scope receive `worktree_busy` on conflict;
  multi-key acquisition is all-or-nothing and never silently queued. A shell
  writing B from cwd A records `cwd-only` coverage and does not claim B is locked.
  Internal delegated tools consume their owning task's covered claim without
  self-conflict; a different Session cannot reuse it.
- **AC-8:** Review detects post-review changes to untracked, renamed, deleted,
  and binary files, HEAD, and branch/ref before commit.
- **AC-9:** A bounded correction loop reports factual checks, budget use, and
  stop reason without implicit publication.
- **AC-10:** Restart never turns missing execution evidence into success or
  replays a mutation by assumption.
- **AC-11:** The same workflow succeeds for Tenon and a second project with a
  different toolchain.
- **AC-12:** Fixing failed check B invalidates passed A; both must pass at the
  new source revision, including after restart.
- **AC-13:** Repeated tasks with unchanged sources do not repeat instruction
  bodies. Cross-directory, late-discovery, invalidation, restart, and compaction
  fixtures satisfy the shared publication contract at actual provider boundaries.
- **AC-14:** Visiting a second directory or regrouping a Thread does not change
  its configuration source, tool schemas, stable prompt, or cache affinity.
  An explicitly applied configuration change still follows its owning contract.

## Delivery units

### Unit A: Execution-context protocol and Bash cwd

Define codecs, admission, Tool Task receipt fields, capability interaction,
context references, and recovery for task-scoped `cwd`. Remove planned
Thread/workspace execution authority and update all fork, child, Automation,
delegation, diagnostics, preload, and renderer consumers in the same clean cut.
This is one complete execution refactor: it includes durable generation-0
snapshots and their admission/receipt/projection path, so all tools work before
Unit B adds richer discovery. No consumer implements against a partial protocol.
It also implements scoped reduction, immutable publication boundaries, the
extended compaction checkpoint/dependency graph, and deterministic prefix tests
using pending context. These mechanisms cannot be deferred to Unit B or a
separate cache scaffold. Exact receipt refs stay private while prepared-input
provenance proves which evidence the model actually received.

The specs in this design PR describe the intended replacement contract; they
do not claim that the runtime cut has shipped. Unit A must reconcile code and
all of these authorities together: `agent-tool-design`, `agent-tool-permissions`,
`agent-delegation`, `agent-model-runtime`, `agent-thread-rendering`, `agent-core`,
`agent-automations`, and the active `agent-delegation-runtime` plan. This includes
local path resolution, delegated resource continuity/recovery, configuration
source lookup, transcript indexes, task-relative renderer links, and removal of
a single working directory from Turn environment evidence. Add codec rejection
and production-reader guards specified in the
context plan, not only tests of the new Bash field.

The baseline already contains internal delegation, native CLI launchers, and
file-backed Settings. Adapt `DelegationCoordinator`, `DelegationSessionStore`,
`DelegateCapabilityBroker`, `InternalDelegationSessionRuntime`, and
`ExternalAgentCliLauncher` in place. Writable isolation stays mandatory, native
CLI execution remains vendor-owned, and retired Subagent tools/ledgers/specs
stay deleted. No new adapter or nesting mechanism is part of this cut.

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
Use Unit A's publication/restore contract for source-scoped baselines and
deltas; discovery adds no parallel catalog, Skill-invocation owner, or prompt
overlay. Exercise multi-directory and delayed-publication fixtures with real
instruction/profile sources.
Project metadata remains non-authoritative; its catalog deletion fence uses
Unit A's Automation lifecycle contract.

### Unit C: Verification and bounded self-iteration

Compose Tool Tasks, Goals, Skills, and project checks into a finite
inspect-fix-rerun workflow with source-manifest invalidation, current-result
aggregation, and restart recovery that revalidates old passes.

### Unit D: Git review and explicit publication

Implement review snapshots, mandatory HEAD/ref baselines, content digests,
selected-path commit admission,
remote reconciliation, and explicit push/PR previews through existing CLIs.

### Unit E: Isolation and interactive process evidence

Record actual sandbox enforcement and run the tmux experiment through Bash and
Tool Tasks. Add native persistent process semantics only after a reproducible
ownership or recovery gap is measured.

## Implementation contracts

- [Local files and commands](../spec/agent-tool-design.md#local-files-and-commands)
  and [Optional Project catalog](../spec/agent-core.md#optional-project-catalog)
  define Unit B's context collection and Project catalog boundary. Its original
  design remains in [Project context runtime](archive/project-context-runtime.md).
- [Source-bound verification](../spec/agent-tool-design.md#source-bound-verification)
  defines the current check and Goal contracts; the
  [archived verification design](archive/verification-self-iteration.md)
  preserves Unit C's design rationale.
- [Git review and publication](git-review-publication.md) defines Unit D's
  review and publication evidence.
- [Execution sandbox and interactive processes](execution-sandbox-process.md)
  defines Unit E's isolation receipt and tmux experiment.

The shared protocol/codec changes in Unit A land before consumers. Every child
plan must use the entities and invariants in this plan; a child plan cannot
reintroduce Thread cwd, defaultWorkspaceRef, task target, Project-owned runtime
identity, or a parallel ledger.

Collision self-check (2026-09-07): the revision starts from main after #639 and
#643. Draft #644 claims Skill lifecycle operations and Agent/Skill specs. Its
current `settings-control-plane.md` change links the Skill delivery unit; this
revision changes the configuration-source section of that same file. Preserve
both hunks and reconcile any later shared-spec changes at main review. This
documentation claim changes no Skill lifecycle APIs, public settings schemas,
runtime source, or infrastructure-owned file. Implementation claims must recheck
the live PR scopes and use the final merged Skill mechanism.

Unit A follows the shipped delegation/native-launcher baseline and updates its
task-context consumers in one refactor. Future features consume that merged
contract. The active aggregate delegation plan has matching integration text;
main owns board sequencing without treating its already shipped units as
blocked on this proposal.

## Verification strategy

Run protocol/codec, lifecycle, restart, concurrency, digest, renderer, and
cross-project end-to-end tests for implementation. The common publication
fixtures are defined once in model-runtime; each delivery unit adds its own
producer scenarios and uses actual prepared/post-adapter input as evidence.
Unit A owns the generic fixtures, B owns discovery/scope cases, and C/D/E own
correction, review, and process continuations. No separate cache feature is
required. Before an implementation PR is ready, run:

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
