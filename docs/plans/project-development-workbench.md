# General Project Development Workbench

**Shape:** Four independently shippable features with a real dependency order.
Each unit completes a useful workflow; none is a scaffold for a later unit.

## Goal

Make Tenon a reliable daily development environment for any software project.
Given a Project workspace or an explicitly named external directory, a developer can orient
the Agent, make a scoped change, run the project's checks, inspect factual
results, recover after restart, and hand off a reviewable commit or pull
request. A durable Project relationship is optional.

```text
request -> resolve workspace/context -> inspect -> plan -> edit -> check
        -> correct within budget -> review -> explicit commit/PR
        -> recover from durable facts when interrupted
```

`bind project` is an explicit, infrequent branch of workspace resolution for a
user-requested durable relationship; it is not a prerequisite for source work.

Tenon is the first dogfood project. It is not the product boundary.

## Purpose

This plan is the design contract for a general project workflow. It records the
semantic boundaries that must remain stable while implementation is split into
independent delivery units.

## Non-goals

- An IDE, debugger, embedded language server, or editor replacement.
- A native Git, test-runner, GitHub, or artifact authority when the project's
  own CLI and the existing Tool Task path provide the fact.
- An unrestricted autonomous loop, automatic merge, force-push, or publication
  that bypasses project governance.
- A second permission protocol. Host capability, worktree, read-only, approval,
  and explicit user-action contracts remain authoritative.
- Portable sandbox claims before a platform backend and its failure behavior
  have been proven.
- A migration reader for a pre-release format change.

## Constraints

- TypeScript/Electron and the existing main/preload/renderer process seam remain
  the product architecture.
- Git remains the source of truth for Git projects; project tools remain the
  source of truth for checks and builds.
- Every mutation remains subject to the existing capability, worktree, and
  persistence contracts.

## Evidence

The design is based on direct inspection of the local Codex CLI, Claude Code
2.1, Claude Code, Pi coding agent, and Tenon implementations. The decisive
observations are summarized in the comparison below; implementation details are
included only where they change an ownership or recovery decision.

## Final decision

Tenon will use a small model-facing tool surface and a Host-owned runtime:

```text
Host authority
  project context + capability admission + process execution + persistence

Procedure
  project profile + Skills + repository CLIs

Workflow
  Tool Tasks + Goals + plans + Subagent Threads

Provider context
  typed evidence -> ContextProjector -> existing system-reminder envelope
```

The Host owns facts, authority, process identity, and recovery. Skills describe
procedures and may call existing CLIs through Bash; they cannot grant authority,
replace a ledger, or attest to an effect they did not observe. A native tool is
added only when an experiment demonstrates that existing Host commands, Skills,
CLIs, or Tool Tasks cannot provide reliable ownership, cancellation, recovery,
or security.

Future extensions attach at one of four seams and do not change the Project or
Chat model:

```text
new project type      -> Project profile
new procedure         -> Skill or repository CLI
new execution backend -> Tool Task runtime
new provider context  -> typed context payload + projector
```

An extension that needs a new identity, permission authority, or execution
ledger is a core design change and must first demonstrate that all four seams
are insufficient.

Chat remains the primary interaction entry point. Project is a durable optional
container for chats and a primary working root; each Tool Task captures its
execution context. A projectless Chat may use an explicitly named
external execution context, and a project-bound Chat may use another directory, without
changing its primary project.

## First-principles method

This is not a union of Codex, Claude Code, and Pi features. The design starts
from the outcome Tenon must guarantee and uses the references only as evidence
for particular mechanisms.

### The problem we are solving

The Agent must change arbitrary project source and produce a trustworthy,
reviewable result despite mutable files, long-running commands, provider
interruptions, and project-specific workflows. “Can invoke a tool” is not the
success condition. The success condition is that every claimed fact and side
effect can be tied to the right project, command, Turn, and recovery state.

### Threats and invariants

The design is driven by five failure classes:

| Failure | Required invariant | Consequence |
|---|---|---|
| Stale or wrong project context | Mutation is bound to one canonical root/worktree | Project identity is Host state, not prompt text |
| Tool output mistaken for truth | Claims require bounded, attributable evidence | Reports project Tool Task receipts; Skills cannot attest |
| Interrupted side effect replayed | Mutations have durable identity and recovery state | Retry rereads state; it never guesses from a missing response |
| Procedure widens authority | Authority is decided before procedure execution | Profiles and Skills cannot change capability ceilings |
| Unbounded automation or sandbox downgrade | Autonomy and isolation fail closed | Goals have budgets; requested sandbox failure cannot become silent Full Access |

These invariants are ordered lexicographically: correctness and authority
boundaries come before recovery, generality, cost, and convenience. A feature
that improves ergonomics but weakens an invariant is rejected regardless of how
many reference projects implement it.

### Reference selection rule

Each sub-plan has one primary reference for its central mechanism and uses the
other projects only to test the boundary:

| Sub-plan | Primary reference | Secondary evidence | Reason |
|---|---|---|---|
| Project context | Codex `AgentsMdState` and `WorldState` | Claude `getMemoryFiles`; Pi `reload` | The hard problem is typed per-Turn replay, not file discovery alone |
| Verification loop | Tenon `ToolTaskService` plus Codex `UnifiedExecProcessManager` | Claude `TaskOutput`; Pi `bash-executor` | The hard problem is truthful execution evidence and recovery |
| Git publication | Git itself plus Claude review/commit workflows | Codex mutation hooks; Pi Git extension | The hard problem is external side-effect reconciliation, not a new Git API |
| Sandbox/process | Codex execution substrate | Claude `sandbox-runtime`; Pi `tmux`/sandbox extension | The hard problem is process ownership and explicit enforcement status |

No sub-plan may adopt a mechanism merely because it appears in a reference
project. The mechanism must answer a named Tenon failure, have one Host owner,
define its durable receipt or evidence, and have a test that can fail if the
invariant regresses.

### Anti-blend gate

Before adding a feature, record four decisions in its plan or PR:

```text
failure addressed -> chosen owner -> durable fact produced -> rejection test
```

If the answer is “the model can probably remember it”, “the Skill can enforce
it”, or “another project has this command”, the feature has not passed the gate.
This deliberately leaves some reference capabilities out of Tenon: Pi's
unrestricted extension authority, Claude's prompt-level mutable context as a
ledger, Codex's multi-client protocol machinery before demand exists, and any
native tool whose existing CLI/Skill/Tool Task path has not failed.

## Product thesis and scope firewall

Tenon is a host for **project-defined work with durable evidence**. It is not a
universal IDE, a replacement for project CLIs, or a union of agent features.
The universal part is deliberately small and has five responsibilities:

1. Bind work to the correct project and worktree.
2. Admit a command under an explicit capability and isolation policy.
3. Persist bounded evidence for what ran, what changed, and what was observed.
4. Continue a user-authorized objective within a finite budget.
5. Reconcile an interrupted operation before retrying or claiming success.

Language semantics, package-manager behavior, test selection, hosting policy,
and release conventions remain project-owned. They enter Tenon as a profile,
Skill, repository instruction, or existing CLI. Tenon does not abstract them
until two materially different projects demonstrate the same failure and the
same required invariant.

This is the scope firewall for every future plan:

| Proposed addition | It belongs in Tenon core only if... | Otherwise... |
|---|---|---|
| New model-facing tool | Existing file/Bash/Tool Task paths cannot provide reliable ownership, cancellation, recovery, or security, and an experiment proves the gap | Use a Skill over an existing CLI |
| New state store | No current Thread, Turn, Goal, Tool Task, or evidence record can own the fact without ambiguity | Extend the existing record or projection |
| New abstraction | Two projects need the same invariant with different implementations | Keep it in the project profile or Skill |
| New automation | The user explicitly starts it, it has a finite budget, and every stop path is durable | Keep it as a one-shot command |
| New provider prompt text | It states a cross-project invariant or explains the effective tool contract | Inject typed project evidence or Skill instructions |

The plan is successful only when the same five responsibilities work for Tenon
and a second project with a different toolchain. Supporting more commands or
providers without preserving those responsibilities is not progress.

### Architecture acceptance test

For each proposed feature, the author must answer these questions before
implementation:

```text
What user-visible failure exists without it?
Which of the five Host responsibilities owns the fix?
What single durable record proves the result?
What experiment or rejection test proves that a smaller existing path fails?
Which reference project supplied evidence, and which of its powers are
intentionally excluded?
```

If the first answer is only “the reference project has this feature”, the
feature is rejected. If the last two answers are missing, the proposal is
research, not an implementation plan.

### Kill criteria

The workbench is not considered general because it accepts more commands. Stop
or redesign the effort when any of these tests fails:

- A second project needs project-specific branches in Host code instead of a
  profile, Skill, or repository CLI.
- A Skill, profile, hook, or provider prompt can expand capability, approve a
  mutation, or claim an effect without a Host receipt.
- The same fact acquires two competing ledgers, or a projection is treated as
  the source of truth.
- A restart, timeout, or lost provider response cannot distinguish “unknown”
  from “succeeded” without rerunning a side effect.
- A self-iteration run has no finite budget, durable stop reason, or explicit
  user start.
- A native capability is retained after the smaller existing path passes the
  ownership, cancellation, recovery, and security experiment.

These are product kill criteria, not implementation preferences. Passing more
feature checkboxes cannot compensate for violating one of them.

## Research conclusions

The comparison covers `.research-repos/codex-latest`, `.research-repos/cc-2.1`,
`.research-repos/claude-code`, and `.research-repos/pi-mono`.

| Concern | Codex CLI | Claude Code / cc-2.1 | Pi coding agent | Tenon decision |
|---|---|---|---|---|
| Primary abstraction | Typed runtime: Thread, Turn, environment, process, WorldState | Interactive conversation with layered memory, commands, Skills, plugins, hooks | Minimal AgentSession with extension-driven behavior | Use typed Host runtime; keep procedures extensible |
| Instructions | Scoped `AGENTS.md`, typed snapshot, replacement/removal diff | Layered `CLAUDE.md`/rules and cached context | Ancestor instruction files concatenated into prompt; `/reload` | Use scoped, provenance-bearing snapshots with generations |
| Context update | Per-step WorldState fragments | Cached system context plus reminders | Prompt rebuild on reload; context extensions can rewrite messages | Typed `executionContext` evidence projected as system-reminder |
| Default tools | `exec_command`, `write_stdin`, `apply_patch`, controls | File tools, Bash, Agent, TaskOutput, MCP/plugins | `read`, `write`, `edit`, `bash` | Keep existing Tenon tools; add no duplicate authority |
| Process model | One manager owns identity, PTY, output, sandbox, approval, cancellation | `LocalShellTask`; output files; `tmux` for interactive work | Direct child process with timeout/abort and bounded output | Reuse Tool Tasks; measure `tmux` before native sessions |
| Sandbox | Execution policy integrated with process spawn | Real optional `sandbox-runtime` using Seatbelt/bubblewrap/seccomp | Optional sandbox extension; core is unsandboxed | Host execution sandbox with explicit enforcement status |
| Mutation | Structured patch and exec share approval/hooks | Tools plus permission checks/hooks | Extensions can rewrite tool input without revalidation | Core command/capability admission remains the only mutation authority |
| Sessions | Rollout/history plus typed environment snapshots | Session files, task outputs, fork/resume | Append-only JSONL tree, branch/fork/clone, compaction | Keep canonical Items and receipts; adopt tree exploration |
| Extensibility | Skills, slash commands, app-server | Skills, plugins, commands, hooks, MCP | TypeScript extensions, Skills, packages, RPC/SDK | Skills and hooks may extend procedure, never Host authority |
| Self-iteration | Bounded continuation and rollout controls | Stop hooks, background agents, workflow plugins | Packages/extensions implement loops | Goal-linked loop with budget, evidence, and stop reason |

These projects do not converge on one implementation because they optimize
different boundaries. Codex controls a multi-client execution runtime; Claude
Code controls a compatible CLI workflow; Pi minimizes the trusted kernel and
lets extensions carry product policy. Tenon should converge on their semantic
seams, not copy an internal architecture:

1. One Host authority seam for capability and mutation.
2. One typed context seam for project and world-state evidence.
3. One procedure seam for Skills, profiles, and project CLIs.
4. One execution seam for process identity, output, sandbox, and recovery.
5. One recovery seam for Thread/Turn/Item, Tool Tasks, Goals, and Subagents.

## Design

### Project, workspace, and execution context

Every development Thread has one default workspace reference. It may reference
a Project workspace or a managed workspace. A Tool Task may capture an external
execution context outside that default workspace:

```text
optional primary canonical root + worktree identity + VCS/branch facts
scoped instruction sources + active project profile + active Skills
declared checks + refresh generation + degradation reasons
default workspace reference and per-task execution contexts
```

Detection may propose an external execution context or profile, but never
silently creates or changes a primary Project. A missing primary root, changed
worktree, or ambiguous repository blocks the affected mutation until the
developer selects or confirms the context. An external execution context is
admitted only for the requested task and is recorded separately from the
primary Project.

The Host records each instruction and profile source with path, scope, content
hash, provenance, and capture generation. Profiles declare commands and
selection rules; they are not execution or permission authorities. Git and
non-Git roots are both valid. A root without a profile can still use generic
file, Bash, and Skill workflows with checks marked user-selected.

The typed `executionContext` payload is canonical context evidence. It contains
root/worktree identity, VCS facts when available, instruction sources, profile
identity, declared checks, generation, capture time, and degradation reasons.
It is immutable once admitted. Refresh appends a new generation and never edits
a prior Turn or transcript.

### Context injection

The existing `system-reminder` mechanism remains the provider-facing wire
format. It is not a second authority or history store.

```text
project files / Git / profile / Skill
  -> typed executionContext payload
  -> persisted context evidence
  -> ContextProjector diff, replacement, or revocation
  -> system-reminder context envelope
  -> provider input
```

Before each root Turn, the Host performs a cheap identity check and admits the
current generation alongside `turnEnvironment`, Skill evidence, and user-view
evidence. Compaction and replay retain the exact generation used by the original
Turn; they never substitute a later snapshot.

The stable prompt has three layers:

- **L0:** Tenon security, capability, persistence, process-boundary, and
  truthfulness invariants.
- **L1:** Guidance for using the effective tool catalog, project context, Skills,
  and Tool Task evidence.
- **L2:** Root persona or child role identity.

Project paths, branch rules, package commands, check matrices, and hosting
procedures stay in project context and Skills. Changing them must not change
stable-prompt fingerprints.

### System prompt and Skill boundary

Precedence is:

1. Host security, capability, persistence, and process rules.
2. Explicit user intent and constraints.
3. Host-labelled repository context and repository instructions.
4. The selected Skill's procedure.
5. Files, command output, and prior transcript as untrusted evidence.

The system prompt teaches this once. A Skill may describe how to inspect a
project, run checks, review a diff, or prepare a hosting handoff. It must declare
expected evidence and unavailable-command behavior. It cannot widen a
capability ceiling, approve a destructive action, or turn output into authority.

### Tool and workflow policy

For every proposed capability, use this order:

1. Existing file tools, Bash, Tool Tasks, Goals, plans, Subagents, Worktrees,
   and capability contracts.
2. A Skill invoking an existing project CLI through Bash.
3. A repository script/CLI when deterministic output is needed.
4. A native Tenon capability only after a focused experiment records a
   reproducible reliability, ownership, cancellation, recovery, or security gap.

There is no parallel Git or check ledger, no model-facing sandbox tool, no
native persistent terminal before the `tmux` experiment, and no semantic
navigation adapter before a measured failure corpus. A standalone CLI is also
deferred until a real CI or parent-process use case is demonstrated.

### Execution sandbox

Sandbox terminology stays precise:

| Layer | Meaning in Tenon |
|---|---|
| Electron sandbox | Renderer process boundary; not Agent command isolation |
| Capability/read-only policy | Host admission decision; not OS process isolation |
| Worktree | Git/storage boundary; not network or host-account isolation |
| Agent execution sandbox | OS filesystem/network restrictions applied before spawn |

Tenon currently has Electron isolation, capability/read-only admission, and a
macOS `sandbox-exec` write boundary for selected built-in isolated shell paths.
That boundary is an internal implementation detail, not a user-selectable
permission mode and not a general Agent filesystem sandbox. Ordinary Full
Access Bash remains host-account execution. Unit D records this baseline and
tests its enforcement; it does not claim a new sandbox product capability.

The target is an internal `AgentExecutionSandbox` contract resolved before each
eligible Tool Task. Its receipt records platform/backend, filesystem roots,
network mode, dependency result, requested isolation policy, and enforcement
state. The
state is one of `sandboxed`, `unsandboxed`, `unavailable`, or `rejected`.

A requested isolation mode fails closed when its backend or dependencies are
unavailable. Linux and Windows are separate measurements; no platform is called
portable until its enforcement and failure behavior are proven. Network
restrictions are added only when denied hosts, allowed hosts, failure, and
cleanup are observable and failed initialization cannot become unrestricted
egress.

### Verification and self-iteration

The project profile declares check commands and whether each is required or
optional. Existing Tool Tasks run them and retain bounded output, exit state,
and worktree identity. A verification report projects those facts; it is not a
second runner.

A self-iteration run is a durable Goal-linked record containing request, context
generation, worktree identity, check set, iteration/token budget, attempted
changes, and stop reason. It may inspect a failure and make another scoped edit,
but stops when required checks pass, the user stops it, the budget is exhausted,
or a blocking failure/unavailable prerequisite occurs. It never commits, pushes,
or opens a PR implicitly.

### Review and publication

The review Skill uses `git status --short`, `git diff`, selected project checks,
and the hosting CLI through existing Bash/Tool Tasks. It reports staged,
unstaged, and untracked paths with check evidence from the same context and
worktree.

Commit, push, and PR creation are explicit actions. Before execution, Tenon
shows worktree, file set, remote, branch, and commit range. It records the
resulting SHA or hosting reference. An interrupted operation is retried only
after a fresh Git read.

### Interactive processes

The first implementation uses a development Skill to create a unique `tmux`
session tied to Thread and worktree, then starts, captures, sends input to,
stops, and reopens it through Bash. The experiment measures duplicate-process
risk, output loss, cancellation, restart recovery, and capability enforcement.

Only a reproducible failure justifies a native persistent-session capability. If
promoted, it uses generic `start`, `poll`, `write`, and `stop` semantics and
reuses Tool Task receipts, sandbox policy, approval, and process cleanup.

## Requirements

- **FR-1:** A development Thread persists one default workspace reference;
  Project identity, instructions, profile, and refresh generations belong to the
  referenced Project context.
- **FR-2:** Each admitted development Turn carries a content-addressed,
  provenance-bearing execution-context payload for its default workspace or an
  explicitly named external directory.
- **FR-3:** Refresh creates a new generation and preserves prior evidence;
  identity changes block mutation until explicit rebinding.
- **FR-4:** A profile and Skill define orientation, checks, worktree rules,
  review flow, and evidence requirements without granting authority.
- **FR-5:** Verification exposes running, passed, failed, stopped, and
  unavailable states and retains bounded output.
- **FR-6:** Self-iteration enforces an iteration or token budget and records a
  stop reason.
- **FR-7:** Subagents inherit parent worktree and capability ceilings and return
  inspectable evidence.
- **FR-8:** Review/publication records paths, SHA, remote, branch, and hosting
  reference when present.
- **FR-9:** Restart/retry reconciles durable facts and never replays a mutation
  by assumption.
- **FR-10:** Every Tool Task records requested isolation policy and actual
  enforcement state; requested isolation fails closed when unavailable.
- **FR-11:** Git and non-Git projects work through profiles or explicit user
  selection without universal language, package-manager, or hosting assumptions.
- **FR-12:** Every proposed native context, Git, check-run, persistent-terminal,
  or navigation tool has an experiment and admission record.

## Acceptance Criteria

- **AC-1:** Opening a Project-bound Thread shows root, worktree, branch, dirty
  state, instruction sources, profile, and check set; a projectless Thread
  remains usable without this Project surface.
- **AC-2:** A missing or changed root/worktree prevents mutation until explicit
  rebinding.
- **AC-3:** Refresh changes current facts without rewriting conversation or audit
  history.
- **AC-4:** Provider input and trajectory identify the exact context generation
  and payload reference used at Turn admission.
- **AC-5:** Required checks cannot produce overall success while unresolved or
  failed.
- **AC-6:** A bounded loop reports its stop reason and cannot publish implicitly.
- **AC-7:** Child reports include paths, commands, and evidence within parent
  capability and worktree boundaries.
- **AC-8:** Review distinguishes staged, unstaged, and untracked content.
- **AC-9:** Commit requires an explicit file set and records its SHA without
  touching unrelated dirty files.
- **AC-10:** Push/PR preview shows remote, branch, and commit range and records
  the returned reference.
- **AC-11:** Interrupted commands and Turns recover without false success or
  mutation replay.
- **AC-12:** An unavailable requested sandbox cannot silently execute as
  unrestricted Full Access; explicit Full Access is labelled as such.
- **AC-13:** Sandbox receipts expose backend, roots, network mode, dependency
  result, and enforcement state.
- **AC-14:** Host rules, repository instructions, profile, and Skill are
  distinguishable; a Skill cannot override Host authority.
- **AC-15:** Editing a project Skill changes its next invocation without changing
  stable-prompt fingerprints.
- **AC-16:** Project-specific commands and paths are absent from the global
  prompt and available through profile, Skill, or context evidence.
- **AC-17:** A projectless Chat can complete a one-off source task against an
  explicitly named external directory without creating a Project or prompting for a
  durable binding.
- **AC-18:** The same workflow completes a source change in Tenon and a second
  project with a different toolchain or hosting convention.
- **AC-19:** The `tmux` experiment reopens one owned session after restart or
  records a reproducible failed property.
- **AC-20:** No parallel Git, check, permission, or artifact authority exists
  where existing tools suffice.

## Failure and recovery

Missing roots, stale worktrees, unavailable commands, permission denials, failed
checks, stopped processes, lost provider Turns, rejected pushes, and interrupted
PR creation are explicit non-success states. Recovery begins by rereading root,
worktree, and Git facts, then resumes only the incomplete step.

Inspection-only failures may be recorded as degraded evidence and healed later.
Write and decode boundaries continue to fail closed according to existing Tenon
persistence and capability contracts.

## Delivery units

### Unit A: Project context, workspace references, and development Skill

Ship the Project catalog metadata and Workspace records, `defaultWorkspaceRef`,
projectless external-work path, profile/context record, refresh, typed
protocol/codec shape, Automation workspace snapshots, root-lineage inheritance,
the `project_bind_request` confirmation path, and one project Skill. Include the
Tenon profile and a second project fixture. The unit is complete when a source
change can be oriented and edited both from a Project Chat and from a
projectless Chat operating on an explicitly named folder, with generationed
context evidence and no parallel execution ledger.

### Unit B: Verification and bounded correction

Compose Tool Tasks, Goals, plans, Subagents, and the profile into a check report
and bounded inspect-fix-rerun loop. Include restart and incomplete-check tests.

### Unit C: Git review and hosting handoff

Ship the review/publication Skill and the smallest renderer surface needed for
diff selection, check evidence, and publication preview. Explicit commit/push/PR
actions must be auditable and retryable.

### Unit D: Interactive process and sandbox decision

Ship the `tmux` experiment and execution-sandbox receipt/status contract using
existing process and worktree paths. Measure macOS enforcement and backend
availability before proposing Linux/Windows support or native persistent
sessions.

## Verification strategy

Core tests cover context identity and generations, replacement/removal
projection, check states, budgets and stop reasons, capability inheritance,
publication idempotency, sandbox status, and restart reconciliation. Renderer
tests cover refresh, provenance, check evidence, diff selection, and blocked or
degraded states.

End-to-end verification performs a source change in Tenon and a second project,
runs declared checks, restarts during a command, resumes, inspects the diff, and
creates a local commit.

For each affected unit run `bun run typecheck`, relevant core/renderer tests,
`bun run docs:check`, and `git diff --check`. Run `bun run test:e2e` for the
complete workflow or process/restart changes. Shipped behavior updates the
relevant `docs/spec/` document in the same change.

## Deferred measurements

After Units A-C run on at least two projects, measure context refresh cost,
false-success rate, check evidence latency, and navigation failures. Unit D
also measures sandbox startup overhead, denied filesystem/network operations,
backend availability, output loss, duplicate processes, and restart recovery.

Only measured failures may promote native persistent sessions, semantic
navigation, network sandboxing, or a standalone non-interactive CLI into a new
plan.

## Open questions

- `ProjectContextService` in `src/main/agent/context/` owns collection and
  generation; Settings and Runner provide inputs but do not persist snapshots.
- Non-Git roots support inspection and verification first. Isolation and
  publication stay unavailable until a profile supplies an explicit adapter.
- The first GitHub profile uses the installed `gh` CLI's JSON output. Other
  hosting CLIs remain profile-owned and must return bounded machine-readable
  evidence.
- Self-iteration remains explicitly user-started until restart, sandbox, and
  publication evidence has passed the end-to-end fixture.

## Implementation checklist

The detailed implementation contracts are split into four plans:

- [Project context runtime](project-context-runtime.md)
- [Verification and bounded self-iteration](verification-self-iteration.md)
- [Git review and publication](git-review-publication.md)
- [Execution sandbox and interactive processes](execution-sandbox-process.md)

- Collision self-check (2026-09-06): `gh pr list` found only #638
  (`codex/settings-model-configuration`, Settings scope) besides this claim;
  no target-file overlap was found in `docs/TASKS.md` or the open PR scopes.
  References to #635, #636, and #637 are dependency coordination points, not
  overlapping claims. The current plan batch therefore reports **no overlap**.
- [ ] Land the shared `executionContext` protocol/codec shape before consumers;
      coordinate with the owners of #635, #636, and #637.
- [ ] Implement Units A-C and update the relevant specifications.
- [ ] Run and record the Unit D `tmux` and sandbox experiments.
- [ ] Fold shipped designs into `docs/spec/`, mark the board item done, and
      archive this plan only after the main-agent gate.
