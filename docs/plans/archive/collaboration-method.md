---
status: done
priority: P1
owner: relixiaobo
created: 2026-06-02
updated: 2026-06-02
---

# Collaboration Method

The agreed way the PM and agents collaborate. This is a `draft` plan: once the
current in-flight branches merge, fold the relevant parts into `AGENTS.md`
(revise *Parallel Agent Development* + *Workflow*; add *Review gate*,
*Concurrency*, *Communication*, *Documentation System*), then archive this
plan. Until then, this file is the reference.

## Governing principle

The binding constraint is the PM's review/decision bandwidth, not agent build
capacity. Every rule below either makes the PM's decisions cheaper, avoids
wasting that bandwidth, or removes mechanical friction — and **nothing may add
a second serial chokepoint upstream of the PM**.

## Roles

- **PM (human)** — owns demand (what to build), judgment (approve plans,
  GO/NO-GO), and flow (what's in flight, what merges next). Does not write or
  line-review code.
- **Dev agents** (`cc`, `cc-2`, `codex`, `anti` — all equal dev agents) — plan
  (both *what* and *how*) with the PM, then build. `codex` is a different model
  (Codex/GPT); the rest are Claude Code. No agent has a special role beyond its
  clone.
- **Main agent** (`lin-outliner/`) — the **end-stage integration gatekeeper**:
  runs the review gate, merges, sequences, keeps `main` clean. It does **not**
  frame work up front (that would serialize the front). It reads the board to
  keep integration awareness.

## The flow (planning is parallel; main is at the end)

Per requirement, run independently and in parallel — one dev agent per
requirement, so the PM can drive several at once:

1. **Plan — PM ↔ dev agent.** The PM discusses the requirement *and* the
   approach (what + how) directly with the dev agent. The dev reads
   `docs/TASKS.md` + `docs/spec/` to self-check for collisions and fit before
   proposing.
2. **Approve — PM.** The dev presents its plan; the PM approves before any code
   is written (the control point). On approval the dev opens a Draft PR as its
   claim (see Concurrency). If the change touches a shared/protocol file, decide
   *here* to land an interface-only PR first, or to order it behind another
   branch.
3. **Build — dev agent.** Implements the approved plan. On any **directional /
   contract / product** question it **stops and asks the PM — it never guesses
   and proceeds**. Only trivial local details (a name, a minor impl choice) are
   decided in place and noted.
4. **Gate — main agent.** Runs the review gate, integration-checks against the
   real system, merges, updates records, owns merge ordering.

Planning (1–2) fans out across agents; only the gate (4) is main's, and the
gate itself is parallelized (see Review gate). No serial step precedes work.

## Two lanes

- **Plan-track** (substantial / touches protocol / architectural): full flow;
  the plan is recorded in `docs/plans/<topic>.md` (the contract).
- **Fast-track** (small / emergent / low blast radius): PM ↔ dev settles it
  inline, no plan file; straight to build → merge → `CHANGELOG` (`Internal`
  category for throwaway/experimental).

Both lanes pass through `TASKS.md` (the live board) and land in `CHANGELOG`.

## Review gate (`/code-review`)

Run by the main agent at the gate. Findings are ephemeral (PR comment or
`tmp/`), never a committed doc; only the outcome (the merge) is recorded in
`CHANGELOG`, and any follow-ups become `TASKS`/`plans` entries.

| PR shape | Gate |
|---|---|
| Small PR | `/code-review` (medium) |
| Large PR / touches protocol surface | `/code-review ultra` |
| Touches agent permissions / security | add `/security-review` |
| UI change | visual verification (light + dark) |

`/code-review` and `/code-review ultra` work on a local branch/diff — no GitHub
PR required. They are billed and user-triggered.

## Concurrency & WIP discipline

- **Cap the review queue, not the agent count.** At most **2 significant
  changes** awaiting the PM's review at once; small/background work is uncapped.
  (~4 dev agents is fine — the disease is unmerged pile-up, not headcount.)
- **Small batches.** One agent owns one PR; single-purpose; merge within hours.
  Smaller batches = cheaper rollback if the gate rejects.
- **Shared interface first.** Protocol/shared files (`src/core/commands.ts`,
  `src/core/types.ts`, `src/renderer/api/*`, shared test mocks, build config —
  the infrastructure-ownership list) land as a human-led interface-only PR
  first; then agents build on top.
- **Board self-check at plan time (load-bearing).** Because main reviews only at
  the end, collisions must surface *before* building: every dev reads
  `TASKS.md` (who's touching what) + `spec/` when planning. The board — not
  main — is the early collision radar. Keep it current.
- **Claim before building (Draft PR = the claim).** Reading the board only works
  if intentions are *written* to it. At plan approval the dev opens a **Draft PR
  immediately** — title = topic, body's first line = the file/area scope it will
  touch — *before* writing code; siblings scan open PRs (`gh pr list`) at plan
  time, so the claim is visible across clones the moment it exists (the only
  cross-clone channel is GitHub; a mark on a feature branch or in a not-yet-
  merged `TASKS.md` is invisible to others). The claim carries **scope, not just
  a name** (overlap is judged by files, not titles), **auto-releases on
  merge/close** (no stale locks to hand-clean), and is a **radar, not a lock** —
  two devs can still plan inside the window before either claims, so the PM's
  approval + "shared interface first" stay the backstop.

## Communication protocol

- **PM ↔ dev:** parallel; plan + approve. Bias is **plan-first,
  escalate-don't-guess** — never build on an unconfirmed directional assumption.
- **Main:** appears only at the end gate.
- **Agent ↔ agent:** through artifacts (the contract / PR / `TASKS.md`), never
  through the PM relaying. The PM is not a message bus.

## Document system

Two purposes — collaboration and recording. One document answers one question;
one question lives in one document; every document has a lifecycle.

| Document | Answers | Lifecycle |
|---|---|---|
| `AGENTS.md` | How do we work together? | stable |
| `docs/TASKS.md` | Who's doing what now? | updated continuously / on merge |
| `docs/plans/<topic>.md` | How exactly is this change done? | ship → fold into `spec/` → `plans/archive/` |
| `docs/spec/*` | How does it work now? | rewritten, never deleted |
| `CHANGELOG.md` | What changed, when? | append-only (`Internal` for throwaway) |
| `README.md` | What is this project? | as needed |
| module `README.md` | How does this one module work? | with the module |

Out of the shared system: `docs/fixtures/**` (test data → belongs under
`tests/`); `tmp/**` (local, gitignored scratch — promote keepers to
`plans/`/`spec/`, else delete).

## What stays unchanged

- 5 clones, cross-tool agents (Claude Code + Codex).
- Only the main agent merges to `main`.
- `userData` isolation per clone (`dev:*` scripts).
- Sync via GitHub (no local hub — it was a network workaround we are not
  building).

## Migration checklist

Touches infrastructure-ownership files, so do these once the board is drained,
not while `cc`/`cc-2` have uncommitted work:

- [ ] Fold this model into `AGENTS.md`.
- [ ] Delete `docs/plans/README.md` (index → `TASKS.md`; legend → `AGENTS.md`).
- [ ] Create `docs/plans/archive/`; move the ~15 terminal plans into it.
- [ ] Unify the shipped status word (keep one of `done` / `implemented`).
- [ ] Move `docs/fixtures/**` under `tests/`.
- [ ] Convert `docs/TASKS.md` into the single live board (agent status +
      in-progress + backlog), dropping the duplicated plan index.

Local-only, safe anytime:

- [ ] Clean `tmp/`: promote keepers (e.g. `design-principles-draft.md`) to
      `plans/`/`spec/`, delete the rest.
