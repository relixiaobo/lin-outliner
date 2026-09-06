# Verification And Bounded Self-Iteration

**Shape:** One complete feature. It turns project checks into factual evidence
and composes a bounded inspect-fix-rerun workflow from existing runtime pieces.

## Goal

Given a project profile, run required and optional checks through Tool Tasks,
attach their results to the same Thread/worktree/context generation, and allow a
Goal-linked Agent to make bounded corrective edits without silently publishing.

## Purpose

Define check-result and bounded-correction semantics independently from project
discovery and publication.

## Non-goals

- A second test runner or check-result store.
- An unrestricted autonomous loop or implicit publication.
- A new Agent type or permission mechanism.

## Reference implementation

| Reference | Source | Logic to study | Adaptation |
|---|---|---|---|
| Codex CLI | `codex-rs/core/src/tools/handlers/unified_exec/` | One execution lifecycle with output, cancellation, hooks, and process identity | Reuse Tenon's Tool Task lifecycle rather than adding a check runner |
| Codex CLI | `codex-rs/core/src/rollout/` and continuation controls | Durable turn history and bounded continuation | Store attempt and stop facts in Goal/Thread evidence |
| Claude Code | `src/TaskOutput.ts`, `src/utils/task/LocalShellTask.ts` | Background task output, notifications, and bounded task retrieval | Map command states to Tool Task receipts; do not copy a second task store |
| Claude Code | `src/utils/hooks.ts` Stop/FileChanged hooks | Lifecycle-triggered continuation and file-change reactions | Use Host hooks only for refresh/reconcile; keep iteration policy in Goal/Skill |
| Pi | `packages/coding-agent/src/core/bash-executor.ts` | Abortable child process, timeout, bounded output, full-output temp file | Use existing Tenon bounded output and durable task details |
| Pi | `packages/coding-agent/src/core/compaction/compaction.ts` | Token budget, cut points, and structured compaction details | Retain iteration evidence across compaction; do not treat summary as execution proof |
| Tenon | `src/main/agent/tasks/ToolTaskService.ts`, `ToolTaskStore.ts` | Durable task records, leases, output refs, reconciliation | The only check execution authority |
| Tenon | `GoalStore`, `update_plan`, `SubagentCollaboration` | Durable objective, plan, delegation, inherited ceilings | Compose a bounded correction loop without new Agent types |

## Design

### Check record

Each declared check produces one immutable result linked to:

```text
verificationRunId + checkId + ToolTaskId
executionContextRef (default workspace or external directory) + worktreeIdentity
contextGeneration
command + required/optional
state + exitCode + bounded output reference
startedAt + finishedAt + degradation reason
```

States are `running`, `passed`, `failed`, `stopped`, and `unavailable`. Overall
success requires every required check to be `passed`; unresolved or optional
failures remain visible.

### Iteration record

Each correction attempt records:

```text
attemptId + parentFailureEvidence
changedPaths + checksRerun
result + budget consumed + stop classification
```

The loop stops on all required checks passing, explicit user stop, iteration or
token budget exhaustion, blocking failure, unavailable prerequisite, or repeated
equivalent failure. Repeated-failure detection must compare normalized check id,
exit state, and bounded diagnostic fingerprint; it must not rely on model prose.

The Agent may edit only through existing capability-admitted tools. The Goal
cannot widen capabilities, change the worktree, commit, push, or create a PR.

### Scheduling

Use `ToolTaskService` for each check. Run independent checks in parallel only
when the project profile declares them safe and the Tool Task scheduler can
preserve resource bounds. A check that depends on generated files or a prior
check remains ordered. Every attempt re-reads the current execution context
before editing and records changed paths after editing. For a projectless Chat,
the external execution context remains scoped to the active Goal; verification never creates
a durable Project as a side effect.

Verification acquires the same worktree mutation lease as ordinary edits. A
busy worktree produces an explicit conflict and stops the Goal attempt; it does
not queue a check against a moving tree. A check result is immutable even when a
later refresh produces a new context generation, so reports distinguish
"failed under generation N" from a current rerun.

### Recovery

On restart, reconcile unfinished Tool Tasks first. A task with no durable exit
receipt is `stopped` or `lost`, never passed. Rebuild the iteration from its
immutable records and resume only the missing check or inspection step. Never
replay an edit because the provider response was lost.

## Requirements

- **FR-1:** Every declared check has durable state, bounded output, and links
  to its Tool Task, execution context, and worktree.
- **FR-2:** Every correction attempt has a budget and explicit stop reason.
- **FR-3:** Restart reconciliation never converts missing execution evidence
  into success or replays a mutation.

## Acceptance Criteria

- **AC-1:** Required checks cannot yield overall success while unresolved or failed.
- **AC-2:** Every result links to a Tool Task, execution context, and worktree identity.
- **AC-3:** Every attempt has a bounded budget and explicit stop reason.
- **AC-4:** Repeated equivalent failures stop without exhausting the whole budget.
- **AC-5:** Restart never turns a missing exit receipt into success or replays an edit.
- **AC-6:** Child explore/review/test Agents inherit capability and worktree ceilings.
- **AC-7:** No check-run ledger or new execution authority is introduced.

## Tests and evidence

Add core tests for all check states, required/optional aggregation, repeated
failure detection, budget exhaustion, child inheritance, and restart recovery.
Add a fixture where one check is unavailable and another fails. Add an end-to-end
fixture that edits one file, fails a check, corrects it, and stops on success.

## Open questions

- Repeated-failure fingerprints normalize check ID, exit state, diagnostic
  lines, and stable tool error codes; paths and timestamps are removed.
- Parallel checks are opt-in per profile and limited to read-only or explicitly
  declared independent commands; the Tenon profile starts sequentially.
- A user stop preserves a resumable Goal with `stopped-by-user`; resuming starts
  a new attempt after context and worktree reconciliation.
