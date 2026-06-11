# Agent Working Notes

`AGENTS.md` is the single source of truth for every coding agent in this repo;
`CLAUDE.md` and `AGENT.md` are symlinks to it — **edit `AGENTS.md` only.** One
file, three names (the [agents.md](https://agents.md/) standard, governed by the
Linux Foundation's Agentic AI Foundation). Codex/Cursor read `AGENTS.md`; Claude
Code reads `CLAUDE.md`.

**Communication language.** Reply to the user in **Chinese** in chat. Write
everything that lands in the repo — code, identifiers, comments, documentation,
commit messages — in **English**. Applies to every agent.

This file is loaded into every agent's context every session. Keep it lean: it
holds load-bearing rules and decisions, not tutorials. Deep detail lives in
`docs/spec/` (linked below); when a rule here and a spec disagree, fix one of
them in the same change rather than letting them drift.

## Commands

| Task | Command |
|---|---|
| Typecheck | `bun run typecheck` |
| Unit tests | `bun run test:core` · `bun run test:renderer` |
| E2E tests | `bun run test:e2e` (Playwright) |
| Dev run (per clone) | `bun run dev:<main\|cc\|cc-2\|codex\|codex-2\|anti>` — isolates `userData` |
| Packaged build | `bun run app:build` → unsigned `.dmg` in `release/` |

Run `bun run typecheck` + the relevant tests before marking a PR ready. macOS is
the supported dev platform. `userData` isolation and packaging detail are under
**Dev environment** below.

## Engineering & Design Principles

These are durable, project-wide principles — not task-specific. Every agent and
every change MUST follow them. Full detail lives in `docs/spec/` (see
`docs/spec/README.md` for the map; visual authority is
`docs/spec/design-system.md`). This section is the always-loaded summary.

### Architecture

- **A1 — TypeScript/Electron only.** No Rust/Cargo/Tauri/`src-tauri` runtime
  code for product work. Document state, agent tools, parser, preview/validation,
  and persistence are all TypeScript.
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
  `ELECTRON_USER_DATA_DIR` / the clone-specific `dev:*` script (see Dev
  environment); packaged Tenon uses appId `dev.linlab.tenon` and
  `~/Library/Application Support/Tenon/`. Never point a dev run at the installed
  prod app's data.
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

## How We Work Together

Six clones run side-by-side under `~/Coding/`, sharing one GitHub origin
(`relixiaobo/lin-outliner`). Sync happens **only through PRs to `main`** — treat
the clones as separate machines that share a remote, never via local cross-clone
operations.

```
~/Coding/
  lin-outliner/         ← main agent: review, merge, integration
  lin-outliner-cc/      ← Claude Code dev agent
  lin-outliner-cc-2/    ← Claude Code dev agent (second)
  lin-outliner-codex/   ← Codex dev agent
  lin-outliner-codex-2/ ← Codex dev agent (second)
  lin-outliner-anti/    ← Claude Code dev agent (anti)
```

**Governing principle.** The binding constraint is the PM's review/decision
bandwidth, not agent build capacity. The PM is **on the loop** (ratifies, handles
exceptions), not **in the loop** (co-designing each change). Every rule below
either raises the quality of what reaches the PM, cuts how often the PM is
needed, or removes mechanical friction — and **nothing may add a second serial
chokepoint upstream of the PM**. Planning fans out (one dev agent per
requirement, in parallel); the main agent appears only at the end gate.

### Roles (determined by working directory)

Your role is fixed by the clone you run in. Check your working directory at the
start of a session and act accordingly.

- **PM (human)** — owns demand (what to build), judgment (approve plans,
  GO/NO-GO), and flow (what's in flight, what merges next). **Ratifies plans; does
  not co-design them.** Does not write or line-review code.
- **Dev agents** (`cc`, `cc-2`, `codex`, `codex-2`, `anti` — all equal) — **draft**
  the plan (what + how) AND build it. `codex` and `codex-2` are a different model
  (Codex/GPT); the rest are Claude Code. No agent has a special role beyond its
  clone.
- **Main agent** (`lin-outliner/`) — the **end-stage integration gatekeeper**:
  runs the review gate, merges, sequences, keeps `main` clean. Does **not** frame
  work up front (that would serialize the front); reads the board for integration
  awareness.

| Clone | Agent | Branch prefix | Role |
|-------|-------|---------------|------|
| `lin-outliner/` | main (Claude Code) | — | End-stage gate: review, merge, sequence, push `main`, visual verification. Owns `docs/TASKS.md` + `CHANGELOG.md`. |
| `lin-outliner-cc/` | Claude Code | `cc/<topic>` | Draft plan with PM, build, open Draft PR. |
| `lin-outliner-cc-2/` | Claude Code | `cc-2/<topic>` | Draft plan with PM, build, open Draft PR. |
| `lin-outliner-codex/` | Codex | `codex/<topic>` | Draft plan with PM, build, open Draft PR. |
| `lin-outliner-codex-2/` | Codex | `codex-2/<topic>` | Draft plan with PM, build, open Draft PR. |
| `lin-outliner-anti/` | Claude Code | `anti/<topic>` | Draft plan with PM, build, open Draft PR. |

Topic should map to a plan in `docs/plans/` when possible; one branch per plan,
closed when merged. Avoid long-lived catch-all branches, and keep unrelated
concerns (e.g. UI vs agent-tool work) on separate branches.

### The flow (PM ratifies a one-pager; main is the end gate)

Per requirement, run independently and in parallel — one dev agent per
requirement, so the PM can drive several at once:

1. **Plan — dev agent drafts.** The dev reads `docs/TASKS.md` + `docs/spec/`,
   runs the **collision self-check** (below), and drafts a one-page plan: *goal /
   approach / files it will touch / risks / collision result*. The PM produces
   the *what* and direction; the dev produces the *how*.
2. **Approve — PM ratifies.** The PM says **yes / redirect / no** on the
   one-pager (≈ a minute) before any code is written — the control point. On yes,
   the dev opens a **Draft PR as its claim** (title = topic, first body line =
   the file/area scope). If the change touches a shared/protocol file, decide
   *here* to land an interface-only PR first, or to order it behind another
   branch.
3. **Build — dev agent.** Implement the approved plan; run `bun run typecheck` +
   relevant tests; commit, push, mark the PR ready. The PR body is the contract.
   Escalate per the rule below.
4. **Gate — main agent.** Run the review gate, integration-check against the real
   system, merge to `main`, update `docs/TASKS.md`, add a `CHANGELOG.md` entry
   under `[Unreleased]`, and own merge ordering.
5. **Resync.** After a merge, dev agents `git fetch && git rebase origin/main` on
   their active branches.

Only step 4 is main's, and the review parallelizes (cloud review); **merge to
`main` stays serial** (one branch). No serial step precedes work.

### Escalate, don't guess — but don't flood

Protect the PM's bandwidth by escalating the right things and only those.

- **Escalate** (stop and ask the PM) when a decision is **directional/taste**,
  **hard to reverse**, or **expensive if wrong**: product behavior, a
  contract/protocol shape, a security trade-off, anything cross-cutting. Never
  build on an unconfirmed directional assumption.
- **Decide and note** (do NOT escalate) the reversible locals: a name, a private
  helper's shape, test structure, error copy, a refactor that doesn't change a
  contract. Record the call in the PR. Never spend the PM on something cheap to
  undo.

### Collision self-check (the agent's job, not the PM's)

The PM is bad at holding two parallel plans in its head — so the agent does the
cross-check, not the PM. At plan time the dev runs: `gh pr list` (open claims) +
scan `docs/TASKS.md` + grep the files it intends to touch against open-PR scopes,
and reports the result in the plan ("no overlap" / "overlaps #X on file Y").
Surface only a real conflict. The Draft-PR claim carries file scope,
auto-releases on merge/close, and is a **radar, not a lock** — two devs can still
plan inside the window before either claims, so the PM's approval +
shared-interface-first remain the backstop. (Cross-clone visibility is only
through GitHub: a mark on a feature branch or an unmerged `TASKS.md` is invisible
to siblings — the open Draft PR is what they see.)

### Autonomy boundaries

A dev agent decides reversible locals freely. **Confirm with the PM first** for:
merging or marking-ready **another agent's** PR; touching an
infrastructure-ownership file; force-push or history rewrite; deleting another
agent's work; or any outward-facing / irreversible action. Only the main agent
merges to `main` — when a dev change is ready, mark the PR ready and stop.

### Two lanes

- **Plan-track** (**significant** = touches protocol/shared files, OR changes
  user-visible behavior, OR spans many files): full flow; design recorded in
  `docs/plans/<topic>.md` (the contract).
- **Fast-track** (small / emergent / low blast radius): settle inline, no plan
  file; straight to build → merge → `CHANGELOG` (`Internal` category for
  throwaway/experimental).

Both lanes surface on `docs/TASKS.md` and land in `CHANGELOG`.

### Review gate (main only)

Run by the main agent at the gate; the gate is **mechanical** in what the diff
touches. Findings are ephemeral (PR comment or `tmp/`), never a committed doc;
only the outcome (the merge) is recorded.

| Diff touches | Gate |
|---|---|
| protocol/shared surface, or large | `/code-review ultra` |
| agent permissions / security | add `/security-review` |
| UI | visual verification (light + dark) |
| anything else | `/code-review` (medium) |

`/code-review` works on a local branch/diff — no GitHub PR required. It is billed
and user-triggered.

### Concurrency & WIP discipline

- **Cap the review queue, not the agent count.** At most **2 significant
  changes** (plan-track) awaiting the PM's review at once; small/background work
  is uncapped. The disease is unmerged pile-up, not headcount.
- **Small batches.** One agent owns one PR; single-purpose; merge within hours.
  Prefer a separate worktree (`tmp/worktrees/`) over stashing when a branch has
  substantial uncommitted changes.
- **Shared interface first.** Protocol/shared files (the infrastructure-ownership
  list) land as a human-led interface-only PR first; then agents build on top.

### Communication

- **PM ↔ dev:** parallel; plan + approve. Bias is **plan-first,
  escalate-don't-guess**.
- **Main:** appears only at the end gate.
- **Agent ↔ agent:** through artifacts (the plan / PR / `docs/TASKS.md`), never
  through the PM relaying. The PM is not a message bus.
- **Optional:** a spare agent may pre-review a plan in parallel before it reaches
  the PM — advisory only, never a serial gate (that would violate the governing
  principle).

## Dev environment

### userData isolation (required)

All clones share packaged `appId` `dev.linlab.tenon`, so without an override they
would write to the same `~/Library/Application Support/Tenon/` and clobber
each other. `src/main/main.ts` resolves `userData` early, before any service
reads it:

1. `ELECTRON_USER_DATA_DIR` if set (verbatim).
2. Else from source (`!app.isPackaged`) → `$HOME/.lin-outliner-dev` (so a bare
   `bun run dev` can never touch the installed prod app's data).
3. Else (packaged) → Electron's default path (the daily-use prod data).

Use the clone's `dev:*` script so each stays isolated: `dev:main` →
`$HOME/.lin-outliner-main`, `dev:cc` → `…-cc`, `dev:cc-2`, `dev:codex`,
`dev:codex-2`, `dev:anti`. Never point a dev run at the installed prod app's
data.
The dev-only `.lin-outliner-*` directory names intentionally stay as
compatibility names for now; renaming them would touch every clone's `dev:*`
script and is a separate change.

### Packaging

`bun run app:build` = `build:native` + `electron-vite build` + `electron-builder`
→ unsigned (`mac.identity: null`) `.dmg` in `release/` (gitignored). Install by
dragging to `/Applications`; right-click → Open on first launch to clear
Gatekeeper. Installed app and `dev:*` runs keep separate `userData`. Env-var
prefixes are macOS/Linux; on Windows use `cross-env`.

### Temporary workspace (`tmp/`, gitignored — never commit under it)

- `tmp/worktrees/<topic>` — in-clone git worktrees when one agent needs multiple
  branches at once (`git worktree add tmp/worktrees/<topic> <branch>`; `remove` /
  `prune` to clean up). Separate from the cross-agent split, which is at the clone
  level.
- `tmp/research/` — cloned reference projects (nodex, lin-agent, etc.) and
  exploratory files. Prefer it over new root-level research folders.

### Infrastructure file ownership

These files cause most cross-agent conflicts. Coordinate before touching them —
open an isolated PR and let the other agent rebase before continuing:

- `bun.lock`, `package.json` — dependencies
- `tsconfig.json`, `electron.vite.config.ts`, `vite.config.ts` — build
- `AGENTS.md` (and its `CLAUDE.md` / `AGENT.md` symlinks) — these notes
- `docs/spec/README.md` — spec index
- `src/core/commands.ts`, `src/core/types.ts` — protocol surface
- `docs/TASKS.md`, `CHANGELOG.md` — main-agent-owned; dev agents never edit them

The default owner is whichever agent is actively shipping the related plan. When
in doubt, post the intended change on the corresponding PR or issue first.

## Document System

Two purposes — collaboration and recording. One document answers one question;
one question lives in one document; every document has a lifecycle.

| Document | Answers | Lifecycle |
|---|---|---|
| `AGENTS.md` | How do we work together? | stable |
| `docs/TASKS.md` | Who's doing what now? | updated continuously / on merge |
| `docs/plans/<topic>.md` | How exactly is this change done? | ship → fold into `spec/` → `docs/plans/archive/` |
| `docs/spec/*` | How does it work now? | rewritten, never deleted |
| `CHANGELOG.md` | What changed, when? | append-only (`Internal` for throwaway) |
| `README.md` | What is this project? | as needed |
| module `README.md` | How does this one module work? | with the module |

- `docs/spec/` — current intended behavior. Read these to understand the code;
  `docs/spec/README.md` is the map. Update the spec in the SAME change as the
  behavior. `docs/spec/agent-progress.md` is the agent-integration checklist;
  detailed contracts go in `docs/spec/agent-tool-design.md`.
- `docs/plans/` — forward-looking work. Each plan carries a YAML `status`. The
  active-plan **catalog is the set of non-terminal `docs/plans/*.md` (read their
  frontmatter)** — it is not hand-maintained anywhere; `docs/TASKS.md` Backlog is
  the prioritized cut. Terminal plans move to `docs/plans/archive/`; we never
  delete a plan.

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
document, flip status to `done`, and move it to `archive/`. A plan is not a place
for daily progress notes — those go in commit messages.

**Each PR ships a complete feature — no partial slices.** A plan's execution
units must each be a complete, independently-verifiable thing — a refactor, an
optimization, or a new capability that works and can be reviewed on its own.
Never plan a PR that only lays groundwork a *later* PR makes useful ("Phase 1
scaffold → Phase 2 fills it in"). Every plan is therefore exactly one of: **(a)
ONE complete feature in one PR** — any internal "phases/slices/stages" are
build-order *within* that single PR (cf. A7 foundation-before-consumers), not
separate releases and never a standalone partial MVP; or **(b) a SET of
independent complete features**, each its own PR, ordered only by genuine
dependency or priority, each shippable alone. When you write a plan, say which
shape it is. Pre-release we carry **no migration / back-compat / legacy
readers**: on a format change, wipe `~/.lin-outliner-*` dev userData and delete
the old reader rather than ship a migration.
