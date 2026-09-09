---
description: Review local changes and perform explicitly requested commits or publication using native Git and GitHub CLI commands.
when_to_use: Use for reviewing changes, committing selected files, pushing an explicit branch, or creating a requested pull request.
user-invocable: true
---

# Git Review and Publication

This is a procedure for ordinary Bash using `git` and `gh`, not a `git-review`
executable. Use an explicit repository `cwd`. Task receipts record execution and
output; the Host does not certify that a commit matches a frozen review.

## Inspect and commit

1. Read applicable repository instructions. Inspect `git status --short`, current
   branch and `git rev-parse HEAD` (an unborn repository has no HEAD). Inspect both
   `git diff` and `git diff --cached`, with `--no-ext-diff --no-textconv` for content
   inspection. Inspect selected untracked files separately; they are absent from
   ordinary diffs. Use `--` and literal pathspecs (`git --literal-pathspecs ...`)
   for user-specified paths. Account for both sides of renames, deletions, binary
   content, symlinks and unresolved conflicts. Resolve a truncated diff by focused
   inspection, never by treating omitted content as reviewed.
2. Establish whether the request means whole working files or already-staged
   hunks. For whole files, add only selected new paths with
   `git --literal-pathspecs add -- <selected-new-paths>`, then use
   `git --literal-pathspecs commit --only -m <message> -- <selected-paths>`.
   Include both old and new rename paths and tracked deletions. This preserves
   unrelated staged paths but commits the selected working files, including their
   unstaged changes. For staged hunks, inspect the entire staged diff and use
   ordinary `git commit` only when every staged change is authorized. Do not
   overwrite or unstage someone else's work to manufacture the desired selection.
3. Recheck branch, HEAD, selected content and index immediately before committing.
   If they changed, inspect again. Let native hooks, filters and signing run;
   do not bypass them or alter Git configuration implicitly. Inspect the resulting
   commit (`git show`, parent, paths and content) and remaining status afterward.
   Unexpected output or concurrent edits require reporting and reconciliation,
   not an automatic amend, reset, or repeated commit.

## Inspect and publish

1. Publication needs the user's intent for the operation and destination. A
   review or commit request alone does not authorize push, PR creation, merge,
   release or deployment. Inspect the exact remote URL, head branch, base branch,
   local commit SHA and the intended commit range using `git remote`,
   `git rev-parse`, `git log` and `git diff`. If comparison objects are missing,
   fetch only the needed remote refs within the requested scope and inspect again.
2. Query `git ls-remote <remote> refs/heads/<head>` before push. Use an explicit
   destination and refspec, e.g. `git push <remote> HEAD:refs/heads/<head>` after
   rechecking that HEAD is the inspected commit. Never force push, change remotes,
   or move another branch implicitly. Query the same remote ref afterward and
   compare its OID with the intended commit. A failed query is uncertainty.
3. Before creation, use `gh pr list --repo <owner/repo> --head <head> --base <base>
   --state all --json number,url,state,headRefName,baseRefName,headRepositoryOwner`
   and inspect candidates with `gh pr view`. For forks, verify the head repository
   and owner explicitly; a matching branch name alone is insufficient. Reuse or
   report an existing intended PR. A closed or merged PR requires deciding from
   the current request whether a new PR is wanted, not blind duplication.
4. Create only the requested PR, with explicit `--repo`, `--head` (owner-qualified
   for a fork), `--base`, `--title`, and `--body-file`. Write the body with actual
   newlines using file tools. Explicit head selection avoids implicit push/fork
   selection; push the intended branch separately first. Query afterward and
   verify the returned PR's repository, head/base and state.
5. After interruption, timeout, restart or an ambiguous response, inspect native
   state before another mutation. A commit may already exist, a push may have
   succeeded, or a PR may already have been created. Use Task status/output when
   available; expired output does not authorize replay. Do not remove index locks,
   install missing tools, or repeat publication blindly. Native Git locks do not
   make the full review/commit/push/PR sequence atomic across external clients.
