# Workbench Tool Boundaries

## Goal

Keep Project as UI-owned organization. Use existing `git`/`gh` CLIs, guided by
Skills, through ordinary Bash. The Host owns admission, Tool Tasks, actual isolation,
and durable execution observations; it does not need a separate Git command protocol.

**Shape:** Two independently shippable features, each one complete implementation
PR: remove Project model tools; replace the Git pseudo-CLI and private evidence/UI
path with a native CLI workflow. Each includes consumers, tests, specs, and retirement.

## Non-goals

- Replacement model tools, a new executable, renamed Project commands, or a bundled
  script reproducing the five Git operations under another name.
- Removing Projects, changing membership semantics, or Agent database writes.
- New stores, runners, RPC buses, broader permissions, implicit publication, or
  additional approval prompts for already-authorized ordinary work.
- Unit C changes, native terminals, migrations, legacy readers, or automatic data wipes.

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
   renames, deletions, and literal pathspecs.
2. Commit only the explicitly requested files. Distinguish whole working files from
   staged hunks, add only selected new paths, and preserve unrelated staged/working
   changes. Inspect before and after; unexpected branch/content changes need renewed
   inspection. Native hooks, filters, and signing apply.
3. Inspect exact remote URL, head/base, SHA, and range before authorized publication.
   Missing objects need a separately scoped fetch. Never force push, reset, merge,
   or silently change destinations. Pass explicit repository/head/base and a body
   file to `gh pr create`, avoiding its implicit push/fork selection path.
4. Query remote OIDs after push and all relevant PR states before/after creation.
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
old guarantees, fails this design. The reductions above require product ratification.

### Scope and collisions

- A touches `src/core/agent/tools.ts`, Agent capability classification,
  `src/main/agent/projects/`, the named Host/ThreadService callbacks,
  `src/renderer/agent/projects/`, Project/Automation/catalog tests, and Project specs.
- B touches `src/core/agent/gitReview.ts`, `src/main/agent/gitReview/`,
  `agentLocalTools`, `ToolRuntime`, context protocol/codec/dependencies/publication,
  Git result UI/styles/locales, Git/development Skills, tests, and Agent specs.
  No dependency/build configuration or document command/types change is planned.
- Consume [#658](https://github.com/relixiaobo/lin-outliner/pull/658)'s final isolation
  contract and [#656](https://github.com/relixiaobo/lin-outliner/pull/656)'s catalog
  cleanup first. Collision check: #656 overlaps tools, capabilities, ToolRuntime,
  agentHost and specs; #658 overlaps ToolRuntime, context, Skills and specs. This new
  plan file overlaps neither code diff. Recheck exact scopes before implementation.
- Serialize A then B on shared files; this is collision ordering, not a functional
  dependency. Main owns board/changelog and placement against startup/recovery/records.
  This follow-up does not expand Unit E or silently extend the existing A-E gate.

## Open questions

- Ratify the explicit guarantee/UI reductions before Feature B. The recommendation
  is native `git`/`gh` plus Skill, with no new CLI. Retaining Host-enforced reviewed
  references would require an explicit design revision, not an implicit fallback.
- Main must place these feature claims relative to the recovery/records queue after
  #656 and #658; a plan submission does not indefinitely reserve their shared files.

## Acceptance and validation

- Verify actual provider catalog/action/factory absence and UI Project lifecycle,
  including Automation dependencies, rather than only checking deleted strings.
- Run native recipes through Bash in disposable repositories and a local bare remote:
  selected new/modified/renamed/deleted/binary paths, literal names, unrelated staged
  work, and resulting SHAs. Use existing GitHub CLI fixtures for ambiguous/lost PR
  responses; remote test publication requires explicit authorization.
- Preserve read-only/publication blocks and Unit E receipts/isolation. Exercise
  uncertain settlement, generic artifact retention, restart/compaction/fork/expiry,
  and light/dark ordinary result presentation. Do not assert that prompts enforce
  retired Host guarantees.
- Run typecheck, relevant Core/renderer/E2E tests, `docs:check`, and diff checks.
  Derive retirement work with `rg` over removed tools, factories, private payloads,
  `gitReviewOperation`, and `GitReviewRuntime`; inspect all production/current-doc hits.
  Update current specs/plans in the implementation; retain archived provenance.
  Main audits board/recovery premises, folds shipped design into specs, and archives.
