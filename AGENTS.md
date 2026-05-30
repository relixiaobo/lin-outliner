# Agent Working Notes

`AGENTS.md` is the single source of truth for every coding agent in this repo.
`CLAUDE.md` and `AGENT.md` are symlinks to it — **edit `AGENTS.md` only.**

- Codex and Cursor read `AGENTS.md` natively at the repo root.
- Claude Code reads `CLAUDE.md`; the symlink resolves to this file.
- `AGENT.md` is kept as a symlink for tools that look for the singular name.

There is nothing to "keep in sync": one file, three names. (Standard:
[agents.md](https://agents.md/), governed by the Linux Foundation's Agentic AI
Foundation.)

## Communication Language

Reply to the user in Chinese in chat. Keep everything written into the
repository in English — code, identifiers, comments, documentation, and
commit messages. This applies to every agent.

## Engineering & Design Principles

These are durable, project-wide principles — not task-specific. Every agent and
every change MUST follow them. Full detail lives in `docs/spec/` (see
`docs/spec/README.md` for the map; visual authority is
`docs/spec/design-system.md`). This section is the always-loaded summary; when a
principle and a deep spec disagree, fix one of them in the same change rather
than letting them drift.

### Architecture

- **A1 — TypeScript/Electron only.** No Rust/Cargo/Tauri/`src-tauri` runtime
  code for product work (see Stack Constraints below). Document state, agent
  tools, parser, preview/validation, and persistence are all TypeScript.
- **A2 — The process seam is sacred.** main = native host + Node backend;
  renderer = React; preload = the only `contextIsolation`-safe bridge. Don't leak
  Node into the renderer or DOM work into main.
- **A3 — Security defaults are non-negotiable; never regress.**
  `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`;
  `setWindowOpenHandler` deny + `shell.openExternal`; `will-navigate` /
  `will-redirect` allow only `^https?://`; permission handler allow-list
  (`clipboard-sanitized-write` only); CSP on the packaged `file://` document;
  single-instance lock; `before-quit` flush.
- **A4 — Commands are the mutation surface.** Document state is event-sourced;
  all mutations go through core commands. `src/core/commands.ts` and
  `src/core/types.ts` are the protocol surface — changing them is a coordinated,
  cross-agent change, never a drive-by.
- **A5 — userData isolation per clone.** Resolve `userData` via
  `ELECTRON_USER_DATA_DIR` / the clone-specific `dev:*` script (see below); never
  point a dev run at the installed prod app's data.
- **A6 — Spec ⇄ code stay in sync.** `docs/spec/` describes *current intended*
  behavior. When behavior changes, update the spec in the SAME change; when a
  plan ships, fold its design into the spec. Guard tests track the real DOM/CSS,
  not a past shape.
- **A7 — Foundation before consumers (linear-dependency discipline).** Settle the
  mechanism — tokens, theming mechanism, IPC/command contracts — before layering
  visual or feature work on top. Never write against an interim mechanism you are
  about to replace; it just gets redone. (This is the lesson from the failed
  first UI-refactor round.)
- **A8 — Don't over-claim done.** A plan/index "shipped" status must match
  verified reality. Verify with `file:line` or a real run before asserting
  completion.
- **A9 — Perception over benchmarks, but measure before trading.** Optimize for
  perceived responsiveness; before swapping a latency optimization for throughput
  (e.g. `flushSync` on apply), measure with the existing probe.
- **A10 — Cross-agent coordination.** Dev agents work on feature branches and
  open PRs; only the main agent merges to `main`. Coordinate before touching the
  infrastructure-ownership files listed below.

### Visual / design system

Authority: `docs/spec/design-system.md`. The load-bearing rules:

- **B1 — Two themes over one ink base.** Every value is a token; color is
  alpha-on-ink (`--ink` + `--text-*` / `--fill-*`). Dark mode flips `--ink`. No
  raw hex outside token declarations.
- **B2 — Dark mode targets `@media (prefers-color-scheme)` +
  `color-scheme: light dark`.** The current `[data-theme]` + JS bridge is interim
  only; don't deepen reliance on it.
- **B3 — Functional state is neutral.** Selection, hover, active, and focus use
  the neutral `--fill-*` ladder + a neutral focus ring — never a brand or system
  accent.
- **B4 — One rose accent, sparse; one rose link.** No `--primary` family. Status
  colors carry status meaning ONLY — they never paint
  selection/hover/active/focus.
- **B5 — Liquid-Glass two-layer model.** Opaque content base; translucent
  material ONLY on chrome (rails, overlays/menus). Every material has a
  `prefers-reduced-transparency` opaque fallback.
- **B6 — Icon controls deepen color, no box.** Icon-only chrome controls (rail
  toggles, pane close, header actions) signal hover/active by color, not a
  `--fill-*` background; if a fill is truly needed it is pill/circular, never a
  rounded square.
- **B7 — Hover never changes layout.** No `transform: scale` "pop", no
  size/neighbor reflow on hover.
- **B8 — Honor accessibility preferences.** Visible `:focus-visible` rings
  (suppress only non-keyboard focus); `prefers-contrast`,
  `prefers-reduced-motion`, and `prefers-reduced-transparency` all respected.
- **B9 — Concentric radius chain** (window 24 → rail 16 → composer 8); the token
  geometry/spacing/type/shadow/z ladders are the single source — derive, don't
  hand-duplicate.
- **B10 — Native feel, not web.** No `cursor: pointer` on non-links (the hand
  cursor is for content hyperlinks only); chrome text is not user-selectable; use
  native context/app menus and OS materials/scrollbars/dark mode; tiered overlay
  elevation (menus level-1, dialogs/palette level-2).
- **B11 — Guard tests enforce the system; don't relax them to pass.** If a
  token/hex/elevation guard fires, fix the CSS to use tokens; only widen an
  exception set deliberately, with a comment.

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
  lin-outliner-anti/    ← Claude Code dev agent (anti)
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
| `lin-outliner-anti/` | Claude Code dev agent | Build features on `anti/<topic>` branches; open Draft PRs. |

**Dev agents (cc / cc-2 / codex / anti) must NOT:**

- `gh pr merge` or otherwise merge any PR.
- Push to `main` (work only on feature branches).
- Edit `docs/TASKS.md` or `CHANGELOG.md` (both main-agent-owned; the main
  agent records the changelog entry on merge).

Only the main agent in `lin-outliner/` merges to `main`. When a dev agent's
change is ready, mark the PR ready and stop — the main agent takes it from
there.

### Workflow

1. **Plan (main agent).** Pick the next item from `docs/TASKS.md` / a plan in
   `docs/plans/`. Either create a feature branch + Draft PR whose body is a
   self-contained task spec for a dev agent, or hand the topic to a dev agent
   to self-initiate.
2. **Build (dev agent).** On `cc/<topic>`, `cc-2/<topic>`, `codex/<topic>`, or
   `anti/<topic>`, implement the change, run `bun run typecheck` + relevant tests, commit,
   push, and open a Draft PR (or mark an assigned one ready). The PR body is
   the contract.
3. **Review + merge (main agent).** Review the PR (typecheck, tests, build,
   code + design-system review, visual check for UI), merge to `main`, update
   `docs/TASKS.md`, and add a `CHANGELOG.md` entry under `[Unreleased]`
   (Added / Changed / Fixed / Internal as appropriate, referencing the PR).
4. **Resync.** After a merge, dev agents `git fetch && git rebase origin/main`
   on their active branches.

Branch naming: `cc/<topic>`, `cc-2/<topic>`, and `anti/<topic>` (Claude Code),
`codex/<topic>` (Codex). Topic should map to a plan in `docs/plans/` whenever possible. One
branch per plan; close it when merged. Avoid long-lived catch-all branches.

### userData isolation (required)

Electron resolves `userData` from the application's `appId`. All clones share
`com.linoutliner.desktop`, so without an override they would write to the same
`~/Library/Application Support/Lin Outliner/` and clobber each other's
documents, agent sessions, and tests.

`src/main/main.ts` resolves `userData` early in startup, before any service
reads it:

1. If `ELECTRON_USER_DATA_DIR` is set, use it verbatim (`app.setPath`).
2. Else if running from source (`!app.isPackaged`), fall back to
   `$HOME/.lin-outliner-dev` so a bare `bun run dev` can never read or clobber
   the installed prod app's daily-use data.
3. Else (a packaged/installed build) use Electron's default path,
   `~/Library/Application Support/Lin Outliner/`.

Use the clone-specific dev script so each clone stays isolated; the bare-dev
fallback above is only a safety net:

- Main agent:    `bun run dev:main`  → `$HOME/.lin-outliner-main`
- Claude Code:   `bun run dev:cc`    → `$HOME/.lin-outliner-cc`
- Claude Code 2: `bun run dev:cc-2`  → `$HOME/.lin-outliner-cc-2`
- Codex:         `bun run dev:codex` → `$HOME/.lin-outliner-codex`
- Anti:          `bun run dev:anti`  → `$HOME/.lin-outliner-anti`
- Bare source run (no env): `$HOME/.lin-outliner-dev` (step 2 above).
- Installed prod app: the default path (step 3). This is the daily-use
  data; never point a dev run at it.

### Building and installing the prod app

`bun run app:build` runs `electron-vite build` then `electron-builder`, emitting
an unsigned (`mac.identity: null`) `.dmg` to `release/` (gitignored). Install by
opening the dmg and dragging the app to `/Applications`; on first launch,
right-click → Open to clear Gatekeeper (the build is unsigned). The installed
app and any `bun run dev:*` testing run keep separate `userData`, so daily-use
documents are safe from test churn.

The env-var-prefix syntax works on macOS/Linux. On Windows, prefix with
`cross-env` or set the variable in the shell first. macOS is the
supported dev platform today.

### Infrastructure file ownership

These files cause most cross-agent conflicts when modified independently.
Coordinate before touching them — open an isolated PR and let the other
agent rebase before continuing:

- `bun.lock`, `package.json` — dependencies
- `tsconfig.json`, `electron.vite.config.ts`, `vite.config.ts` — build
- `AGENTS.md` (and its `CLAUDE.md` / `AGENT.md` symlinks) — these notes
- `docs/spec/README.md`, `docs/plans/README.md` — doc indexes
- `src/core/commands.ts`, `src/core/types.ts` — protocol surface
- `docs/TASKS.md` — main-agent-owned; dev agents never edit it
- `CHANGELOG.md` — main-agent-owned; the main agent adds an `[Unreleased]`
  entry on merge (step 3), dev agents never edit it

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
