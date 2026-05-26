# Agent Working Notes

This file exists in two synchronized copies:

- `AGENT.md` — read by Codex
- `CLAUDE.md` — read by Claude Code

Keep them identical. When updating one, update the other in the same commit.

## Communication Language

Reply to the user in Chinese in chat. Keep everything written into the
repository in English — code, identifiers, comments, documentation, and
commit messages. This applies to both agents.

## Stack Constraints

This repository is a TypeScript/Electron product. Do not introduce Rust,
Cargo, Tauri, or `src-tauri` runtime code for current product work.
Document state, agent tools, parser logic, preview/validation, and
persistence are all implemented in TypeScript.

## Parallel Agent Development

Three independent clones run side-by-side under `~/Coding/`, sharing one
GitHub origin (`relixiaobo/lin-outliner`). Synchronization happens through
PRs to `main`, never via local cross-clone operations — treat the clones as
separate machines that share a remote.

```
~/Coding/
  lin-outliner/         ← main agent: review, merge, integration
  lin-outliner-cc/      ← Claude Code dev agent
  lin-outliner-cc-2/    ← Claude Code dev agent (second)
  lin-outliner-codex/   ← Codex dev agent
```

### Roles (determined by working directory)

An agent's role is fixed by the clone it runs in. Check your working
directory at the start of a session and act accordingly.

| Clone | Agent | Role |
|-------|-------|------|
| `lin-outliner/` | main agent (Claude Code) | Plan, draft task PRs, review, merge, push `main`, visual verification. Owns `docs/TASKS.md`. |
| `lin-outliner-cc/` | Claude Code dev agent | Build features on `cc/<topic>` branches; open Draft PRs. |
| `lin-outliner-cc-2/` | Claude Code dev agent | Build features on `cc-2/<topic>` branches; open Draft PRs. |
| `lin-outliner-codex/` | Codex dev agent | Build features on `codex/<topic>` branches; open Draft PRs. |

**Dev agents (cc / cc-2 / codex) must NOT:**

- `gh pr merge` or otherwise merge any PR.
- Push to `main` (work only on feature branches).
- Edit `docs/TASKS.md` (main-agent-owned).

Only the main agent in `lin-outliner/` merges to `main`. When a dev agent's
change is ready, mark the PR ready and stop — the main agent takes it from
there.

### Workflow

1. **Plan (main agent).** Pick the next item from `docs/TASKS.md` / a plan in
   `docs/plans/`. Either create a feature branch + Draft PR whose body is a
   self-contained task spec for a dev agent, or hand the topic to a dev agent
   to self-initiate.
2. **Build (dev agent).** On `cc/<topic>`, `cc-2/<topic>`, or `codex/<topic>`,
   implement the change, run `bun run typecheck` + relevant tests, commit,
   push, and open a Draft PR (or mark an assigned one ready). The PR body is
   the contract.
3. **Review + merge (main agent).** Review the PR (typecheck, tests, build,
   code + design-system review, visual check for UI), merge to `main`, and
   update `docs/TASKS.md`.
4. **Resync.** After a merge, dev agents `git fetch && git rebase origin/main`
   on their active branches.

Branch naming: `cc/<topic>` and `cc-2/<topic>` (Claude Code), `codex/<topic>`
(Codex). Topic should map to a plan in `docs/plans/` whenever possible. One
branch per plan; close it when merged. Avoid long-lived catch-all branches.

### userData isolation (required)

Electron resolves `userData` from the application's `appId`. All clones share
`com.linoutliner.desktop`, so without an override they would write to the same
`~/Library/Application Support/Lin Outliner/` and clobber each other's
documents, agent sessions, and tests.

`src/main/main.ts` reads `ELECTRON_USER_DATA_DIR` early in startup and calls
`app.setPath('userData', ...)`. Use the clone-specific dev script, not the
bare `bun run dev`:

- Main agent:    `bun run dev:main`  → `$HOME/.lin-outliner-main`
- Claude Code:   `bun run dev:cc`    → `$HOME/.lin-outliner-cc`
- Claude Code 2: `bun run dev:cc-2`  → `$HOME/.lin-outliner-cc-2`
- Codex:         `bun run dev:codex` → `$HOME/.lin-outliner-codex`
- Production: leave `ELECTRON_USER_DATA_DIR` unset to use the default
  user-data path.

The env-var-prefix syntax works on macOS/Linux. On Windows, prefix with
`cross-env` or set the variable in the shell first. macOS is the
supported dev platform today.

### Infrastructure file ownership

These files cause most cross-agent conflicts when modified independently.
Coordinate before touching them — open an isolated PR and let the other
agent rebase before continuing:

- `bun.lock`, `package.json` — dependencies
- `tsconfig.json`, `electron.vite.config.ts`, `vite.config.ts` — build
- `AGENT.md`, `CLAUDE.md` — these files
- `docs/spec/README.md`, `docs/plans/README.md` — doc indexes
- `src/core/commands.ts`, `src/core/types.ts` — protocol surface
- `docs/TASKS.md` — main-agent-owned; dev agents never edit it

The default owner is whichever agent is actively shipping the related
plan. When in doubt, post the intended change on the corresponding PR
or issue first.

## Temporary Workspaces

Use `tmp/` for local-only agent workspace data. `tmp/` is gitignored and
may be deleted at any time.

Recommended layout:

```txt
tmp/
  worktrees/
    <topic>/
  research/
    nodex/
    lin-agent/
    sider-agent/
```

`tmp/worktrees/` is for in-clone git worktrees when one agent needs to
work on multiple branches simultaneously (e.g. mid-PR review of its own
work). This is separate from the cross-agent split, which lives at the
clone level (`~/Coding/lin-outliner-cc` vs `lin-outliner-codex`).

```bash
git worktree add tmp/worktrees/<topic> <branch>
git worktree remove tmp/worktrees/<topic>
git worktree prune
```

`tmp/research/` is for cloned reference projects (nodex, lin-agent,
sider-agent, pi-mono, etc.) and exploratory files. Prefer it over
adding new root-level research folders.

## Branch Hygiene

- Keep unrelated UI/outliner work and agent-tool work on separate branches.
- Prefer a separate worktree (under `tmp/worktrees/`) over stashing when
  a branch already has substantial uncommitted changes.
- Do not commit files under `tmp/`.

## Plans and Specs

- `docs/spec/` — describes current intended behavior. Read these to
  understand the code. See `docs/spec/README.md` for the map.
- `docs/plans/` — describes forward-looking work. Pick from
  `docs/plans/README.md` when starting new work. Each plan has a YAML
  frontmatter `status` field; update it as work progresses.
- `docs/spec/agent-progress.md` is the living checklist for agent
  integration. Update it when an agent milestone lands or a priority
  changes. Keep it short and milestone-oriented; detailed contracts go
  in `docs/spec/agent-tool-design.md`.
