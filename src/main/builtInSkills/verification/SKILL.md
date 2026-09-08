---
description: Verify and correct a local coding task with declared checks, current source evidence, and a finite Goal attempt budget.
when_to_use: Use when the user explicitly asks for a bounded verify-and-correct Goal. Do not create Goals for ordinary questions, single commands, or implicit publication.
user-invocable: true
---

# Verification

1. Inspect the requested directories and their `.tenon/checks.json` declarations.
   A Project is optional. Resolve the user's acceptance criteria into required
   checks and keep optional diagnostics visible. An absent or malformed profile
   is a missing prerequisite, never a passing empty suite. Do not weaken a
   required check or exclude an input merely to obtain a pass.
2. If a profile is needed, use ordinary file tools within the authorized task.
   The profile is `{ "schemaVersion": 1, "checks": [...] }`; each declaration
   has `id`, `command`, `required`, `inputs`, and `exclude`. Commands run from the
   directory containing `.tenon`. Inputs and exclusions are relative paths or
   glob patterns; absolute inputs identify additional measured roots. For
   example, a required check may declare `inputs: ["."]` with explicit
   exclusions for generated output and caches that it does not consume.
   Ignored files are included by default. Every exclusion limits the claim.
   Do not omit dependencies or secret-bearing inputs that affect the result:
   manifests retain digests, not their contents. Unmeasured services and invisible
   external write-and-restore races remain explicit limitations.
3. Call `create_goal` only for the explicitly requested Goal. Supply
   `verification: { roots: [absoluteDirectory], maxAttempts: 3 }`, adapting the
   finite attempt limit to the request (1–20). The same limit caps automatic
   Goal continuations, including Turns that never start a check. Set `token_budget` only when the
   user explicitly requests one. Use `get_goal` to inspect an existing run.
4. Run each exact declared `command` through ordinary `Bash` at its canonical
   `cwd`, sequentially. Tool Tasks own execution, permissions, output, and stop
   receipts. A spelling or cwd mismatch is an unclassified process and
   invalidates the current revision. Background completion is not proof of
   success until its canonical receipt and source evidence are available.
5. Inspect failures, make the smallest authorized correction with ordinary file
   tools, then rerun **every required check**. Any known mutation, profile change,
   or repeated check starts a new revision; earlier passing receipts remain
   historical and cannot satisfy the new revision. Never undo an edit merely to
   revive a cached pass. A check that changes included source invalidates itself;
   run necessary generation before the baseline or declare justified exclusions.
6. Use `get_goal` before completion. Report required/optional outcomes, source
   revision, changed paths, attempts and token use, stop reason, and limitations.
   Call `update_goal` with `complete` only when the objective is fulfilled and
   every required result is current and passed. This does not authorize commit,
   push, PR creation, merge, deployment, or any other publication.
7. Stop on repeated equivalent failure, exhausted attempts or tokens, missing
   evidence, user interruption, Host admission failure, or context-capacity
   failure. Do not retry the unchanged oversized provider input, reset a budget,
   replay settled edits after restart, or create another Goal to evade a stop.
   Recovery may reuse passes only after Host source revalidation; otherwise all
   required checks are outstanding. After a new explicit user request to resume
   a stopped run, call `create_goal` in that new user Turn with the same objective,
   roots and attempt limit. It starts a fresh revision within the original
   remaining budget; an exhausted budget requires a separately requested Goal.
