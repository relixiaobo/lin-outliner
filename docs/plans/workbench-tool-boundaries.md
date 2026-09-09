# Workbench Tool Boundaries

## Goal

Keep Project as UI-owned organization. Use existing Git, GitHub, and test CLIs,
guided by Skills, through ordinary Bash. The Host owns admission, Tool Tasks, actual isolation,
and durable execution observations; it does not need a separate Git command protocol.

**Shape:** One complete simplification in one PR. Remove the Project model tools,
Git pseudo-CLI, and proprietary verification engine together with their consumers;
remove directory-wide Task exclusivity that prevents native workflows from running.
The result includes working Skills, generic execution, UI, tests, and current specs.

## Non-goals

- Replacement model tools, a new executable, renamed Project commands, or a bundled
  script reproducing the five Git operations under another name.
- Removing Projects, changing membership semantics, or Agent database writes.
- New stores, runners, RPC buses, broader permissions, implicit publication, or
  additional approval prompts for already-authorized ordinary work.
- Native terminals, migrations, legacy readers, or automatic data wipes.

## Design

### Native capability coverage

`gitReviewOperation` currently recognizes an exact shell-looking string, after which
Bash prepares private evidence and substitutes `gitReviewWorker` for shell execution.
The worker already calls Git/GitHub CLIs. Retire this extra protocol:

| Entry | Replacement |
| --- | --- |
| `project_inspect` | Existing Project directory/membership UI. |
| `project_manage` | Existing UI actions and Host-owned Project service. |
| `git-review capture` | `git status`, staged/unstaged `git diff`, explicit untracked-file inspection, retained output. |
| `git-review commit` | Explicit-path `git add` / `git commit`, selected-content inspection, resulting commit verification. |
| `git-review preview` | `git remote`, `git rev-parse`, `git log` / `git diff`, `git ls-remote`. |
| `git-review push` | Explicit-target `git push`, followed by remote-OID inspection. |
| `git-review create-pr` | `gh pr list` / `gh pr view`, then explicitly requested `gh pr create`. |

Git supports [diff inspection](https://git-scm.com/docs/git-diff),
[explicit-path commits](https://git-scm.com/docs/git-commit),
[explicit push refspecs](https://git-scm.com/docs/git-push), and
[remote-ref inspection](https://git-scm.com/docs/git-ls-remote).
GitHub CLI supports [PR queries by repository/head/base/state](https://cli.github.com/manual/gh_pr_list)
and [creation with explicit head/base and body files](https://cli.github.com/manual/gh_pr_create).

### Feature A: Project tools leave the model catalog

Remove `createProjectTools`, model schemas/actions, registration, and Agent-only
proposal callbacks through `ThreadService`, `agentHost`, `desktopHost`, and
`windowApplicationHost`. Remove the renderer's `project_manage` notification hook.
Retain shared request codecs, UI IPC, `ProjectService`, `ProjectCatalogStore`, and
canonical UI/catalog refresh paths.

Preserve UI create/edit/group/delete, new Chat in Project, revision/root checks,
lineage detach, Automation deletion fences, restart recovery, UI confirmations,
Chats, files, and active Tasks. Agents can recommend UI actions but cannot manage
Projects directly; directory work remains independent of Project binding. Reconcile
the aggregate workbench's Project-tool non-goal and contradictory Agent-proposal
paragraphs with current specs in this feature.

### Feature B: Skill plus native Git/GitHub commands

Keep `git-review` as a Skill name only. Its procedure uses the actual repository as
Task cwd, reads project instructions, and teaches:

1. Inspect branch/HEAD, staged/unstaged changes, selected untracked files, and full
   relevant diffs. Truncation needs focused inspection; account for binary files,
   renames, deletions, and shell-quoted `:(literal)` pathspecs after `--` so native
   inspection remains admitted under read-only delegation.
2. Commit only the explicitly requested files. Distinguish whole working files from
   staged hunks, add only selected new paths, and preserve unrelated staged/working
   changes. Inspect before and after; unexpected branch/content changes need renewed
   inspection. Native hooks, filters, and signing apply.
3. Resolve all push URLs with `git remote get-url --push --all`; inspect the complete
   authorized destination set, head/base, SHA, and range before publication.
   Missing objects need a separately scoped fetch. Never force push, reset, merge,
   or silently change destinations. Pass explicit repository/head/base and a body
   file to `gh pr create`, avoiding its implicit push/fork selection path.
4. Query each actual push URL and exact target ref before/after push, including
   failed or interrupted pushes; a named-remote fetch query does not reconcile a
   separate push URL. Account for multiple destinations and partial success.
   Query all relevant PR states before/after creation.
   Existing matching PRs are reused/reported. After interruption, reconcile before
   another mutation; incomplete/ambiguous results are not success. Never blindly
   replay commits, delete index locks, or install missing dependencies automatically.

Retire `GitReviewRuntime`, `gitReviewWorker`, obsolete Git operation implementations,
Bash substitution and dedicated stdin/action registrations. Preserve native CLI
admission, read-only/publication blocks, and shared safe Git inspection helpers used
by passive context discovery. No replacement dispatcher, launcher, or packaging entry.

Remove the private `gitReviewEvidence` protocol/codec, producer and context handlers,
`GitReviewResult`, command-string renderer detection, and unused copy/styles. Use
existing Bash output, artifacts, diff presentation, and composer. Generic Task/Item
and resource history still survives restart/compaction/fork within its retention
contract; missing observations never cause command replay. A persisted-format cut
uses fresh isolated dev data without migrations, legacy readers, or automatic deletion.

### Verification uses native checks and ordinary Goal state

Retain the `verification` Skill. Read repository instructions and normal build/test
configuration, choose relevant native commands, execute them at explicit cwd, inspect
Task output and exit status, correct failures, and rerun affected checks. Report the
commands, working directory, result, and remaining uncertainty. Re-inspect changed
source before concluding; an old passing command is historical evidence, not proof
about every later source revision. A failed or interrupted check is never a pass.

Remove `VerificationCoordinator`, source manifests, verification persistence,
`create_goal.verification`, Goal verification responses, private context payloads,
completion admission gates, Task observation hooks, and automatic source hashing.
Retain Goal objective/status/token budgets, generic continuation accounting and
budget wrap-up, Task receipts, output/artifacts, and process isolation. Ordinary
Goal completion remains an Agent judgment supported by current evidence. The Host
no longer certifies source/check equivalence or enforces a verification retry count.
The Skill bounds correction attempts according to the request and reports blockers.

Remove the unused `.tenon/checks.json` parser/schema and check-profile discovery;
repository instructions remain bounded, passive context. Unavailable or oversized
instruction files do not gate shell execution. There is no replacement registry,
check identity API, command normalization parser, or hidden verification protocol.
Removing the coordinator also removes its cross-Chat mutex and its invalidation of
successful checks after harmless reads or spelling-equivalent shell commands.

### Task ownership does not imply directory exclusivity

Remove the durable directory-claim table and `worktree_busy` admission. Remove the
now-unused execution-policy mutation flag and its shell classification; permission
continues to come from capability ceilings and isolation. Task admission no longer
reserves cwd or every Git worktree for the entire process lifetime. A running development server
can coexist with Git inspection, file edits, and another check in the same cwd.
Native tools enforce their own locks and conflicts. Concurrent edits need normal
inspection and coordination; Task admission does not promise a transaction across
external processes. Do not replace this with a shell-command allow-list.

Keep delegated parent/child ownership and settlement fencing independently of
address locks: only an authorized child may inherit an active execution owner's
isolation context, and the owner cannot release its worktree while children run.
Name this relationship execution ownership, not a directory claim. Keep scheduler
capacity leases, Task stop/recovery, and actual sandbox receipts unchanged.

### Explicit behavior changes and risks

This simplifies the current
[Git publication contract](../spec/agent-tool-design.md#git-review-and-explicit-publication):

| Property | Treatment |
| --- | --- |
| Intent, capability ceilings, configured blocks, cwd, isolation, stop and Task settlement | Preserve existing Host contracts. |
| Arguments, bounded output/artifacts, exit state, and provenance | Preserve generic canonical history. |
| Pre-commit review, explicit paths/targets, reconciliation after uncertainty | Skill procedures over native CLIs. |
| Host-enforced immutable review-reference admission and exact reviewed working bytes | Retire; hooks/filters and external races remain relevant. |
| Specialized selection cards and copied private review references | Retire in favor of ordinary output/artifacts and composer. |
| Durable Git-specific preview/reconciliation coordinator | Retire; Agent performs explicit read-only reconciliation. |

Do not claim exactly-once publication or atomic query-then-create across external
clients. Even Git's [conditional ref update](https://git-scm.com/docs/git-update-ref)
does not make the whole review/index/push/PR sequence transactional. Updating only
command names while retaining private routing, or claiming Skill text enforces the
old guarantees, fails this design. These reductions are the selected product boundary; Skills do not enforce the retired Host guarantees.

### Scope and collisions

Touch model tool contracts, capability registration, Project Agent adapters and
callbacks, Goal contracts/storage, Git/verification implementation and Skills,
execution context discovery/publication/codecs, Tool Task ownership/store/service,
result UI/styles/locales, relevant tests, and current Agent specs/plans. No new
runtime, dependency, build entry, or document command/type change is needed.

Consume the merged [#658](https://github.com/relixiaobo/lin-outliner/pull/658) isolation
contract. [#656](https://github.com/relixiaobo/lin-outliner/pull/656) retires Settings
tools and [#659](https://github.com/relixiaobo/lin-outliner/pull/659) retires file deletion;
both overlap tools, capability/runtime wiring, tests, and specs. Keep their behavior
independent and consume their final main commits when available. The PR claim names
the expanded scope. Main owns board/changelog and merge sequencing; archived A-E
plans remain historical provenance, while current specs must describe this design.

## Open questions

None for the implementation direction. Main coordinates the overlapping catalog
retirements and archives this plan with its integration record.

## Acceptance and validation

- Verify actual provider catalog/action/factory absence and UI Project lifecycle,
  including Automation dependencies, rather than only checking deleted strings.
- Run native recipes through Bash in disposable repositories and a local bare remote:
  selected new/modified/renamed/deleted/binary paths, literal names, unrelated staged
  work, and resulting SHAs. Include distinct fetch/push URLs, multiple push targets,
  and literal diff recipes through the read-only capability path. Validate
  reconciliation recipes against queried native state; do not recreate
  the removed GitHub coordinator solely to test it. No test PR publication is needed.
- Preserve read-only/publication blocks and Unit E receipts/isolation. Exercise
  uncertain settlement, generic artifact retention, restart/compaction/fork/expiry,
  and light/dark ordinary result presentation. Do not assert that prompts enforce
  retired Host guarantees.
- Verify Goal create/get/update, budget accounting and continuation without the
  removed verification parameter. Run failed and passing native checks through Bash
  with oversized instructions; unrelated Chats must remain independently admissible.
- Run a background process alongside same-cwd Git and file operations. Preserve
  unauthorized child rejection, descendant settlement, scheduler limits and isolation.
- Run typecheck, relevant Core/renderer/E2E tests, `docs:check`, and diff checks.
  Derive retirement work with `rg` over removed tools, factories, private payloads,
  `gitReviewOperation`, and `GitReviewRuntime`; inspect all production/current-doc hits.
  Update current specs/plans in the implementation; retain archived provenance.
  Main audits board/recovery premises, folds shipped design into specs, and archives.
