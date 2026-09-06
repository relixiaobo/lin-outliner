# Git Review And Publication

**Shape:** One complete feature. It provides an auditable review and explicit
publication workflow over Git and hosting CLIs without creating a Git ledger.

## Goal

Let a developer inspect the exact changes produced by a Thread, select an
explicit file set, and commit, push, or create a PR with durable evidence and
safe retry behavior.

## Purpose

Define review and publication independently from context collection and check
orchestration.

## Non-goals

- A native Git implementation or parallel Git ledger.
- Automatic merge, force-push, or publication without explicit action.
- Treating a hosting CLI response as authoritative without recording its output.

## Reference implementation

| Reference | Source | Logic to study | Adaptation |
|---|---|---|---|
| Codex CLI | `codex-rs/core/src/tools/handlers/apply_patch.rs` and exec hooks | Structured mutation, pre/post lifecycle, and approval boundary | Keep Tenon file commands and capability admission as authority |
| Codex CLI | `codex-rs/core/src/commands/` and `codex exec` output paths | Scriptable execution and machine-readable handoff | Defer a standalone CLI; use existing Tool Task evidence first |
| Claude Code | `src/commands/review/`, `src/commands/commit/`, and bundled commit/review Skills | Git workflows expressed through shell, commands, and plugins | Implement as a Skill over Git/hosting CLIs; do not create parallel state |
| Claude Code | `src/utils/git.ts` and `src/utils/hooks.ts` | Git safety checks and hook lifecycle | Reuse facts but keep publication explicit and Host-audited |
| Pi | `packages/coding-agent/examples/extensions/git-merge-and-resolve.ts` and `docs/packages.md` | Git workflow as an extension/package with source metadata | Borrow packaging and source visibility; reject unrestricted extension authority |
| Tenon | `src/main/agent/capabilities/agentLocalTools.ts`, `ToolTaskService.ts` | Existing Bash, file mutation, task output, and capability checks | All Git commands pass through these paths |

## Design

### Review snapshot

The review Skill invokes, through Bash/Tool Tasks:

```text
git status --short
git diff --stat
git diff [selected paths]
git diff --cached [selected paths]
```

It records staged, unstaged, and untracked paths separately and associates the
review with the immutable `executionContextRef` (primary Project or task
target), context generation, and worktree identity. Untracked files are never
silently included in a commit selection.

### Explicit mutation

Commit input contains an explicit path set and message. Before execution, Host
acquires the worktree mutation lease and checks that the selected paths still
match the reviewed state or reports the state changed. The commit receipt
records SHA, parent SHA, branch, worktree, execution context, and selected paths.
Unrelated dirty files remain untouched.

### Remote publication

Before push or PR creation, show and record:

```text
remote URL + remote name + branch
local HEAD + upstream state + commit range
PR base/head and hosting provider
```

After an uncertain push, query the remote branch before retrying. After an
uncertain PR creation, query by head/base before creating another PR. A found
remote ref or PR becomes the result evidence; it is not treated as a duplicate
operation.

The Skill may support `gh` or another hosting CLI selected by the profile. Its
output is evidence and must be bounded/redacted before persistence. A hosting
CLI failure never authorizes a fallback provider or force-push.

### Non-Git roots

The first generic workflow supports non-Git review as a bounded file diff and
check report. Commit/push/PR actions are unavailable unless the profile declares
an explicit publication adapter. No fake SHA or VCS abstraction is introduced.

## Requirements

- **FR-1:** Review records staged, unstaged, and untracked paths with context
  and worktree identity.
- **FR-2:** Commit and publication require explicit targets and durable result
  evidence.
- **FR-3:** Uncertain remote operations reconcile before retry.

## Acceptance Criteria

- **AC-1:** Review distinguishes staged, unstaged, and untracked content.
- **AC-2:** Review, checks, and publication share execution-context/worktree identity.
- **AC-3:** Commit requires an explicit file set and records its SHA.
- **AC-4:** Unrelated dirty files remain unchanged.
- **AC-5:** Push/PR preview shows target remote, branch, and commit range.
- **AC-6:** Uncertain remote operations reconcile before retry and do not duplicate effects.
- **AC-7:** No Git or hosting state store is added beside Git and command evidence.

## Tests and evidence

Use a temporary Git repository with unrelated dirty files, staged and untracked
paths, a local remote, and an interrupted publication simulation. Add renderer
tests for path selection and preview. Add a non-Git fixture proving that review
works while publication is correctly unavailable.

## Open questions

- The first GitHub profile standardizes on `gh` JSON output; a profile may select
  another CLI only when it provides equivalent stable fields.
- Commit requires the reviewed diff hash and selected path set to remain
  unchanged. A mismatch produces a new review requirement rather than an
  implicit refresh.
- Non-Git publication is deferred until one real project supplies a deterministic
  adapter and a durable external-result reconciliation test.
