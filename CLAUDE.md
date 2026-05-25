# Agent Working Notes

This file exists in two synchronized copies:

- `AGENT.md` — read by Codex
- `CLAUDE.md` — read by Claude Code

Keep them identical. When updating one, update the other in the same commit.

## Stack Constraints

This repository is a TypeScript/Electron product. Do not introduce Rust,
Cargo, Tauri, or `src-tauri` runtime code for current product work.
Document state, agent tools, parser logic, preview/validation, and
persistence are all implemented in TypeScript.

## Parallel Agent Development

Two independent clones run side-by-side, one per agent:

```
~/Coding/
  lin-outliner-cc/      ← Claude Code works here
  lin-outliner-codex/   ← Codex works here
```

Both clones push to the same GitHub origin (`relixiaobo/lin-outliner`).
Synchronization happens through PRs to `main`, not via local cross-clone
operations. Treat the two clones like two separate machines that happen
to share a GitHub remote.

### userData isolation (required)

Electron resolves `userData` from the application's `appId`. Both clones
share `com.linoutliner.desktop`, so without override they would write to
the same `~/Library/Application Support/Lin Outliner/` and clobber each
other's documents, agent sessions, and tests.

`src/main/main.ts` reads `ELECTRON_USER_DATA_DIR` early in startup and
calls `app.setPath('userData', ...)`. Use the agent-specific dev script,
not the bare `bun run dev`:

- Claude Code: `bun run dev:cc`     → `$HOME/.lin-outliner-cc`
- Codex:      `bun run dev:codex`   → `$HOME/.lin-outliner-codex`
- Production: leave `ELECTRON_USER_DATA_DIR` unset to use the default
  user-data path.

The env-var-prefix syntax works on macOS/Linux. On Windows, prefix with
`cross-env` or set the variable in the shell first. macOS is the
supported dev platform today.

### Branch and PR workflow

- Both clones can sit on `main` simultaneously. Do day-to-day work on
  feature branches.
- Branch naming: `cc/<topic>` for Claude Code, `codex/<topic>` for Codex.
  Topic should map to a plan file in `docs/plans/` whenever possible.
  Example: `cc/asset-subsystem`, `codex/past-chats-impl`.
- Push the feature branch; open a PR to merge into `main`. Conflicts
  surface at PR time, where they can be resolved deliberately.
- After a PR merges, the other agent should `git fetch && git rebase
  origin/main` (or `git pull --rebase`) on its own active branches.
- Avoid long-lived `cc/work` or `codex/work` catch-all branches. One
  branch per plan; close it when merged.

### Infrastructure file ownership

These files cause most cross-agent conflicts when modified independently.
Coordinate before touching them — open an isolated PR and let the other
agent rebase before continuing:

- `bun.lock`, `package.json` — dependencies
- `tsconfig.json`, `electron.vite.config.ts`, `vite.config.ts` — build
- `AGENT.md`, `CLAUDE.md` — these files
- `docs/spec/README.md`, `docs/plans/README.md` — doc indexes
- `src/core/commands.ts`, `src/core/types.ts` — protocol surface

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
