---
status: draft
priority: P3
owner: relixiaobo
created: 2026-06-05
updated: 2026-06-05
---

# Composition Rhythm — cross-surface foundation tokens (Layer 1)

The 2026-06-04/05 design-system review found that the three primary content
surfaces — the **outliner** document pane, the **agent transcript/dock**, and
**settings** — share a strong token spine (one ink base, one `--fill-*` ladder,
one glass-rail construction) yet diverge at the level of *composition*: the same
conceptual element (a reading column, a list row, a section title, a floating
menu) is built three different ways with three unrelated magic numbers. This plan
is the **Layer-1 (CSS-only) foundation** for the UI-quality roadmap: it adds the
shared rhythm tokens and aligns one stray menu, so the Layer-2 primitives
(button/input/feedback) and the consumers above them derive from one source
instead of re-inventing geometry (A7 — foundation before consumers).

Source reports: `tmp/ui-review/F-content-surface-composition.md` (composition) and
`tmp/ui-review/H-cross-surface-coherence.md` (coherence). Roadmap +
boundary contract: `docs/plans/ui-quality-roadmap.md`.

This plan is **CSS-only** (token declarations + re-pointing existing call sites at
those tokens). It introduces no new mechanism, no TSX, no protocol change. It is
the head of the dependency chain, not a consumer of it.

## Goal

Establish, as tokens in `tokens.css`, the cross-surface composition primitives the
three surfaces should derive from, and route the surfaces at them where doing so
is zero-behaviour-change CSS:

1. **A shared reading-measure token** — name the outliner's established 720px
   comfortable measure as `--reading-max`, and bound the two currently-uncapped
   prose columns (agent prose, settings content) so no surface stretches text
   unboundedly. (F#1)
2. **A row-height tier** — name the 26 / 22 / 40 split as an explicit ladder
   (`--row-h-dense` / `--row-h-compact` / `--row-h-comfortable`) so the outliner
   row, agent tool row, and settings inset row pull from a deliberate scale
   instead of three hard-coded numbers. (F#2)
3. **Text-gutter alignment tokens** — name the per-surface left reading gutters
   (42 / 18 / 12) as a documented set so the cross-surface relationship is
   visible and tunable in one place, even where the values legitimately differ.
   (F#3)
4. **A shared section-title / heading scale** — express the per-surface heading
   sizes (24 / 18 / 13) as steps derived from one named scale so "this is the
   title of what you're looking at" has a single source. (F#5, H#3/#4)
5. **Unify the list-row idiom** — make the three list rows share one
   hover-vs-current rule; the headline fix is the **agent session row**, which
   today uses `--control-hover` for BOTH hover and the current session, so a
   hovered row and the active session are indistinguishable. (F#2, H#1)
6. **Make the outliner context menu join the glass-menu family** — the
   `.node-context-menu` / `.tag-context-menu` / `.batch-tag-selector` are the only
   opaque, `--radius-md` (8) menus in an app where every other menu is
   `--material-popover` glass at `--radius-overlay-sm` (10). Route the *container
   surface* through the shared recipe. (H#2)

The unifying principle: **one token, many derivations.** Where a value genuinely
differs by surface (gutter depth, row density), the difference becomes an explicit,
named, documented choice rather than three independent literals.

## Non-goals

Per the boundary contract (`ui-quality-roadmap.md` → "Boundary contract"), this
plan **references but does not own**:

- **Text-button shape / fill / size**, including the `ConfirmDialog` buttons,
  danger-hover, and the 30px button height. → **`button-primitive`** owns all of
  it. Report H#5 (confirm-dialog buttons diverge) is logged there, not here.
- **Accent-focus neutrality** (the agent-subagent textarea accent leak). →
  **`design-system-consistency` §3**.
- **The command-palette / confirm-dialog overlay radius** bump (8 → 10). →
  **`design-system-consistency` §2**. (This plan handles ONLY the outliner
  context-menu family's opaque→glass + radius move, which the contract explicitly
  assigns here as "the whole element.")
- **The `--surface-inverse` primary-button language**, secondary `--fill-2`,
  empty-state idioms, input/select styling, nested-card radius unification — owned
  by `button-primitive` / `feedback-states` / `input-primitive` respectively
  (H#5/#6/#7).
- **No change to the 16px/26px content type metric** — it is the one solid
  cross-surface anchor the reports say to keep; we only touch heading sizes and
  geometry, never the body ramp.
- **No spec rewrite of `docs/spec/design-system.md` in this PR** — it is gated
  behind PR #118 (see Collision check). The spec update is a fast-follow once #118
  lands; this PR ships the tokens + a pointer comment.

## Design

Token reference (current, `src/renderer/styles/tokens.css`): `--space-1..8` =
2/4/6/8/10/12/–/16; `--space-lg` 24; `--space-xl` 32. `--font-content` 16px /
`--line-content` 26px. `--font-meta` 12px / `--line-meta` 18px. `--font-ui-sm`
13px. `--font-panel-title` 24px / line 32. `--font-heading-lg` 18px. Radius
ladder at tokens.css:311-325 (`--radius-md` 8, `--radius-overlay-sm` 10).

### D1 — Shared reading-measure (`--reading-max`)

**Problem (F#1).** Three unrelated body measures, only one capped:

| Surface | Current measure | Cap source |
|---|---|---|
| Outliner | **720px** | `--panel-content-max: 720px` (tokens.css:344); applied at `canvas.css:134` (`.panel-inner width: min(100%, …)`) and repeated as `max-width: 720px` literals in panel.css:15,44,71,85,90 + `breadcrumb.css` |
| Agent prose | **none** → ~308px at default rail, grows to ~484px at `--agent-max-width: 520px` | `.agent-assistant-content max-width: 100%` (agent-message.css:181); `.agent-chat-scroll` pads `--agent-content-x` (panel.css:15 / agent-transcript.css:15) |
| Settings content | **none on `origin/main`** → ~540px+, grows with the window | `.settings-content` (settings-providers.css:74) has no `max-width` on `main` |

**Target.**

1. Add `--reading-max: 720px` to tokens.css, documented as "the comfortable prose
   measure; the outliner's established 720 is the canonical value." Re-point
   `--panel-content-max` at it (`--panel-content-max: var(--reading-max)`) so the
   outliner is unchanged byte-for-byte but now derives from the shared name. The
   five `max-width: 720px` literals in `panel.css` and the one in `breadcrumb.css`
   stay as-is in *this* PR (they are correct; converting them to
   `var(--panel-content-max)` is a tidy-up that can ride a later sweep — flagged in
   the checklist, not load-bearing).
2. Agent prose: the agent column is already bounded by `--agent-max-width: 520px`
   (the rail can't exceed it), so prose never reaches `--reading-max`. **No agent
   width change** — the agent column is self-limiting and intentionally narrow
   (chat, not document). We record this as a deliberate non-change (see Decisions
   deferred → agent measure).
3. Settings content: **this is the one uncapped-and-growing column.** It needs an
   upper bound so a stretched window doesn't produce an over-long settings line.
   **However, PR #118 already adds `--settings-content-max-width: 920px` +
   `width: min(100%, …)` to the settings content** (confirmed in
   `origin/codex/settings-macos-clarity`, settings-providers.css). So this plan
   does **not** edit the settings width — it instead, *after #118 lands*, either
   (a) re-points #118's `--settings-content-max-width` at a shared token, or
   (b) leaves 920 as the deliberate "settings is a wider utility surface than a
   reading column" value and documents that in tokens.css next to `--reading-max`.
   Recommended default: **(b)** — settings is not prose; 920 is a reasonable
   utility cap and forcing it down to 720 would crowd the 2-col field grids. The
   token comment names both values so the relationship is explicit.

Net CSS change in *this* PR for D1: add `--reading-max`, re-point
`--panel-content-max` at it, add the explanatory comment. Settings width is owned
by #118; agent width is a documented non-change.

### D2 — Row-height tier

**Problem (F#2, H#1).** "A row" is three heights with no shared token:

| Row | Current height | file:line |
|---|---|---|
| Outliner doc row | `min-height: 26px` | outliner.css:844 (`--content-control-height`/`--line-content` = 26) |
| Sidebar nav/tree row | 28px (`--control-size-xl`) | tokens.css:292; sidebar.css |
| Agent tool / thinking row | ~22px (2px pad on 18px `--line-meta`) | agent-tool-rows.css:150,201,253 |
| Agent session row | `min-height: 54px` (two-line) | agent-dock.css:298,316 |
| Settings inset row | `min-height: 40px` | settings-inset-list.css:54 |

**Target.** Add a named ladder to tokens.css:

```css
/* List-row height tier — the deliberate density steps across surfaces.
   Dense = the outliner/sidebar line-locked row; compact = the agent tool/
   process register; comfortable = the System-Settings inset row. A surface
   picks a step on purpose instead of hard-coding 26/22/40. The two-line
   agent session row derives comfortable + a line (it is intentionally tall). */
--row-h-dense: 26px;        /* outliner doc row, line-locked to --line-content */
--row-h-compact: 22px;      /* agent tool/thinking register */
--row-h-comfortable: 40px;  /* settings inset row */
```

Re-point the call sites that are a pure rename (zero visual change):

- `.row { min-height: var(--row-h-dense) }` (outliner.css:844 — was 26px).
- `.inset-row { min-height: var(--row-h-comfortable) }` — **owned by #118's
  settings-*.css; defer this one edit behind #118** (see Collision check). On
  `main` it is `min-height: 40px` (settings-inset-list.css:54).
- Agent tool rows currently express height via `padding: var(--space-1) 0` on an
  `--line-meta` line, not a `min-height` — leave the padding form as-is (changing
  it to `min-height` would be a behaviour change, not a rename) but **document
  `--row-h-compact` as the canonical value the padding produces** so a future
  refactor has the target.
- Sidebar's 28px stays `--control-size-xl` (it is a *control* box, not a list-row
  density step — keep that distinction; do not fold it into this tier).

The point of D2 is to **name the tiers and converge the two that are pure
renames**, not to force the heights equal. Whether settings rows *should* be 1.5×
the outliner is a real design question deferred below (Decisions deferred → row
density), but the token makes the gap an explicit choice.

### D3 — Text-gutter alignment

**Problem (F#3).** The left reading gutter differs ~3× and each surface computes
it from local geometry:

| Surface | Left gutter | Source |
|---|---|---|
| Outliner | 28px column inset + 42px row leading → body text ~70px in | `--panel-content-x: 28px` (tokens.css:338); `--row-leading-width: 42px` (tokens.css:385) |
| Agent | 18px | `--agent-content-x` (tokens.css:279-281 = dock-inset 8 + composer-corner 6 + space-2 4) |
| Settings | ~12px card pad | `.inset-row-main padding: var(--space-2) var(--space-4)` (settings-inset-list.css:83) |

**Target.** These gutters legitimately differ — the outliner's 42px holds a
chevron+bullet affordance; the agent's 18px reproduces the composer's text inset;
settings' 12px is a flush card. Forcing them equal would break each surface's
internal logic (and the reports flag the inconsistency as *cross-surface awareness*,
not a bug to flatten). So D3 is **documentation-as-token**, not a value change:

Add a grouped comment block in tokens.css near `--row-leading-width` that names the
three as one family and states each is intentionally derived from its surface's
affordance, with the cross-surface relationship spelled out:

```css
/* ── Text reading gutters (cross-surface, intentionally tiered). The x-offset
   from a surface's column edge to where BODY TEXT starts. They differ by design
   — each is its surface's affordance width — but are grouped here so the
   relationship is one source, not three local accidents:
     outliner = --panel-content-x (28) + --row-leading-width (42) ≈ 70px
       (chevron + bullet gutter; the deepest, an editable outline)
     agent    = --agent-content-x (18)  (mirrors the composer text inset)
     settings = inset-row text pad (--space-4 = 8, inside a flush card)
   Do NOT flatten these to one value; converge only within a surface. ── */
```

No call-site change. The existing tokens already exist; this only co-locates and
documents them. (Within the agent rail the title/transcript/composer already
share `--agent-content-x` — that is the good pattern; the comment names it.)

### D4 — Shared section-title / heading scale

**Problem (F#5, H#3/#4).** The "name of what you're looking at" is 24 / 18 / 13px
across surfaces, with no shared step:

| Role | Size | Token / file:line |
|---|---|---|
| Outliner page title | 24px/32 weight 600 | `--font-panel-title` (tokens.css:32-33); panel.css:55-57 |
| Agent markdown h1 | 18px/26 | `--font-heading-lg` (tokens.css:29-30); agent-markdown.css |
| Agent dock title button | 14px/400 | `--font-ui-md`; agent-dock.css:185-194 |
| Settings group/section header | 13px/600 | `--font-ui-sm`; settings-inset-list.css:25-27, settings-base.css:90-96 |

**Target.** The sizes themselves are *mostly* justified (the doc title is a real
editable H1; settings headers are list-section captions). The fix the reports ask
for is a **named scale these derive from**, so the relationship is legible and a
future surface picks a step instead of a number. Add to tokens.css:

```css
/* ── Section-title scale — the "name of what you're looking at" ladder. One
   source for the surface/section heading role so 24/18/13 read as three STEPS,
   not three accidents. Body stays --font-content (16) — never a heading step. ──
   --title-display : --font-panel-title (24)  outliner page title (editable H1)
   --title-section : --font-heading-lg  (18)  a large section / markdown h1
   --title-group   : --font-ui-sm       (13)  a list-section caption (settings) */
--title-display: var(--font-panel-title);
--title-section: var(--font-heading-lg);
--title-group: var(--font-ui-sm);
```

These are **aliases** onto the existing font tokens — zero visual change. Re-point
only the safe, non-#118 call site:

- Agent markdown h1 → `--title-section` (agent-markdown.css) — a rename.
- Outliner title may reference `--title-display` (panel.css:55) — a rename; low
  risk but optional, flag in checklist.
- **Settings headers (`--title-group`) are in #118-owned settings-*.css → defer
  the rename behind #118.**

Two real questions ride this and are deferred (see Decisions deferred): (a) whether
settings should adopt a *large* heading anchor (it currently has none above 13px),
and (b) lifting the agent dock title weight 400→600 (H#3). Both are
behaviour-visible and belong to the surface owners (settings → #118; agent dock
title weight is a one-line follow-up) — D4 ships only the scale tokens + the safe
renames.

### D5 — Unify the list-row idiom (hover ≠ current)

**Problem (F#2, H#1).** Three row systems with three hover/selection rules:

| Row | Hover | Current/selected | file:line |
|---|---|---|---|
| Outliner doc row | **transparent** | inset bordered `::before` frame (`--row-selection-bg` + border, `--radius-row`) | hover outliner.css:851-853; frame 859-871 |
| Agent session row | `--control-hover` | **`--control-hover`** (SAME as hover) + name weight 500 | agent-dock.css:304-307,338-340 |
| Settings inset row | **no fill** (hover reveals trailing affordance) | flat `--selection-bg`, no border | settings-inset-list.css:88-94 |

The headline break is the **agent session row**: hover and "current" are the
identical `--control-hover` tint (agent-dock.css:304-307), so the active session is
visually indistinguishable from a row the cursor happens to be over. The only
differentiator today is the name going weight 500.

**Target.** Pick **one selection treatment** and make hover ≠ current. The reports
recommend the System-Settings flat-`--selection-bg` fill as the most native
selection treatment (H#1). The minimal, lowest-risk convergence this plan ships:

- **Agent session current row → `--selection-bg`** (the settings flat-fill
  treatment), keeping hover as `--control-hover`. Result: hover is a light tint,
  current is the stronger neutral selection fill — now distinguishable, and the
  current row carries the same selection treatment settings uses.

  ```css
  .agent-session-row:hover { background: var(--control-hover); }      /* unchanged */
  .agent-session-row.is-current { background: var(--selection-bg); }  /* was --control-hover */
  ```

  `--selection-bg` = `--fill-3` (0.10) vs `--control-hover` = `--fill-2` (0.07), so
  the current row reads one step heavier than hover — exactly the intended
  hover<selection relationship. Keep the 500 name weight as a secondary cue.

- Outliner doc rows keep their bordered-frame selection (it is the document's
  multi-select / focus affordance and is load-bearing for keyboard nav — *not* a
  list-pick). Do **not** flatten it. The reports' "one selection treatment" target
  is about list-pick rows (session/settings/sidebar), not the document grid.
- Settings inset rows already use `--selection-bg` (the canonical treatment) — no
  change (and it's #118-owned regardless).

So D5's one CSS edit is the agent session `.is-current` line. This is the single
change the reports call out as the highest-value list-row fix (H#1: "make the agent
session row stop using `--control-hover` for BOTH hover and current").

### D6 — Outliner context menu → glass-menu family

**Problem (H#2).** Every menu in the app is translucent glass at
`--radius-overlay-sm` (10) — agent session menu (agent-dock.css:259-264, the
recipe: `--material-popover` + `--material-backdrop` + `--shadow`), model menu,
settings row menu, command palette. The outliner's three menus are the lone
exception — opaque `background: var(--bg)` at `--radius-md` (8):

| Menu | Current surface | file:line |
|---|---|---|
| `.node-context-menu` | `--radius-md` (8), `background: var(--bg)`, `box-shadow: var(--shadow)` | outliner.css:2239-2249 |
| `.tag-context-menu` | `--radius-md` (8), `background: var(--bg)` | outliner.css:2229-2237 |
| `.batch-tag-selector` | `--radius-md` (8), `background: var(--bg)` | outliner.css:2314-2322 |

The menu *rows* already match — `.node-context-item` is `min-height: 30px`
(outliner.css:2251-2262), the same as `settings-row-menu-item`. Only the
**container surface** is off-family.

**Target.** Route the three containers through the shared glass recipe:

```css
.node-context-menu,
.tag-context-menu,
.batch-tag-selector {
  border-radius: var(--radius-overlay-sm);          /* was --radius-md (8) */
  background: var(--material-popover);              /* was var(--bg) (opaque) */
  -webkit-backdrop-filter: var(--material-backdrop);
  backdrop-filter: var(--material-backdrop);
  /* box-shadow: var(--shadow) stays — already the menu shadow */
}
```

`--material-backdrop` carries the `prefers-reduced-transparency` /
`prefers-contrast` opaque fallback for free (a11y.css swaps it in one place — see
the tokens.css:85-91 note), so no per-menu fallback block is needed (B5/B8). The
`.batch-tag-selector` has `overflow: hidden` already (outliner.css:2317), fine with
the new radius; `.node-context-menu` has `overflow-y: auto` (2244) — backdrop-filter
on a scroll container is fine. Verify the menus' inner search inputs / separators
still read on glass (they use `--surface`/`--border` tokens — should be fine, but
this is a light+dark visual-verify item).

This is the H#2 fix verbatim and is explicitly assigned to this plan by the
boundary contract ("context-menu OPAQUE→glass + radius alignment (whole element) →
composition-rhythm").

## Decisions deferred

Open questions with a recommended default; escalate only the directional ones.

1. **Canonical `--reading-max` value — 720, or a small named set?**
   *Recommended default:* **720** (the outliner's established measure) as the single
   `--reading-max`; settings keeps its own wider utility cap (#118's 920) because it
   is a control surface, not prose; the agent stays self-limited by
   `--agent-max-width: 520`. So one prose token (720) + two documented exceptions,
   not three reading widths. *Escalate?* No — reversible, and 720 is already the
   shipped value.

2. **Does settings adopt a large heading anchor?** Settings today tops out at 13px
   (`--font-ui-sm`); it has no display title (the rail names the pane). *Recommended
   default:* **no large heading in this plan** — D4 only ships the `--title-*` scale
   tokens; whether settings grows a `--title-section`-sized pane heading is a
   settings-surface design call that belongs to #118 / a settings follow-up, not a
   foundation token PR. *Escalate?* Surface to the PM as a one-line note when #118
   lands; it is taste, not foundation.

3. **Agent dock title weight 400 → 600 (H#3).** Reads as a label, not a header.
   *Recommended default:* **defer to a tiny agent-dock follow-up** — it is a
   one-line `font-weight` change but it is behaviour-visible chrome polish, off the
   foundation-token critical path. Not in this PR's scope (this PR is tokens +
   renames + the two targeted fixes D5/D6).

4. **Row-density convergence (settings 40 vs outliner 26).** Should settings rows
   really be 1.5× the outliner? *Recommended default:* **keep the gap, name it.**
   D2 ships `--row-h-*` tokens so the difference is an explicit step; converging the
   actual heights is a separate, visible redesign that needs the PM's eye and the
   settings owner. *Escalate?* No — the tokens are the reversible foundation; any
   height change is a later, separate decision.

5. **Should the agent prose column gain an explicit `--reading-max` reference even
   though it's self-limited?** *Recommended default:* **no** — adding a redundant
   cap below the existing `--agent-max-width` bound is noise. Document the
   non-change in the tokens comment instead.

6. **Cross-surface paragraph gap for 16/26 prose (F#8: 10px agent vs 1px outliner).**
   *Recommended default:* **out of scope** — the outliner's line-locked 1px is its
   document idiom and the agent's 10px is its chat idiom; F itself calls this
   "partly intentional." No shared paragraph-gap token in this plan.

## Collision check

Ran `gh pr list` + scanned `docs/TASKS.md` + the roadmap boundary contract +
grepped the intended files against open-PR scopes on 2026-06-05.

**Open PRs:** #119 (`cc/incremental-projection`, perf — core/types + renderer
state; **no CSS overlap**) and **#118 (`codex/settings-macos-clarity`)**.

**#118 is the live collision.** It owns `settings-*.css`, `controls.css`, and
`docs/spec/design-system.md`, and — confirmed by diffing
`origin/codex/settings-macos-clarity` — it already:
- adds `--settings-content-max-width: 920px` + `width: min(100%, …)` to
  `.settings-content` (settings-providers.css). → **This plan does NOT touch the
  settings content width** (D1). After #118 merges, reconcile (default: leave 920
  as a documented utility cap distinct from `--reading-max`).
- owns `.inset-row` (the 40px `--row-h-comfortable` rename, D2) and the settings
  group/section headers (the `--title-group` rename, D4). → **Defer those two
  renames behind #118**; ship the tokens now, re-point the settings call sites in a
  fast-follow once #118 lands so we never double-edit settings-*.css.
- owns `design-system.md`. → **No spec edit in this PR.** The spec note describing
  the new `--reading-max` / `--row-h-*` / `--title-*` tokens and the context-menu
  glass move lands as a fast-follow after #118 (A6 — spec ⇄ code stay in sync, but
  serialized behind the file owner).

**This plan's exclusive scope (no overlap with #118 or #119):** `tokens.css` (the
new tokens — coordinate as an infra-ownership file but no concurrent claim on it),
`outliner.css` (D2 `.row` rename, D6 context-menus), `agent-dock.css` (D5 session
current), `agent-markdown.css` (D4 h1 rename), and the `--panel-content-max`
re-point in tokens.css. `tokens.css` is on the infra-ownership list — open this as
an isolated, small PR and let siblings rebase (it touches only additive token
declarations + comments + four re-points, so rebase cost is near zero).

**Boundary-contract overlaps (reference-only, by design):** button shape incl.
ConfirmDialog buttons → `button-primitive`; accent-focus → `design-system-consistency`
§3; command-palette/confirm-dialog overlay radius → `design-system-consistency` §2.
This plan touches none of those lines.

## Risks

- **`tokens.css` is an infra-ownership file** — concurrent edits cause rebase
  churn. Mitigation: additive only (new tokens + comments + four `var()` re-points
  that are byte-identical in output); ship as one small isolated PR; siblings
  rebase. Verify with `bun run typecheck` (CSS custom props don't typecheck, but
  the renderer build under `electron-vite` catches a malformed `var()`).
- **D6 glass on the context menus is the only behaviour-visible change** — opaque
  → translucent over document content. Risk: text on a busy outline could lose
  contrast through the blur. Mitigation: `--material-popover` is 0.80 opacity over
  `--material-backdrop` (the same recipe every other menu already uses against
  rails/content); the reduced-transparency fallback is automatic. **Light + dark
  visual verification required** (B11 / roadmap gate: UI diff → visual verify).
- **D5 changes the active-session affordance** — a user used to the old (identical
  hover/current) tint will now see the current session sit a step heavier. This is
  the intended fix, but verify the `--selection-bg` (0.10) current row still reads
  correctly against the session menu's glass background (agent-dock.css:262) in
  both themes.
- **Renames must be exact no-ops.** `--panel-content-max: var(--reading-max)` and
  `--row-h-dense: 26px` → `.row min-height` must compute to the identical pixel.
  Guard: the existing guard tests track real DOM/CSS (A6/B11) — run
  `bun run test:renderer` and any geometry guard; do not relax a guard to pass.
- **Deferred-behind-#118 work could rot** if #118 stalls. Mitigation: the tokens
  ship independently and are usable; the settings re-points are a 3-line
  fast-follow tracked in the checklist, not a blocker for this PR's value.

## Checklist

Build (this PR — independent of #118):
- [ ] tokens.css: add `--reading-max: 720px` + comment; re-point
  `--panel-content-max: var(--reading-max)` (D1).
- [ ] tokens.css: add `--row-h-dense/-compact/-comfortable` ladder + comment (D2).
- [ ] tokens.css: add the grouped text-gutter comment block near
  `--row-leading-width` (D3, doc-only).
- [ ] tokens.css: add `--title-display/-section/-group` scale aliases + comment (D4).
- [ ] outliner.css:844 — `.row min-height: var(--row-h-dense)` (D2 rename, no-op).
- [ ] agent-markdown.css — markdown h1 → `--title-section` (D4 rename, no-op).
- [ ] agent-dock.css:305 — split `.agent-session-row.is-current` off the shared
  hover rule; `background: var(--selection-bg)` (D5, the headline fix).
- [ ] outliner.css:2229-2249,2314-2322 — `.node-context-menu` / `.tag-context-menu`
  / `.batch-tag-selector` → `--material-popover` + `--material-backdrop` +
  `--radius-overlay-sm` (D6).

Verify:
- [ ] `bun run typecheck`.
- [ ] `bun run test:renderer` (+ any geometry/guard spec — do not relax to pass, B11).
- [ ] Visual verification light + dark: outliner context menu over content (D6);
  agent session list hover vs current (D5).

Fast-follow (after PR #118 merges — defer to avoid double-editing settings-*.css):
- [ ] settings-inset-list.css:54 — `.inset-row min-height: var(--row-h-comfortable)`.
- [ ] settings section/group headers → `--title-group` (settings-*.css).
- [ ] Reconcile #118's `--settings-content-max-width: 920px` with `--reading-max`
  (default: document 920 as the settings utility cap, distinct from prose 720).
- [ ] `docs/spec/design-system.md`: record `--reading-max`, the `--row-h-*` tier,
  the `--title-*` scale, and the context-menu glass move (A6).

Tidy-up (optional, any later sweep):
- [ ] Convert the `max-width: 720px` literals in panel.css:15,44,71,85,90 +
  breadcrumb.css to `var(--panel-content-max)` (cosmetic; not load-bearing).
- [ ] Agent dock title weight 400→600 follow-up (H#3, deferred D-decision 3).
