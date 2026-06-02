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

Five independent clones run side-by-side under `~/Coding/`, sharing one
GitHub origin (`relixiaobo/lin-outliner`). Synchronization happens through
PRs to `main`, never via local cross-clone operations — treat the clones as
separate machines that share a remote.

**Governing principle.** The binding constraint is the PM's review/decision
bandwidth, not agent build capacity. Every rule below either makes the PM's
decisions cheaper, avoids wasting that bandwidth, or removes mechanical
friction — and **nothing may add a second serial chokepoint upstream of the
PM**. Planning fans out (one dev agent per requirement, in parallel); the
main agent appears only at the end gate, never to frame work up front.

```
~/Coding/
  lin-outliner/         ← main agent: review, merge, integration
  lin-outliner-cc/      ← Claude Code dev agent
  lin-outliner-cc-2/    ← Claude Code dev agent (second)
  lin-outliner-codex/   ← Codex dev agent
  lin-outliner-anti/    ← Claude Code dev agent (anti)
```

### Roles (determined by working directory)

- **PM (human)** — owns demand (what to build), judgment (approve plans,
  GO/NO-GO), and flow (what's in flight, what merges next). Does not write or
  line-review code.
- **Dev agents** (`cc`, `cc-2`, `codex`, `anti` — all equal) — plan *what* and
  *how* directly with the PM, then build. `codex` is a different model
  (Codex/GPT); the rest are Claude Code. No agent has a special role beyond its
  clone.
- **Main agent** (`lin-outliner/`) — the **end-stage integration gatekeeper**:
  runs the review gate, merges, sequences, keeps `main` clean. It does **not**
  frame work up front (that would serialize the front); it reads the board to
  keep integration awareness.

An agent's role is fixed by the clone it runs in. Check your working
directory at the start of a session and act accordingly.

| Clone | Agent | Role |
|-------|-------|------|
| `lin-outliner/` | main agent (Claude Code) | End-stage gatekeeper: review gate, merge, sequence, push `main`, visual verification. Owns `docs/TASKS.md` + `CHANGELOG.md`. Does not frame work up front. |
| `lin-outliner-cc/` | Claude Code dev agent | Plan with PM, then build on `cc/<topic>` branches; open Draft PRs. |
| `lin-outliner-cc-2/` | Claude Code dev agent | Plan with PM, then build on `cc-2/<topic>` branches; open Draft PRs. |
| `lin-outliner-codex/` | Codex dev agent | Plan with PM, then build on `codex/<topic>` branches; open Draft PRs. |
| `lin-outliner-anti/` | Claude Code dev agent | Plan with PM, then build on `anti/<topic>` branches; open Draft PRs. |

**Dev agents (cc / cc-2 / codex / anti) must NOT:**

- `gh pr merge` or otherwise merge any PR.
- Push to `main` (work only on feature branches).
- Edit `docs/TASKS.md` or `CHANGELOG.md` (both main-agent-owned; the main
  agent records the changelog entry on merge).

Only the main agent in `lin-outliner/` merges to `main`. When a dev agent's
change is ready, mark the PR ready and stop — the main agent takes it from
there.

### Workflow (planning is parallel; main is at the end)

Per requirement, run independently and in parallel — one dev agent per
requirement, so the PM can drive several at once:

1. **Plan — PM ↔ dev agent.** The PM discusses *what* and *how* directly with
   the dev. The dev first reads `docs/TASKS.md` + `docs/spec/` to self-check for
   collisions and fit, then proposes.
2. **Approve — PM.** The dev presents its plan; the PM approves before any code
   is written (the control point). On approval the dev opens a **Draft PR as its
   claim** (title = topic, first body line = the file/area scope) so siblings
   see it. If the change touches a shared/protocol file, decide *here* to land
   an interface-only PR first, or order it behind another branch.
3. **Build — dev agent.** On `cc/<topic>` / `cc-2/<topic>` / `codex/<topic>` /
   `anti/<topic>`, implement the approved plan; run `bun run typecheck` +
   relevant tests; commit, push, mark the PR ready. The PR body is the contract.
   On any **directional / contract / product** question, **stop and ask the PM —
   never guess and proceed**; only trivial local details (a name, a minor impl
   choice) are decided in place and noted.
4. **Gate — main agent.** Run the review gate (below), integration-check against
   the real system, merge to `main`, update `docs/TASKS.md`, add a `CHANGELOG.md`
   entry under `[Unreleased]` (Added / Changed / Fixed / Internal), and own merge
   ordering.
5. **Resync.** After a merge, dev agents `git fetch && git rebase origin/main`
   on their active branches.

Only step 4 is main's, and the review itself parallelizes (cloud review);
**merge to `main` stays serial** (one branch). No serial step precedes work.

### Two lanes

- **Plan-track** (substantial / touches protocol / architectural): full flow;
  the design is recorded in `docs/plans/<topic>.md` (the contract).
- **Fast-track** (small / emergent / low blast radius): PM ↔ dev settles it
  inline, no plan file; straight to build → merge → `CHANGELOG` (`Internal`
  category for throwaway/experimental).

Both lanes surface on `docs/TASKS.md` (the live board) and land in `CHANGELOG`.

### Review gate (`/code-review`)

Run by the main agent at the gate. Findings are ephemeral (PR comment or
`tmp/`), never a committed doc; only the outcome (the merge) is recorded.

| PR shape | Gate |
|---|---|
| Small PR | `/code-review` (medium) |
| Large PR / touches protocol surface | `/code-review ultra` |
| Touches agent permissions / security | add `/security-review` |
| UI change | visual verification (light + dark) |

`/code-review` works on a local branch/diff — no GitHub PR required. It is
billed and user-triggered.

### Concurrency & WIP discipline

- **Cap the review queue, not the agent count.** At most **2 significant
  changes** (plan-track) awaiting the PM's review at once; small/background work
  is uncapped. ~4 dev agents is fine — the disease is unmerged pile-up, not
  headcount.
- **Small batches.** One agent owns one PR; single-purpose; merge within hours.
- **Shared interface first.** Protocol/shared files (the infrastructure-
  ownership list below) land as a human-led interface-only PR first; then agents
  build on top.
- **Claim before building.** Reading the board only works if intentions are
  *written* to it: at plan approval the dev opens a Draft PR (scope in the body)
  *before* coding. Siblings scan open PRs (`gh pr list`) + `TASKS.md` at plan
  time — that is the collision radar. The claim carries scope (overlap is judged
  by files), auto-releases on merge/close, and is a radar, not a lock (the PM's
  approval + shared-interface-first stay the backstop).

### Communication protocol

- **PM ↔ dev:** parallel; plan + approve. Bias is **plan-first,
  escalate-don't-guess** — never build on an unconfirmed directional assumption.
- **Main:** appears only at the end gate.
- **Agent ↔ agent:** through artifacts (the contract / PR / `TASKS.md`), never
  through the PM relaying. The PM is not a message bus.

Branch naming: `cc/<topic>`, `cc-2/<topic>`, `anti/<topic>` (Claude Code),
`codex/<topic>` (Codex). Topic should map to a plan in `docs/plans/` whenever
possible. One branch per plan; close it when merged. Avoid long-lived catch-all
branches.

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
- `docs/spec/README.md` — spec index
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

## Document system

Two purposes — collaboration and recording. One document answers one question;
one question lives in one document; every document has a lifecycle.

| Document | Answers | Lifecycle |
|---|---|---|
| `AGENTS.md` | How do we work together? | stable |
| `docs/TASKS.md` | Who's doing what now? (+ the active-plan index) | updated continuously / on merge |
| `docs/plans/<topic>.md` | How exactly is this change done? | ship → fold into `spec/` → `docs/plans/archive/` |
| `docs/spec/*` | How does it work now? | rewritten, never deleted |
| `CHANGELOG.md` | What changed, when? | append-only (`Internal` for throwaway) |
| `README.md` | What is this project? | as needed |
| module `README.md` | How does this one module work? | with the module |

- `docs/spec/` — current intended behavior. Read these to understand the code;
  `docs/spec/README.md` is the map. When behavior changes, update the spec in
  the SAME change.
- `docs/plans/` — forward-looking work; the active-plan index lives on
  `docs/TASKS.md`. Each plan has a YAML `status`; update it as work progresses.
  Terminal plans move to `docs/plans/archive/`; we never delete a plan.
- `docs/spec/agent-progress.md` is the living checklist for agent integration.
  Keep it short and milestone-oriented; detailed contracts go in
  `docs/spec/agent-tool-design.md`.

**Plan status vocabulary** (frontmatter `status`):

- `draft` — written down, not started.
- `in-progress` — work has begun; track open subtasks inline.
- `done` — shipped; its substance lives in `spec/`, the plan stays as history.
- `superseded` — replaced by a different approach that shipped; kept to record
  the path not taken.
- `shelved` — explicitly decided not to do for now; keep the rationale.
- `meta` — a standing reference (e.g. a decision catalog), not a unit of work.

**Plan authoring.** Keep each plan single-file. Lead with **Goal** /
**Non-goals**, then **Design**, then **Open questions**; sub-checklists last.
When a plan is implemented, move its **Design** into the relevant `spec/`
document, flip status to `done`, and move it to `archive/`. A plan is not a
place for daily progress notes — those go in commit messages.
