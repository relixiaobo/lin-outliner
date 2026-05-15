# Agent Working Notes

This repository is a TypeScript/Electron product. Do not introduce Rust, Cargo,
Tauri, or `src-tauri` runtime code for current product work.

## Temporary Workspaces

Use `tmp/` for local-only agent workspace data. `tmp/` is ignored by git and may
be deleted at any time.

Recommended layout:

```txt
tmp/
  worktrees/
    agent-node-tools/
  research/
    pi-mono/
    nodex/
    sider-agent/
    lin-agent/
```

Use `tmp/worktrees/` for git worktrees when multiple branches need to be worked
on in parallel from the same repository checkout.

Example:

```bash
git worktree add tmp/worktrees/agent-node-tools codex/agent-node-tools
```

When a temporary worktree is no longer needed, remove it explicitly:

```bash
git worktree remove tmp/worktrees/agent-node-tools
git worktree prune
```

Use `tmp/research/` for cloned reference projects and exploratory files. Prefer
placing future research repos there instead of adding new root-level research
folders.

## Branch Hygiene

- Keep unrelated UI/outliner work and agent-tool work on separate branches.
- Prefer a separate worktree over stashing when a branch already has substantial
  uncommitted changes.
- Do not commit files under `tmp/`.
