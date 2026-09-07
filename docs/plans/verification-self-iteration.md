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

### Loop and stop rules

```text
inspect -> edit -> check -> inspect failure -> bounded correction -> rerun
```

The loop stops when all required checks are current and pass for one source
revision, the user stops it, the iteration or token budget is exhausted,
an equivalent failure repeats, a prerequisite is
unavailable, or Host admission fails. Stop reason and all evidence remain
durable.

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

## Open questions

- Profiles initially run checks sequentially unless independence is explicit.
- Resuming a user-stopped Goal starts a new attempt after context and worktree
  reconciliation.
