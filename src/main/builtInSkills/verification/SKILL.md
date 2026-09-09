---
description: Verify a coding change with native test commands, inspect failures, and correct the authorized work using ordinary tools.
when_to_use: Use for validating implementation, running relevant checks, or an explicitly requested verify-and-correct workflow.
user-invocable: true
---

# Verification

1. Read the requested acceptance criteria, applicable repository instructions,
   and existing build/test configuration. Select the native commands that prove
   the changed behavior. No Tenon check profile or check registration is needed.
   A missing test or unavailable prerequisite is remaining work, never a pass.
2. Use ordinary Bash with an explicit `cwd`. Inspect the command, exit status,
   and relevant output. A background Task is unfinished until its terminal
   receipt is available. Use `task_status` and `task_stop` for owned processes.
   Missing, truncated, interrupted or expired output limits what can be concluded.
3. Diagnose a failure and make the smallest authorized correction with existing
   tools. Rerun the affected checks and the repository's required gates. Do not
   weaken checks, skip failing cases or change input coverage just to get green.
   Once the relevant checks pass, repeat them only for new changes, failures or
   unresolved concerns. A harmless read does not require rerunning a suite.
4. Re-inspect relevant source changes before concluding. A passing command proves
   what ran at that time, not the current state of every source file or external
   service. After concurrent edits or a restart, compare the present work with
   the retained observations and rerun checks whose applicability is uncertain.
   Report the commands/cwd, outcomes, changed behavior and material limitations.
5. Bound correction attempts by the user's constraints; otherwise reassess after
   three failed correction cycles. Stop on repeated unchanged failure, missing
   prerequisites, user interruption or exhausted budget; explain the blocker.
   These are workflow instructions, not a Host-certified attempt counter.
6. Create a Goal only when explicitly requested. Use the ordinary objective and
   optional explicitly requested `token_budget`; `get_goal` reports budget and
   usage. Do not reset a budget or create another Goal to evade a stop. Mark the
   Goal complete only when the full objective is achieved, or blocked when work
   cannot continue under the Goal contract. Goal completion is the Agent's
   evidence-backed judgment; the Host does not authenticate a source revision or
   test suite. Verification alone does not authorize commit or publication.
