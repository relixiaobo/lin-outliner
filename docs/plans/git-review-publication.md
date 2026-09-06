# Git Review And Publication

**Shape:** One complete feature. It provides auditable review and explicit
publication over Git and hosting CLIs without creating a Git ledger under the
[Agent Capability-First Development Workbench](project-development-workbench.md).

## Goal

Let a developer inspect the exact changes produced in one or more Tool Task
execution addresses, select an explicit file set, and commit, push, or create
a PR with durable evidence and safe retry behavior.

## Non-goals

- A native Git implementation or parallel Git state store.
- Automatic merge, force-push, or publication.
- Treating a hosting CLI response as authoritative without evidence.

## Design

### Review snapshot

The review Skill uses existing Bash/Tool Tasks:

```text
git status --short
git diff --stat
git diff [selected paths]
git diff --cached [selected paths]
```

The snapshot records the execution address, context snapshot, worktree
identity, and each staged, unstaged, untracked, renamed, deleted, and binary
path. Every path record contains canonical path, file kind, byte size, and a
content/diff digest. Untracked files are not silently included in a commit.

### Explicit commit

Commit input contains an explicit path set and message. Host acquires the
canonical worktree mutation claim and recomputes the reviewed snapshot before
execution. A path, size, file-kind, or digest mismatch rejects the commit and
requires a refreshed review. This applies to untracked, renamed, deleted, and
binary files as well as normal tracked diffs. Unrelated dirty files remain
untouched.

The receipt records commit SHA, parent SHA, branch, worktree identity,
execution address, context reference, selected paths, and result.

### Remote publication

Before push or PR creation, show and record remote URL/name, branch, local HEAD,
upstream state, commit range, PR base/head, and hosting provider. After an
uncertain push, query the remote branch before retrying. After an uncertain PR
creation, query by head/base before creating another PR. A discovered remote
ref or PR becomes result evidence, not a duplicate operation.

The Skill may use `gh` or a profile-selected hosting CLI. Output is bounded and
redacted before persistence. A hosting failure never authorizes fallback or
force-push.

### Non-Git roots

Non-Git review supports bounded file diffs and checks. Commit, push, and PR are
unavailable unless a profile supplies a deterministic publication adapter.

## Requirements

- **FR-1:** Review records path state, execution address, context, and worktree.
- **FR-2:** Commit requires explicit paths and a matching reviewed snapshot.
- **FR-3:** Untracked and binary content is digest-verified before commit.
- **FR-4:** Publication records durable result evidence and reconciles uncertainty.
- **FR-5:** No Git or hosting ledger is added beside Git and Tool Task evidence.

## Acceptance criteria

- **AC-1:** Review distinguishes staged, unstaged, untracked, renamed, deleted,
  and binary content.
- **AC-2:** A multi-directory Turn keeps each review snapshot tied to its own
  execution address and context reference.
- **AC-3:** Modifying any reviewed untracked or binary file causes commit
  admission to fail until review is refreshed.
- **AC-4:** Explicit commit records SHA and leaves unrelated dirty files intact.
- **AC-5:** Push/PR preview shows remote, branch, and commit range.
- **AC-6:** Uncertain remote operations reconcile before retry and never
  duplicate effects.

## Tests and evidence

Use a temporary Git repository with unrelated dirty files, staged/untracked,
renamed/deleted, binary paths, a local remote, and interrupted publication.
Add renderer tests for path selection and preview, plus a non-Git fixture where
review works and publication is unavailable.

## Open questions

- The first GitHub profile standardizes on bounded `gh` JSON output.
- A reviewed-state mismatch always requires a new review; it is never implicitly
  refreshed.
- Non-Git publication remains deferred until a deterministic adapter exists.
