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
command + required/optional + state + exit code + bounded output
startedAt + finishedAt + degradation reason
```

States are `running`, `passed`, `failed`, `stopped`, and `unavailable`.
Overall success requires every required check to be `passed`; optional failures
and unresolved checks remain visible.

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
canonical worktree claim as ordinary Tool Tasks. A collision returns
`worktree_busy` and an isolated-worktree action; it is never silently queued
behind another mutator.

Every check and edit has its own immutable execution address and context
snapshot. A projectless Goal may use several directories in one conversation.

### Loop and stop rules

```text
inspect -> edit -> check -> inspect failure -> bounded correction -> rerun
```

The loop stops when required checks pass, the user stops it, the iteration or
token budget is exhausted, an equivalent failure repeats, a prerequisite is
unavailable, or Host admission fails. Stop reason and all evidence remain
durable.

### Recovery

On restart, reconcile unfinished Tool Tasks first. Missing terminal evidence is
`lost` or `stopped`, never passed. Rebuild the Goal from immutable attempts and
resume only the missing inspection/check step. Never replay an edit because a
provider response was lost.

## Requirements

- **FR-1:** Every check has durable state, bounded output, address, snapshot,
  and Tool Task identity.
- **FR-2:** Every correction attempt has a finite budget and stop reason.
- **FR-3:** Required-check aggregation cannot report success with unresolved or
  failed required checks.
- **FR-4:** Worktree claims serialize mutations and reconcile after restart.
- **FR-5:** No check-run or execution authority is added beside Tool Tasks.

## Acceptance criteria

- **AC-1:** A required failed or unresolved check prevents overall success.
- **AC-2:** One Turn using multiple directories records each check's address and
  context reference independently.
- **AC-3:** Equivalent repeated failures stop before the entire budget is used.
- **AC-4:** Restart never converts missing exit evidence into success or repeats
  a mutation by assumption.
- **AC-5:** Child/delegated checks inherit capability ceilings but receive their
  own validated execution context references.
- **AC-6:** The loop reports checks, changed paths, budget use, and stop reason
  without implicit publication.

## Tests and evidence

Cover every check state, required/optional aggregation, multiple cwd values,
worktree collision, repeated failure, budget exhaustion, child inheritance, and
restart recovery. Add an end-to-end fixture that edits one file, fails a check,
corrects it, and stops on success.

## Open questions

- Profiles initially run checks sequentially unless independence is explicit.
- Resuming a user-stopped Goal starts a new attempt after context and worktree
  reconciliation.
