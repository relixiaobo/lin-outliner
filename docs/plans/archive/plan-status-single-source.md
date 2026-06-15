# TASKS.md is the single source of status; plans are pure design

> This plan is itself the first instance of the convention it proposes: it carries
> **no frontmatter**. Its own status/priority live on the board (`docs/TASKS.md`),
> not here.

## Problem

A plan's lifecycle facts are written **twice**, and the two copies drift the moment
a plan ships or is re-prioritized:

- `status` and `priority` live in each plan's YAML frontmatter — and the current
  convention even makes that frontmatter authoritative (AGENTS.md: *"the active-plan
  catalog is the set of non-terminal `docs/plans/*.md` — read their frontmatter"*).
- The same `status`/`priority`, plus a readiness sub-state ("awaiting ratification"
  / "needs build GO"), are **restated** in `docs/TASKS.md`.

Two real incidents (2026-06-13): `security-settings-ia-redesign` shipped as **#215**
(frontmatter flipped to `done`, file moved to `archive/`) yet still sat in the
TASKS Backlog as "draft — awaiting PM ratification"; `file-attachments` shipped as
**#204/#206** yet still held "Top of queue." In both, the *frontmatter side* was
updated and the *board side* was not.

The deeper issue: **`status` is project-management state, not a property of a
design.** A plan describing *how to build X* should not have to mutate as X moves
draft → building → done. Coupling the design doc to its own PM-status is what
created the second copy that drifts.

## The model

> **`docs/TASKS.md` is the single source of truth for what's to do and where it
> stands. It points out to plan files. A plan file is pure design — the *how* — and
> nothing else.**

- **plan** answers exactly one question: *how is this built?* It is **stable** — it
  does not change as the work moves through the pipeline. It carries **no
  frontmatter**: no status, no priority, no gate. (Provenance — author, dates — is
  in git history.)
- **TASKS.md** answers: *what's to do, what's its status and priority, and where is
  its plan?* It is the one board, the single status authority, and it links out to
  each plan.

Because status lives in exactly one place, **two copies cannot disagree — drift is
structurally impossible.** What remains is mere *staleness* of the one board (a
lesser problem than divergence), addressed by the gate discipline + a tiny link
guard below.

This also **collapses the per-merge bookkeeping from four steps to one.** Today
shipping a plan means: flip frontmatter `status` → `git mv` to `archive/` → add a
"Recently completed" entry → remove the Backlog entry. Those are four separate
actions, and the one reliably done is "add Recently completed" (it is satisfying);
the forgotten ones are the others. Under this model, shipping is **move the board
item to done** — one action, no frontmatter to sync. The mechanism that produced
the forgetting is gone.

## Non-goals

- **Not** merging `TASKS.md` and `CHANGELOG.md` (PM decision: independent docs).
- **No** generator that writes a catalog into TASKS, **no** derived/duplicated
  catalog block, **no** `gate` frontmatter field. (Earlier drafts of this plan
  proposed those; they *automate and police* the duplication instead of removing
  it. Recorded here so the path-not-taken is on file.)
- **No** network / `gh` dependency in the guard — offline and deterministic.
- **No** back-compat machinery (pre-release): frontmatter is stripped in one pass.

## The guard — `bun run docs:check` (CI + gate)

Offline, deterministic, tiny — because with a single source there is no
cross-source consistency to police, only structural integrity:

- **C1 — link integrity.** Every `docs/plans/<slug>.md` reference in `TASKS.md`
  resolves to an existing file at the referenced location (non-archive link ↔ file
  in `plans/`; `archive/` link ↔ file in `archive/`). *A shipped plan moved to
  `archive/` while its board link still points at `plans/` is exactly the
  `security-settings` dangling-link symptom — C1 catches it.*
- **C2 — no orphan plans.** Every non-archive `docs/plans/*.md` is referenced by at
  least one `TASKS.md` item. *Catches a plan added but never put on the board (the
  `outline-syntax-unification`-missing-from-Backlog case).*

That is the whole guard. No status-validity check (there is no frontmatter status),
no freshness check (nothing is generated).

**Honest residual.** Single-source removes *divergence* but not *staleness*: if a
human ships a plan and updates neither the board nor the file location, nothing is
inconsistent (the one source simply says "still active") and no machine signal
fires. This is the inherent trade of one-source-of-truth, mitigated by (a) the
one-step bookkeeping above and (b) the gate step already requiring the board be
updated on merge. A heavier gate-time `gh` cross-check (merged-PR ↔ board item) is
possible but rejected here for keeping the guard offline and simple.

## AGENTS.md changes (the contract — review these)

Five edits to the **Document System** + **Engineering** sections, reversing the
"frontmatter is the catalog" convention. Presented before → after.

**(1) The `docs/plans/` bullet (Document System).**

before:
```md
- `docs/plans/` — forward-looking work. Each plan carries a YAML `status`. The
  active-plan **catalog is the set of non-terminal `docs/plans/*.md` (read their
  frontmatter)** — it is not hand-maintained anywhere; `docs/TASKS.md` Backlog is
  the prioritized cut. Terminal plans move to `docs/plans/archive/`; we never
  delete a plan.
```
after:
```md
- `docs/plans/` — forward-looking work: **pure design, nothing else.** A plan
  answers only *how is this built?* and carries **no status, priority, or
  frontmatter** — those are project-management facts, not properties of a design,
  and live solely in `docs/TASKS.md`, which points out to each plan by link.
  `docs/TASKS.md` **is** the single active-work catalog. A shipped plan moves to
  `docs/plans/archive/` for tidiness once its board item is `done`; we never delete
  a plan. (Provenance — author, dates — is in git history.)
```

**(2) The status-vocabulary block (Document System).**

before:
```md
**Plan status vocabulary** (frontmatter `status`):

- `draft` — written down, not started.
- `in-progress` — work has begun; track open subtasks inline.
- `done` — shipped; its substance lives in `spec/`, the plan stays as history.
- `superseded` — replaced by a different approach that shipped; kept to record the path not taken.
- `shelved` — explicitly decided not to do for now; keep the rationale.
- `meta` — a standing reference (e.g. a decision catalog), not a unit of work.
```
after:
```md
**Status vocabulary** (lives in `docs/TASKS.md`, never in the plan file):

- `draft` — written down, not started.
- `in-progress` — work has begun.
- `done` — shipped; the plan's design is folded into `spec/` and the plan moves to `archive/`.
- `superseded` — replaced by a different approach that shipped; archived, path-not-taken kept.
- `shelved` — explicitly decided not to do for now; keep the rationale.
- `meta` — a standing reference (e.g. a decision catalog), not a unit of work.

A plan's lifecycle is the status of its board item; the plan file does not record it.
```

**(3) The Document System table — two rows.**

before:
```md
| `docs/TASKS.md` | Who's doing what now? | updated continuously / on merge |
| `docs/plans/<topic>.md` | How exactly is this change done? | ship → fold into `spec/` → `docs/plans/archive/` |
```
after:
```md
| `docs/TASKS.md` | What's to do, and where does each item stand? (the single board) | updated continuously / on merge |
| `docs/plans/<topic>.md` | How exactly is this change done? (design only — no status) | ship → fold design into `spec/` → `docs/plans/archive/` |
```

**(4) Plan-authoring paragraph.**

before:
```md
**Plan authoring.** Keep each plan single-file. Lead with **Goal** /
**Non-goals**, then **Design**, then **Open questions**; sub-checklists last.
When a plan is implemented, move its **Design** into the relevant `spec/`
document, flip status to `done`, and move it to `archive/`.
```
after:
```md
**Plan authoring.** Keep each plan single-file and **frontmatter-free** — it is
pure design. Lead with **Goal** / **Non-goals**, then **Design**, then **Open
questions**; sub-checklists last. When a plan is implemented, fold its **Design**
into the relevant `spec/` document, **mark its `docs/TASKS.md` item `done`**, and
move the plan to `archive/`.
```

**(5) Commands section — wire the guard into "before marking ready."**

before:
```md
Run `bun run typecheck` + the relevant tests before marking a PR ready.
```
after:
```md
Run `bun run typecheck` + the relevant tests + `bun run docs:check` before marking
a PR ready.
```

## Migration (one PR)

1. **Capture before stripping.** For every active `docs/plans/*.md`, ensure its
   `status` + `priority` are recorded on the `docs/TASKS.md` board **first** (do not
   lose the only copy of that info). The board already lists most; reconcile any
   gaps.
2. **Strip frontmatter** from all active (non-archive) plans → pure design docs.
   Archived plans are inert history — leave their frontmatter as-is (touching 75
   frozen files buys nothing); the convention applies going forward.
3. **TASKS.md** keeps its hand-written board; drop the "read frontmatter / `rg
   -l '^status:'`" catalog language from its preamble (status no longer lives in
   frontmatter to read).
4. **Add the guard** (`scripts/docs-check.ts` or a test; settle location at build)
   and the `docs:check` package script *(package.json — infra-owned, coordinate)*.
5. **Apply the AGENTS.md edits** above *(infra-owned; PM ratification of this plan
   is the human-led approval)*.

## Shape (AGENTS.md)

**(a) ONE complete feature in one PR.** Build order: reconcile board ← frontmatter →
strip frontmatter → guard → AGENTS.md/TASKS.md prose. No partial slice; the guard is
meaningless until the board is the sole source.

## Acceptance criteria

- No active plan file contains frontmatter; each is pure design.
- Every plan's status/priority is on the `docs/TASKS.md` board and nowhere else
  (grep: no `^status:` / `^priority:` in active `docs/plans/*.md`).
- `docs:check` goes **red** then green for: (a) a `TASKS.md` link to a plan that was
  moved to `archive/`; (b) an active plan with no board reference.
- The `security-settings` / `file-attachments` drift classes are now either
  structurally impossible (no second source to diverge) or CI-detectable (dangling
  link).

## Collision result

Checked 2026-06-13: `gh pr list` empty. Touches `AGENTS.md`, `package.json`,
`docs/TASKS.md`, and every active `docs/plans/*.md` — all main-agent / infra-owned;
no dev branch in flight contends. Coordinate only if a dev plan opens against
`package.json` before this lands.
