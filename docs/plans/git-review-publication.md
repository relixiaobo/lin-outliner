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

The same review snapshot captures a mandatory Git baseline directly from Git:
canonical worktree and shared Git directory, exact HEAD commit OID, and HEAD
attachment (`symbolic` with full ref such as `refs/heads/feature`, or `detached`
with its OID). An unborn branch records its symbolic ref and explicit absent
HEAD state. Resolve these through ordinary Git CLI queries such as
`rev-parse --verify HEAD`, `symbolic-ref -q HEAD`, and worktree/common-directory
inspection; distinguish expected detached/unborn results from command failure.
Missing or inconsistent baseline evidence makes commit unavailable. A pending
or degraded ContextSnapshot's optional Git observations cannot supply it.

Capture the baseline before and after path/index inspection and accept the
snapshot only if both agree. Record the selected index entries/stages and
working-tree digests with it. The snapshot describes one observed review state,
not whichever branch happens to be selected when publication later runs.

### Explicit commit

Commit input contains an explicit path set, message, and review snapshot ref.
Host acquires the admitted worktree scope claim, then independently reads the
mandatory Git baseline and recomputes the reviewed path/index state before
execution. A HEAD OID, symbolic ref, detached/unborn state, worktree identity,
path, size, file-kind, or digest mismatch rejects the commit and requires a
refreshed review. Switching branches at the same OID must fail even if the
selected files and diffs are identical. This applies to untracked, renamed,
deleted, and binary files as well as normal tracked diffs. Unrelated dirty files remain
untouched.

Keep the claim through settlement and revalidate immediately before the Git
mutation after any preparation step. The claim coordinates Tenon-admitted
scopes; it cannot lock out an external editor, arbitrary shell, or other Git
client. Use Git's own index/ref concurrency checks and verify the resulting
commit's parent and ref against the admitted baseline. A concurrent baseline
change or uncertain Git result is non-success pending reconciliation, never an
automatic retry, reset, or assertion that the intended branch was published.
No claim is made that the address lease alone supplies a Git transaction.

The receipt records commit SHA, parent SHA, branch, worktree identity,
execution address, context reference, selected paths, and result.

### Model context

Review uses the shared
[Execution Context Publication](../spec/agent-model-runtime.md#execution-context-publication)
contract. A new diff or baseline mismatch appends new evidence and a bounded
explanation of what must be reviewed again. Neither an old diff nor an earlier
reviewed-state statement is replaced in a previously sent provider message.
Full path/index manifests remain evidence resources; frozen bounded tool output
and relevant changes supply model context without repeating complete Git state
or Skill instructions at each publication step.

Compaction preserves the exact review references and their known applicability,
but a restored review summary cannot authorize commit. The Host still performs
the mandatory live baseline/content checks above. A plain read or diff remains
available without a review-state mutation or new context-management tool.

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
- **FR-2:** Commit requires explicit paths and a matching reviewed snapshot,
  including mandatory HEAD/ref/attachment and index state independent of discovery.
- **FR-3:** Untracked and binary content is digest-verified before commit.
- **FR-4:** Publication records durable result evidence and reconciles uncertainty.
- **FR-5:** No Git or hosting ledger is added beside Git and Tool Task evidence.
- **FR-6:** Review refresh and publication outcomes append through the common
  context contract; compaction cannot replace live commit validation.

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
- **AC-7:** Switching to another branch at the same HEAD with identical selected
  contents/diffs rejects commit admission. A changed HEAD, detached/unborn
  transition, or changed worktree registration also requires renewed review.
- **AC-8:** Missing Git baseline observations refuse commit even if optional
  context discovery is pending or reports a plausible branch name. Concurrent
  Git state changes during execution produce truthful reconciliation evidence.
- **AC-9:** A changed diff/HEAD/ref appends new provider evidence without
  rewriting an earlier review. After compaction or restart, a historical
  review summary cannot bypass current baseline validation.

## Tests and evidence

Use a temporary Git repository with unrelated dirty files, staged/untracked,
renamed/deleted, binary paths, a local remote, and interrupted publication.
Add renderer tests for path selection and preview, plus a non-Git fixture where
review works and publication is unavailable.
Include two branches at the same OID with identical dirty changes, movement to
a new HEAD with the same tree, detached and unborn HEAD cases, failed baseline
queries, and a branch change between review and commit. Assert no commit is
started on an admission mismatch and no automatic retry follows uncertain Git
settlement.
Capture before/after provider requests for a review refresh and a compacted
continuation, checking frozen earlier diffs and explicit renewed review needs.

## Open questions

- The first GitHub profile standardizes on bounded `gh` JSON output.
- A reviewed-state mismatch always requires a new review; it is never implicitly
  refreshed.
- Non-Git publication remains deferred until a deterministic adapter exists.

### Implementation binding

- A built-in `git-review` Skill drives a strict standalone Bash command:
  `git-review <capture|commit|preview|push|create-pr> --input - --output json`.
  Literal JSON stdin supplies paths, messages, or immutable evidence references.
  Ordinary shell Git commands remain available. The Host prepares a bundled
  Node helper inside the existing admitted Tool Task; Git and `gh` remain the
  actual executors, and the canonical Task receipt owns process settlement.
- Full bounded manifests use the existing context payload store. Bounded
  observations publish through Execution Context Publication, with dependency
  references retained through compaction. No separate Git database is added.
- Selected-file commits build a temporary Git index, preserve unrelated real
  index entries, and use an index lock plus a ref transaction that verifies HEAD
  attachment and its expected OID. Git plumbing creates the exact reviewed tree;
  repository commit hooks are not run by this workflow. Signing follows Git's
  `commit.gpgSign` setting. Ordinary Bash remains available for custom workflows.
- The tool result offers unchecked path selection and a copyable explicit
  commit request, plus a publication preview. Publication is requested through
  the existing composer and Skill; rendering historical evidence never executes
  an operation. Every remote attempt first reconciles the exact remote ref or
  GitHub head/base. Unsupported or ambiguous hosting configurations fail closed.
- Scope: new Git review domain/helper/Skill and renderer result component;
  Bash admission, capability classification, ToolRuntime, context payload codecs,
  publication/dependency projection, focused tests, and current-behavior specs.
  Collision check against open PR #656: only the agent-model-runtime spec is
  shared, in separate sections; no Settings implementation or infrastructure
  ownership files are needed. Main retains board/changelog/archive ownership.
- Risks: external non-cooperating writes, process loss between Git ref/index
  updates, bounded evidence overflow, and uncertain provider replies. These
  produce explicit non-success/reconciliation evidence, never automatic commit
  retries, reset, force push, or merge.
