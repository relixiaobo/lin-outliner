# UI Quality Roadmap

Index + organizing logic for the UI-consistency work that came out of the
2026-06-04/05 design-system review. The deep findings live in
`tmp/ui-review/A…H.md` (gitignored working reports); each plan below distills its
report into actionable work. This file is the map and the **boundary contract**
(who owns what) so the plans don't double-edit the same lines.

Sequencing respects **A7 (foundation before consumers)** and the **≤2 significant
changes in the review queue** WIP cap: this is a backlog to pull from, not a batch to
ship at once. (Per-plan status lives in `docs/TASKS.md`.)

## The organizing logic — three layers + a verification pass

The findings sort cleanly by *engineering nature*, which also gives the build order:

**Layer 1 — Foundation (CSS-only tokens/shape).** Lowest risk; everything else
builds on it. Settle the shared mechanism first (A7).
- `design-system-consistency.md` — icon shape/fill, overlay radius, accent-focus
  neutrality, focus-visible, user-select, spacing/z-index, spec sync.
- `composition-rhythm.md` — cross-surface composition tokens: shared reading
  measure, row-height tier, text-gutter alignment, heading scale, list-row idiom,
  context-menu glass/radius alignment. *(new — from reports F + H)*

**Layer 2 — Primitives (TSX + CSS, migrate call sites).**
Component consolidation; consumes Layer-1 tokens.
- `button-primitive.md` — `<Button variant>`.
- `input-primitive.md` — `<Input>/<Textarea>/<Select>/<Field>`. *(new — report C)*
- `feedback-states.md` — `<EmptyState>/<ErrorState>` + outliner empty states +
  loading/skeleton policy + surface aborted turns. *(new — report B)*

**Layer 3 — Behavioral fixes (independent; some out-rank the cosmetics).**
Real bugs / a11y / semantics; can run in parallel with Layers 1–2.
- `responsive-robustness.md` — pane-crush, re-clamp on resize, indent cap,
  tag-bar overflow, width-aware breadcrumb. *(new — report D; highest user-impact)*
- `keyboard-a11y.md` — menu focus-trap/restore hook, context-menu keyboard,
  outliner tree ARIA, calendar grid, role fixes. *(new — report E)*
- `icon-semantics.md` — action↔icon collisions (Hash, unknown-tool, remove). *(new — report G)*

**Cross-cutting — `dark-mode-contrast-pass.md`** *(new — report A)*: a real
light+dark run to confirm the static contrast risks (0.30/0.16 text, status
colors, faint-on-material) and apply one-token `theme-dark.css` nudges. Runs
**after** Layer 1/2 land so it verifies the final state.

## Boundary contract (dedup — prevents double-editing)

| Finding | Owned by | NOT by |
|---|---|---|
| accent-focus leak (agent-subagent textarea) | `design-system-consistency` §3 | input-primitive (references only) |
| overlay RADIUS of command-palette / confirm-dialog (8→10) | `design-system-consistency` §2 | — |
| ALL text-button shape/fill/size incl. confirm-dialog buttons, danger-hover, 30px | `button-primitive` | composition-rhythm, design-system |
| thinking-level radius | `design-system-consistency` §1c | — |
| context-menu OPAQUE→glass + radius alignment (whole element) | `composition-rhythm` | design-system §2 |
| list-row idiom (3 ways), reading width, row-height, gutter, heading scale | `composition-rhythm` | — |
| dead "Pinned" section (`pinnedNodeIds` always `[]`) | existing `sidebar-pinned-nodes.md` | feedback-states (cross-ref only) |
| empty/loading/error idioms + outliner empty states + skeleton policy | `feedback-states` | — |
| all text-input/select/textarea styling, placeholder, disabled | `input-primitive` | — |

## Dependencies & sequencing

- **Settings baseline (settings-macOS-clarity).** That work reshaped
  `settings-*.css` / `controls.css` / `design-system.md`, so the settings-touching
  waves (button Wave 2, input-primitive's settings-field migration, `design-system.md`
  spec edits) are not gated behind it — they fold into each plan's own PR (re-grep
  against `main`).
- **Pull `responsive-robustness` first** — independent, all 7 bugs verified real,
  highest user-impact.
- **Recommended order:** (1) Layer-3 bugs that don't touch the cosmetic layers can
  start immediately — `responsive-robustness` and `keyboard-a11y` are the highest
  user-impact. (2) Layer-1 `composition-rhythm` tokens before Layer-2 primitives that
  consume them. (3) Primitives + settings-touching waves (no longer gated by the
  settings baseline). (4) `dark-mode-contrast-pass` last. (5) `icon-semantics` anytime
  (small, isolated).
