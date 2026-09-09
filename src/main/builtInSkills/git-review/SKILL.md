---
description: Review exact Git changes, commit explicitly selected working files, and preview or publish through supervised Git and GitHub CLI operations.
when_to_use: Use when the user asks to review local changes, commit a selected file set, push a branch, or create a GitHub PR. Review and verification never imply publication authority.
user-invocable: true
---

# Git Review And Publication

Use ordinary Bash for inspection (`git status --short`, `git diff --stat`,
`git diff -- paths`, `git diff --cached -- paths`) and the following strict,
standalone Bash commands for durable review and publication. Set `cwd` to the
requested directory and use foreground execution. Never concatenate these
commands with shell syntax. Supply literal JSON using Bash `stdin`.

1. **Capture:** `git-review capture --input - --output json`, stdin `{}` or
   `{ "paths": ["src/example.ts"] }`. Paths are exact, relative to the Git
   worktree root; in a non-Git directory they are relative to `cwd` and required.
   Capture includes staged/unstaged changes, untracked, binary, renames and
   deletions. It returns `gitReview.review`, an immutable reference object.
   Inspect diffs with ordinary Git as needed; snippets and the displayed path
   list are bounded. Request a focused capture for omitted paths. Capture does
   not authorize commit. Never substitute optional discovered branch metadata
   for the captured baseline.
   Capture disables fsmonitor, external diff and textconv, and refuses configured
   executable clean/process filters before inspection. Submodule dirty contents
   are not inspected recursively. Use ordinary Bash explicitly for filtered
   repositories; do not retry the helper to bypass this refusal.
2. **Commit:** only after the user requests a commit of an explicit file set,
   use `git-review commit --input - --output json` with
   `{ "review": <exact reference object>, "paths": [...], "message": "..." }`.
   Untracked files must be explicitly selected; select both rename paths.
   The operation commits the reviewed **working file content**, including the
   selected files' unstaged changes; it is not a staged-hunks operation.
   Unrelated index entries and working files are retained. It uses Git plumbing,
   writes the exact reviewed bytes without clean filters, does not execute commit
   hooks, and honors `commit.gpgSign`. Use ordinary Bash
   when the user requests a custom hook workflow. Report SHA and parent from the
   receipt. A changed baseline, index, kind, size or digest requires renewed
   review. Never refresh a snapshot implicitly to bypass a rejection.
3. **Preview:** `git-review preview --input - --output json` with
   `{ "remote": "origin", "base": "main" }`. Show the exact remote URL/name,
   branch, HEAD, upstream, range, and PR head/base. Remote base objects must
   already exist locally; an unavailable object requires a separately scoped
   ordinary fetch and a new preview. Review-only work never proceeds to push.
4. **Push:** when requested, use `git-review push --input - --output json` with
   `{ "review": <exact preview reference> }`. Each attempt first queries the
   remote branch. A matching remote OID is adopted without another push.
   Ref movement requires another preview. Never force push, reset, merge, or
   silently fall back to another remote or hosting command.
5. **PR:** when requested and the previewed head is on the remote, use
   `git-review create-pr --input - --output json` with
   `{ "review": <exact preview reference>, "title": "...", "body": "..." }`.
   The first adapter supports a same-repository branch on github.com with `gh`
   authenticated. It queries exact head/base before creating and after the
   attempt. A discovered matching PR, including a closed/merged PR, is evidence
   and is never duplicated. Unsupported hosting or incomplete evidence stops.
6. **Uncertainty:** interrupted/killed tasks or `uncertain` results are not
   success. Remote operations reconcile with the same preview before another
   attempt. Local commit uncertainty requires ordinary read-only inspection of
   the reported commit, HEAD, parent/ref and index; never automatically retry a
   commit or remove an index lock. Tenon's claim coordinates admitted tasks;
   external clients can race. Report that limitation and preserve evidence.
7. Historical diffs are immutable observations. Refresh appends new evidence;
   compaction preserves references but never authorizes mutation or bypasses
   live checks. Non-Git review supports bounded file excerpts and ordinary
   checks; commit, push and PR creation are unavailable.
