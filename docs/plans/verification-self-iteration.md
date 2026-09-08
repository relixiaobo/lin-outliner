# Verification And Bounded Self-Iteration

**Shape:** One complete feature. It composes Tool Tasks, Goals, Skills, and
project check declarations into a factual, bounded correction workflow under
the [Agent Capability-First Development Workbench](project-development-workbench.md).

## Goal

Let the Agent inspect a failure, edit files, run declared checks, correct the
result, and stop with a factual outcome without requiring a Project and without
publishing implicitly.

## Non-goals

- A second check runner or result ledger.
- An unrestricted autonomous loop.
- A new Agent, target, workspace, or permission mechanism.
- Silent commit, push, merge, or PR creation.

## Design

### Integration with the existing execution surface

An explicitly requested Goal may opt into verification with canonical directory
roots and a finite attempt limit. Ordinary Goals remain unchanged. The Host
resolves the enclosing `.tenon/checks.json` declarations for those roots using
the shipped discovery mechanism. The Agent runs their exact commands through
ordinary Bash; a matching command and canonical cwd identifies a declared check.
Every other process in that workflow is unclassified and invalidates the
current revision before admission, including native/delegated producers. Typed
mutations invalidate every overlapping workflow before their side effects.

Goal storage owns immutable attempt/revision metadata and references to source
evidence and Tool Tasks. Tool Tasks remain the only owners of process state,
exit receipts, output and address claims. Full source manifests use the existing
context-payload store. The existing execution-context publication and dependency
graph carry bounded applicability facts and retain the full evidence through
compaction and restart. Goal inspection exposes the current check list, factual
outcomes, applicability, attempts and stop reason; Goal completion revalidates
the aggregate before accepting success.

The first declared check after a known mutation or source/profile change starts
a fresh bounded attempt. Repeating an already settled check also starts a new
attempt, so it cannot refresh one pass while retaining the other old passes.
Read-only checks initially run sequentially. Missing profiles, capture failure,
repeated equivalent failure, exhausted attempts, user stop and context-capacity
failure stop automatic continuation in the existing Goal owner. A later user
resume requires renewed admission and source validation. No edit is replayed by
the verification mechanism.

The implementation touches Agent Goal and context DTOs/codecs/tool contracts,
`GoalStore`, `GoalExtension`, `ToolTaskService`, `ThreadService`, `ToolRuntime`,
context publication/dependency/projection consumers, the built-in verification
guidance, and their focused tests/specifications. It does not change the core
document command protocol, dependency/build configuration, or startup-recovery
ownership. Runtime invariants on inspection paths report unavailable evidence;
write/decode boundaries continue to reject malformed state.

### Check result

Each check is one Tool Task and records:

```text
verificationRunId + checkId + toolTaskId
executionAddress + contextSnapshotRef + worktree identity
sourceStateRef + verificationRevision + checkDefinitionDigest
command + required/optional + state + exit code + bounded output
startedAt + finishedAt + degradation reason
```

States are `running`, `passed`, `failed`, `stopped`, `lost`, and `unavailable`.
`lost` is terminal evidence that the Tool Task had no verified terminal receipt
after reconciliation; it is never converted to `passed`. Overall success
requires every required check to be `passed`; `running`, `failed`, `stopped`,
`lost`, and `unavailable` required checks are non-success. Optional failures,
loss, and unresolved checks remain visible. Process outcome and applicability
are separate: a historical `passed` receipt remains true as a past result, but
only a result that is `current` for the selected source state can aggregate.
Applicability is `current | stale | unavailable`, derived from canonical state
evidence; it is not a rewritten Tool Task outcome.
If no required-check definition has been resolved, report verification as
unavailable or not configured; an empty or pending discovery snapshot cannot
produce vacuous overall success.

### Source state and invalidation

`sourceStateRef` references an immutable manifest in the existing evidence
store. It includes canonical root/worktree identities, Git HEAD and branch/ref
when present, sorted relative paths, file kinds/modes, byte lengths and content
digests, missing/deleted entries, and the capture interval. Tracked content,
index state, and untracked source files all count; HEAD alone or `git diff`
alone cannot prove a working tree version. Non-Git projects use the same file
manifest without Git fields. A profile's input-scope and exclusion declarations
are hashed with the check commands and required/optional set.

The initial policy is conservative: one verification revision covers the whole
declared source scope of an attempt, including every participating repository.
There is no inferred per-check dependency graph. A mutation to any included
source invalidates every prior check in that revision, including previously
passed checks. Adding/removing a required check or changing its command, input
scope, toolchain declaration, or profile also invalidates the results. An edit
to an unrelated directory outside the declared scope does not prove anything
about, or automatically become part of, this verification.

By default include all source entries beneath those roots, including ignored
files; only Host Git administration internals are structurally excluded.
Generated output, caches, dependencies, or mounted/external inputs require an
explicit, recorded profile scope decision. Exclusions limit the claim: a check
that depends on an excluded or unmeasured input cannot report source-complete
verification. Files reached through symlinks are recorded with target identity
and content; external targets must be included explicitly or marked unavailable.
Cycles, unreadable files, concurrent changes, and capture-budget exhaustion
produce unavailable evidence rather than a partial fingerprint presented as
complete. Secret-bearing inputs need only a digest, not persisted content.

At attempt admission, capture the baseline manifest and allocate a durable
`verificationRevision`. Capture again before/after each check and before
aggregation. A passing process result is current only when those manifests
match the baseline, its definition digest matches, and no known intervening
mutation invalidated the revision. Admitted typed writes invalidate applicable
revisions before side effects. During an active verification workflow, any
mutating or unclassified non-check Bash/native task initiated by that workflow
invalidates the revision conservatively, even when its cwd names another
directory. A declared check is measured by its before/after manifests; any
observed source mutation within that check also invalidates the revision.
Write-then-restore does not revive a revision invalidated by an observed task.
File watchers may invalidate early but are never proof of unchanged content.

This is evidence about an observed source state, not proof against invisible
external write-and-restore races during a check or changes in unmeasured remote
services. Address claims do not provide that stronger isolation. The result
records its scope and capture times; a strict stable-input requirement needs a
separately enforced immutable/isolated input environment.

After correction, create a new revision from a fresh manifest and rerun **all
required checks**. Example: A passes and B fails at revision R0; fixing B creates
R1 and makes both R0 results stale. Passing only B at R1 cannot produce overall
success until A also passes at R1. Checks that generate included source changes
invalidate their own revision; a profile should separate generation before the
verification baseline or explicitly exclude outputs proven not to be inputs.
Do not silently fingerprint only selected edited files to keep earlier passes.

### Correction attempt

Each attempt records parent failure evidence, changed paths, checks rerun,
budget consumed, result, and stop classification. The Agent edits only through
ordinary Host-admitted tools. A Goal cannot widen capabilities, change an
execution address silently, or publish.

Repeated-failure detection compares normalized check identity, exit state,
stable diagnostic fingerprint, and Host error code. It does not rely on model
prose or timestamps.

### Scheduling and concurrency

Independent read-only checks may run in parallel when a profile declares them
safe. Mutating work and checks that depend on generated files use the same
admitted-scope claim as ordinary Tool Tasks. A collision returns
`worktree_busy` and an isolated-worktree action; it is never silently queued
behind another claimant. These claims coordinate known scopes; an arbitrary
shell writing outside its cwd or an external editor is outside their coverage.
Manifest validation and conservative invalidation still apply to every check.

Every check and edit has its own immutable execution address and context
snapshot. A projectless Goal may use several directories in one conversation.

### Model context and budgets

Use the shared
[Execution Context Publication](../spec/agent-model-runtime.md#execution-context-publication)
contract. A check's canonical call/result is its outcome evidence. Publish new
applicability or required-check changes as scoped deltas; do not rewrite a
historical `passed` result to `stale` inside an earlier model request. Repeated
check outcomes remain distinct events even when their exit codes match.

Full manifests and complete output remain evidence resources. Model input
contains the relevant revision relationship, failed checks, bounded diagnostics,
and commands needed next, without repeating complete source manifests or the
unchanged project instructions at every check. Use existing result/projection
ownership; no second check summary feed or prompt overlay is added.

Compaction checkpoints preserve the revision/invalidation facts needed for
continuation, with exact evidence references. Restoration alone never makes a
stored pass current: aggregation and resume still perform the validation above.
Iteration/token limits and the provider's context capacity are separate bounds.
The existing planner cannot compact an active Turn. Bound correction attempts;
use existing Goal continuation after a Turn settles when permitted. Capacity
failure records a concrete stop reason and remaining work, never an automatic
reset, replay of edits, or unlimited retry of the same oversized input. A later
continuation revalidates source state and resumes only uncompleted work.

### Loop and stop rules

```text
inspect -> edit -> check -> inspect failure -> bounded correction -> rerun
```

The loop stops when all required checks are current and pass for one source
revision, the user stops it, the iteration or token budget is exhausted,
an equivalent failure repeats, a prerequisite is
unavailable, context capacity is exhausted, or Host admission fails. Stop reason
and all evidence remain durable. A capacity stop also records continuation
ineligibility in the existing Goal owner before idle notification; restart
cannot admit the unchanged attempt merely because the Goal is unfinished.
Resume requires a new admissible context/attempt under the recovery rules.

### Recovery

On restart, reconcile unfinished Tool Tasks first. Missing terminal evidence is
`lost` or `stopped`, never passed. Rebuild the Goal from immutable attempts and
recompute its source manifest before reusing any pass. Retain prior passes only
if the manifest/definitions match and the revision has no invalidation or
ambiguous mutation since capture. Otherwise mark applicability stale or
unavailable and start a fresh revision with every required check outstanding.
If the same revision is still valid, resume only its missing checks. Recovery
cannot infer validity from worktree identity or context snapshot alone. Never
replay an edit because a provider response was lost. Before later presenting a
stored result as current, revalidate; otherwise show it as historical evidence.

## Requirements

- **FR-1:** Every check has durable state, bounded output, address, snapshot,
  and Tool Task identity.
- **FR-2:** Every correction attempt has a finite budget and stop reason.
- **FR-3:** Required-check aggregation requires passed, current results for
  one matching source revision and definition set; stale results never count.
- **FR-4:** Address claims coordinate admitted scopes and reconcile after
  restart; they do not attest to all shell or external writes.
- **FR-5:** No check-run or execution authority is added beside Tool Tasks.
- **FR-6:** Check outcomes and applicability changes use the common publication,
  compaction, and context-budget contract without altering historical results.

## Acceptance criteria

- **AC-1:** A required failed, unresolved, stale, or unavailable check prevents
  overall success, even if its historical process receipt says passed.
- **AC-2:** One Turn using multiple directories records each check's address and
  context reference independently.
- **AC-3:** Equivalent repeated failures stop before the entire budget is used.
- **AC-4:** Restart never converts missing exit evidence into success or repeats
  a mutation by assumption.
- **AC-5:** Child/delegated checks inherit capability ceilings but receive their
  own validated execution context references.
- **AC-6:** The loop reports checks, changed paths, budget use, and stop reason
  without implicit publication.
- **AC-7:** A passes and B fails at R0; correcting B invalidates A. Passing
  only B at R1 cannot aggregate as success, including after restart.
- **AC-8:** Modified tracked/untracked source, deletion, binary changes, HEAD
  changes, or check-definition changes make old results stale. Missing or
  over-budget capture is unavailable, never an empty successful manifest.
- **AC-9:** An observed write followed by restoration still invalidates its
  revision; an unclassified shell task in the workflow cannot avoid this by
  supplying a different cwd. Out-of-scope inputs remain explicit limitations.
- **AC-10:** A-pass/B-fail/correction preserves earlier provider prefixes while
  appending R0 invalidation and R1 outcomes. Compaction/resume cannot count R0
  passes or repeat manifest/instruction bodies as every check's context.
- **AC-11:** Active-Turn capacity exhaustion stops truthfully. An admitted later
  Goal continuation revalidates evidence, resumes missing work, and does not
  replay settled edits or repeatedly submit the unchanged oversized request.

## Tests and evidence

Cover every check state, required/optional aggregation, multiple cwd values,
worktree collision, repeated failure, budget exhaustion, child inheritance, and
restart recovery. Add an end-to-end fixture that edits one file, fails a check,
corrects it, and stops on success, plus a restart fixture that maps a lost Tool
Task to a lost Check Result and blocks aggregation.
Add the A-pass/B-fail/correction/B-pass fixture both live and across restart;
verify A must rerun. Cover source/profile changes while checks run, unavailable
fingerprints, ignored-input exclusions, generated outputs, same-content
write/restore with a known mutation, and changed HEAD with unchanged files.
Capture actual provider inputs through correction, compaction, and Goal
continuation. Assert prefix preservation for ordinary deltas, scoped restore,
bounded manifest projection, and the capacity-stop/no-replay behavior.

## Open questions

- Profiles initially run checks sequentially unless independence is explicit.
- Resuming a user-stopped Goal starts a new attempt after context and worktree
  reconciliation.
