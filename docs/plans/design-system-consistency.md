---
status: draft
priority: P3
owner: relixiaobo
created: 2026-06-04
updated: 2026-06-05
---

# Design-System Consistency Sweep

A CSS-only pass that closes the **semantic** consistency gaps a full design-system
audit surfaced — the class the regex guards (`typography-tokens.spec.ts`,
`cursor-affordances.spec.ts`, `window-material.spec.ts`) cannot catch: *"a token
is used, but the wrong rung / family was chosen."* No behavior, layout, or markup
changes — only `border-radius`, state `background`/`border-color`, `user-select`,
`:focus`→`:focus-visible`, and spacing tokens.

Supersedes the in-session `icon-control-consistency.md` draft (folded in as §1).

## Audit verdict (why this is small, not a rewrite)

The system is **healthy**. Everything machine-guardable passes, and every
semantic big-ticket axis is clean:

- **B1 color/hex** — zero raw rgb/rgba/hex outside `tokens.css` (verified).
- **B2 dark mode** — already pure `@media (prefers-color-scheme)`, zero
  `[data-theme]` (cleaner than the spec claims — see §9).
- **B5 material** — one central `a11y.css` swap covers all 14 materials under
  reduced-transparency / contrast.
- **B8 reduced-motion** — global `a11y.css` `*` rule covers all 46 transitions +
  6 animations, no gaps.
- **Elevation / z-index** — shadow tiers (menus level-1, dialogs/palette level-2,
  rails) and the `--z-*` ladder are correct.
- **Icons** — single library (lucide-react), token sizes, consistent stroke.

The drift is concentrated in radius/fill **choice**, one accent leak, and small
tokenization debt — all below.

## Goal

Every control/surface of the same KIND reads the same. Settle and enforce:

1. Icon-only chrome controls never wear a rounded-square fill (color-only, or
   pill when a state needs a fill).
2. Floating overlays of the same kind share one radius rung.
3. Functional states (hover/focus/active/selected) are always neutral — never
   brand accent.
4. Token discipline extends to spacing/`:focus-visible`/`user-select` where the
   guards don't reach.

## Non-goals

- Row/region controls (sidebar nav, tree rows, outliner rows, menu-item rows,
  calendar cells) — their neutral `--fill-*` hover/selection is correct.
- Switches, segmented, checkbox, select, chips, cards, message bubbles — compliant.
- Any `settings-*.css` / `controls.css` change — deferred to **PR #118** (codex
  settings-macOS-clarity) to avoid collision; the settings items found here are
  handed to #118 (see Collision).
- Blanket "snap every raw px" — spacing fixes are case-by-case (§7), so we never
  change deliberate content geometry.
- New tokens (we re-point existing ones); no glyph/icon-set swap.

## Design

### Shared policy (icon chrome)

| State | Treatment |
|---|---|
| Rest | No background; glyph at its resting color. |
| Hover / focus-visible | **Color-only** — deepen the glyph, no box. |
| Persistent (open / expanded / active / selected) | Fill allowed, but MUST be `--radius-pill` (circle/stadium), never `--radius-sm`/`--radius-row`. |
| Inline among plain-text peers (breadcrumb) | No rest fill — match the text crumbs. |

Reference-correct already: `.rail-toggle` (color-only), `.panel-breadcrumb-origin`
(single pill anchor).

### §1 — Icon-control shape & fill (P1/P2)

**1a. Icon chrome drawing a rounded-square fill → color-only / pill.**

| Control | File:line | Today | Target |
|---|---|---|---|
| `.panel-page-back-button` | breadcrumb.css:89 | r5, hover fill box | color-only hover |
| `.panel-breadcrumb-close` | breadcrumb.css:65 | r5, hover fill box | color-only hover |
| `.outline-panel-close` | canvas.css:96 | r5, hover fill box | color-only hover |
| `.panel-date-nav-button` | panel.css:100 | r6, hover fill box | color-only hover |
| `.panel-date-nav-today` (text+icon) | panel.css:125 | r6, hover fill box | color-only hover *(Q3)* |
| `.calendar-month-nav` | panel.css:188 | r6, hover fill box | color-only hover |
| `.search-query-refresh-button` | outliner.css:727 | r5, hover fill box | color-only hover |
| `.panel-title-more-button` | panel.css:270 | r6, **rest** fill + open | drop rest fill; open → pill fill |
| `.panel-date-picker-button` | panel.css:153 | r6, hover + expanded fill | hover color-only; expanded → pill fill |
| `.view-toolbar-pill` | outliner.css:275 | r5, hover/active/open fill | hover color-only; active/open → pill fill |
| `.typed-field-date-trigger` | outliner.css:1374 | r6, hover + expanded fill | hover color-only; expanded → pill fill |

**1b. Breadcrumb harmony.** `.panel-breadcrumb-ellipsis` (breadcrumb.css:173):
drop the rest fill → plain color-only marker, peer of the text crumbs.
`.panel-breadcrumb-origin` (breadcrumb.css:125): keep as the single anchor *(Q1)*.

**1c. Composer one-offs.** `.agent-approval-button` (agent-composer.css:152) r8
rounded-square → `--radius-pill` *(Q2)*. `.agent-composer-thinking-level`
(agent-composer.css:619) `--radius-md` → align to pill/menu rung *(Q2)*.

**1d. Color-only chrome — focus-ring radius (optional).** `.rail-toggle`,
`.agent-menu-button`, `.agent-dock-title-button`, `.field-value-affordance`,
`.workspace-tree-chevron-button` draw no box; only their `:focus-visible` ring
radius varies (5 vs 6). Harmonize to one token, or leave.

### §2 — Floating-overlay radius unification (P1)

The code already declares 10 (`--radius-overlay-sm`) canonical for menus/popovers
(comment at agent-composer.css:495), and session/model/settings/context menus all
use it. These three escape it:

| Surface | File:line | Today | Target |
|---|---|---|---|
| `.trigger-popover` / `.command-palette` | popover-command.css:6 | `--radius-md` (8) | `--radius-overlay-sm` (10) |
| `.confirm-dialog` | confirm-dialog.css:14 | `--radius-md` (8) | `--radius-overlay-sm` (10) *(Q5)* |
| `.agent-composer-file-preview-popover` | agent-composer.css:402 | `--radius-sm` (6) | `--radius-overlay-sm` (10) |

### §3 — Accent-on-focus neutrality (P1)

`.agent-subagent-followup textarea:focus` (agent-subagent.css:228) uses
`border-color: color-mix(--agent-accent 44% …)` + `outline: none` — the only
brand-accent leak into a functional state in the whole app. Replace with the
neutral `--focus-ring` / `--outline-focus` and make it `:focus-visible`.

### §4 — focus-visible coverage (P2)

Convert `:focus` → `:focus-visible` and add a neutral keyboard ring where missing:
`.field-name-input` (outliner.css:1082), `.typed-field-input` (outliner.css:1363),
`.node-description` (outliner.css:1860). *(Settings field inputs at
settings-fields.css:37 → deferred to #118.)*

### §5 — `user-select` on chrome (P2)

Add `user-select: none` to chrome headers that are currently selectable:
`.agent-subagent-tab` (agent-subagent.css:172). *(`.inset-group-header`
settings-inset-list.css:22 and `.agent-settings-section-header` settings-base.css:82
→ deferred to #118.)*

### §6 — Control radius choice (P2)

Folded into §1c (`thinking-level` → pill). No separate work.

### §7 — Spacing off-ladder micro-values (P3)

Genuine off-scale values (5 / 7 / 14 / 20 / 26 px) create micro-misalignment.
Case-by-case (NOT a blanket snap):
- Chrome/control micro-gaps that are clearly meant to be a ladder step → snap to
  the nearest `--space-*` (e.g. `5px`→`--space-3` 6, `7px`→`--space-4` 8 where it
  reads as a control gap): e.g. `.done-checkbox` margins (outliner.css:1880/1905),
  `.agent-process-timeline` (agent-tool-rows.css:136), `.agent-stream-caret`
  (agent-tool-rows.css:191).
- On-scale raw px that merely lacks the `var()` (e.g. `top: 8px` = `--space-4`,
  `margin-top: 12px` = `--space-6`) → tokenize opportunistically, no visual change.
- Deliberate content/positioning geometry (markdown list `padding-left: 20px`
  agent-markdown.css:44; toast inset `14px` toast-error.css; popover offsets) →
  leave, or introduce a *named* token with a comment — do NOT snap and shift it.

Each entry retired as touched; nothing here is allowed to change a visible
content measure.

### §8 — z-index tokenization (P3, lowest)

Outliner row pseudo-elements use raw `0`/`1` (outliner.css:865/875/913/924/939).
These are an *internal* stacking context below the ladder's floor (`--z-raised`
10), so they don't conflict — pure token hygiene. Either add a documented
`--z-row-internal` convention or annotate with a comment. Optional; skip if it
risks the selection paint order.

### §9 — Spec sync (A6)

- **B2 (dark mode).** `design-system.md` (and the AGENTS.md B2 one-liner) still
  describe `[data-theme]` + JS bridge as the interim mechanism. The code has
  fully migrated to `@media (prefers-color-scheme)` with zero `[data-theme]`.
  Update B2 to record the migration as **done**. *(AGENTS.md is an
  infrastructure-ownership / symlinked file — coordinate that one-line edit with
  the main agent; the `design-system.md` detail we own.)*
- **Icons.** `design-system.md` says "hand-curated inline-SVG set, no icon
  libraries"; the app uses lucide-react as the single set. Update the spec to
  bless lucide-react as THE set (and note the inline-ref hand-SVGs are stroke=2)
  *(Q6)*.
- Both `design-system.md` edits land **after** #118 (it also touches that file).

## Decisions (PM-ratified 2026-06-05 — all defaults below adopted)

- **Q1 — origin chip.** Keep `.panel-breadcrumb-origin` as the lone soft anchor
  (recommended), or flatten it to color-only too? *Default: keep.*
- **Q2 — composer one-offs.** `.agent-approval-button` → pill (recommended);
  `.agent-composer-thinking-level` → pill, unless it reads as a menu row. *Default:
  approval pill; thinking-level pill.*
- **Q3 — labeled chrome.** `.panel-date-nav-today` has a "Today" label (a small
  text button). Color-only hover (recommended) or a quiet pill fill? *Default:
  color-only.*
- **Q4 — hover policy.** Confirm: hover = color-only, persistent states = pill
  fill. Stricter alt = everything color-only (cleaner, weaker open-state cue).
  *Recommended: the hybrid.*
- **Q5 — dialog rung.** Does `.confirm-dialog` share the menu/popover rung
  (`--radius-overlay-sm` 10), or do true modal dialogs get their own larger rung
  (e.g. `--radius-lg` 12)? *Default: 10, matching the canonical overlay family.*
- **Q6 — icon set.** Bless lucide-react in the spec as the single set, or is
  there intent to move to hand-authored inline SVG? *Default: bless lucide.*

## Collision check

- **PR #118** (codex, `codex/settings-macos-clarity`) touches
  `settings-providers.css`, `controls.css`, `settings-base.css`,
  `settings-inset-list.css`, `settings-agents.css`, `settings-skills.css`,
  `design-system.md`. **Mitigation:** this plan excludes every settings/controls
  file (§4/§5 settings items deferred to #118); `design-system.md` edits (§9)
  land after #118 merges / rebase.
- `AGENTS.md` B2 one-liner (§9) is infrastructure-ownership — main-agent
  coordination, not a drive-by.
- No other open PRs. `floating-toolbar-polish.md` is a different component.
- **Files this plan will touch:** `breadcrumb.css`, `canvas.css`, `panel.css`,
  `outliner.css`, `agent-composer.css`, `agent-subagent.css`,
  `popover-command.css`, `confirm-dialog.css`, `agent-tool-rows.css`,
  `toast-error.css`, and `design-system.md` (+ the AGENTS.md B2 line, coordinated).

## Risks

- **Affordance regression** — color-only can weaken open/active cues; mitigated by
  keeping a *pill* fill for persistent states (Q4).
- **Visual-only change, easy to under-verify** — must check light + dark, hover +
  focus + open states, not just typecheck.
- **Spacing snapping** — never snap a value that shifts a visible content measure
  (§7 is case-by-case for this reason).
- **#118 / spec overlap** — sequence the `design-system.md` edits behind #118.

## Checklist

- [x] PM ratified (2026-06-05) — all defaults adopted. Build NOT yet started.
- [ ] Open `cc-2/design-system-consistency` Draft PR (scope = files above).
- [ ] §1 icon-control shape/fill (1a–1d).
- [ ] §2 floating-overlay radius → `--radius-overlay-sm`.
- [ ] §3 accent-on-focus → neutral `:focus-visible`.
- [ ] §4 `:focus`→`:focus-visible` (non-settings).
- [ ] §5 `user-select: none` on `.agent-subagent-tab`.
- [ ] §7 spacing off-ladder micro-values (case-by-case).
- [ ] §8 z-index tokenization (optional).
- [ ] §9 spec sync — `design-system.md` B2 + icons (after #118); AGENTS.md B2 line (coordinate).
- [ ] `bun run typecheck` + `bun run test:renderer` + guard suite (typography/cursor/material).
- [ ] Visual verify breadcrumb / panel header / date nav / view toolbar / command palette / confirm dialog, light + dark.
