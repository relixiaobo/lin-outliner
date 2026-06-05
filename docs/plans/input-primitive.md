---
status: draft
priority: P2
owner: relixiaobo
created: 2026-06-05
updated: 2026-06-05
---

# Shared `<Input>` / `<Textarea>` / `<Select>` / `<Field>` Primitive

A styled input primitive that mirrors `<Button>` and `IconButton`'s variant
approach, so every text field, textarea, and select derives its height, padding,
radius, border, background, placeholder, disabled, and focus from ONE source —
and future features can't re-drift. This is the **input analogue** of
`button-primitive.md`.

## Why (the audit) — root cause: "no styled input primitive"

Report `tmp/ui-review/C-input-form-system.md` found the inconsistency is
structural, not incidental. The three "primitives" in `ui/primitives/` —
`TextInputControl`, `NumberInputControl`, `SelectControl(plain)` — are **bare
passthroughs**: they forward props to a raw `<input>`/`<select>`, add
`aria-label`, and apply **zero styling and no className of their own**
(`TextInputControl.tsx:13-19`, `NumberInputControl.tsx:12-18`,
`SelectControl.tsx:24-29`). All visual styling comes from a className the
**caller** passes in, resolved against feature-local CSS. So "use the primitive"
buys nothing visually — every call site still hand-rolls its look. That is
exactly the same root cause `button-primitive.md` found for `ButtonControl`.

The result (verified against the code):

- **~18–27 distinct input/textarea/select treatments** in four incompatible
  families: bordered box, borderless/parent-styled, inline content-editor,
  date/time micro-input (+ native popup select).
- **Height splits ≥7 ways** for a single-line field: 24 / 26 / 28 / 30 / 32 /
  40px + content-line-height — there is **no `--input-height` token**, every
  family hard-codes its pixel height.
- **Three border tokens** among the bordered set — `--border` (`agent-settings`,
  `batch-tag`, `node-context`), `--border-subtle` (`view-toolbar`,
  `prompt-preview`, `subagent`), raw `color-mix(text 12%)` (search builder) —
  which resolve to visibly different strokes side by side.
- **Four mutually exclusive focus idioms** coexist even though `base.css:115`
  already gives every `input/textarea/select` a neutral `:focus-visible` ring:
  border-color swap, box-shadow ring, underline shadow, parent `:focus-within`
  ring. One field focuses with the **rose brand accent**
  (`agent-subagent-followup textarea:focus` → `--agent-accent`,
  `agent-subagent.css:228`), a B3/B4 violation.
- **Disabled is effectively unimplemented for text fields.** Only
  `select-popup-input` (opacity 0.45, `controls.css:159`) and the subagent
  textarea define a disabled look; every other field has **no `:disabled` rule**,
  so a disabled input is visually identical to an enabled one. A real functional
  gap, not cosmetics.
- **Placeholder color drifts ≥5 ways** (`--text-faint`/`--muted-2`,
  `color-mix(text 20%)`, `28%`, `color-mix(text-main 22%)`) and **8 fields have
  no `::placeholder` rule at all** — they fall back to UA-default grey, which
  does **not** track the theme and breaks in dark mode. There is **no global
  `::placeholder` rule** in `base.css` (confirmed) — only per-feature ones.

So the input case is **more warranted than the button one**: it removes a
genuine accessibility/disabled gap and a B3/B4 accent violation, not just visual
drift.

## Goal

1. Add `Input.tsx` (and matching `Textarea.tsx` / a restyled `Select` path /
   a `Field.tsx` label+control wrapper) to `src/renderer/ui/primitives/`, with a
   `variant` (and a `size`) axis; CSS targets `.input-{variant}` like
   `.icon-button-{variant}` / `.button-{variant}`. These supersede the bare
   `TextInputControl` / `NumberInputControl` passthroughs (keep the same
   `label` → `aria-label` contract; add the styling the passthroughs never had).
2. The primitive owns ONE canonical value for each axis: `--input-height`,
   `--input-pad-x`, `--input-radius`, `--input-border`, `--input-bg`, ONE
   `::placeholder` token, ONE `:disabled` method, and **focus = the neutral
   global ring only** (drop the border-color-swap idiom everywhere).
3. Migrate the hand-rolled boxed and bare fields onto it; delete the redundant
   feature-local CSS. Inline content-editors and date/time micro-inputs stay
   bespoke but **adopt the shared placeholder token** (the one low-risk axis they
   should share).

## Non-goals

- **The accent-focus leak fix** (`agent-subagent-followup textarea:focus` →
  `--agent-accent`, `agent-subagent.css:228`). That is owned by
  **`design-system-consistency.md` §3** per the roadmap boundary contract
  (`ui-quality-roadmap.md`). This plan **references** it: when the subagent
  textarea is migrated to the boxed-textarea variant (Wave 1), the accent focus
  is removed *for free* as a side effect — but the canonical neutral-focus
  decision itself lives in §3, and we coordinate ordering, not re-own the fix.
- **Composer pill capsules** — the `.agent-composer-input` lives inside a
  bespoke composer surface (pill geometry, parent frame). It stays bespoke. It
  *should* adopt the shared `::placeholder` token (it currently uses
  `--text-faint`, `agent-composer.css:321` — already close, so just point it at
  the canonical token).
- **The outliner ProseMirror / inline content editors** — `row-input`,
  `field-name-input`, `field-option-picker-input`, `typed-field-input`,
  `node-description`, `code-block-textarea`, and the date/time micro-inputs live
  inside the outliner's typographic grid; folding them into a generic field box
  would fight the row layout. They keep their bespoke focus (underline / parent
  frame) and geometry — but adopt the shared `::placeholder` token (today they
  use 4 different `color-mix` values over 2 base tokens; collapse to 1).
- **Checkbox / switch / segmented control / popup-select chrome** — already
  compliant primitives (`controls.css`); not text inputs, out of scope.
- **Redesigning the look** — adopt the *dominant* canonical per axis, not a new
  visual language.
- **The native popup `SelectControl(variant="popup")`** (`select-popup-input`,
  `controls.css:137`) — already a correct design-system control with its own
  disabled rule; left as-is (and its file is #118-owned). Only the *plain*
  `<select>` call sites (bordered box selects in settings / view-toolbar) fold
  into the `<Select>` boxed variant.
- **`settings-*` field migration in the FIRST PR** — deferred behind #118 (see
  Collision). The primitive + non-settings call sites land first.

## Design

### Variant + size taxonomy

Two variants (the two structural families that *should* unify) plus a size axis:

| variant | border | background | placeholder | disabled | focus | role |
|---|---|---|---|---|---|---|
| `boxed` *(default)* | `1px var(--input-border)` | `var(--input-bg)` | `--input-placeholder` | shared method | neutral global ring | labeled box field: settings, batch-tag, node-context, view-toolbar, definition, + boxed textareas |
| `bare` | `0` | transparent | `--input-placeholder` | shared method | parent frames it (ring suppressed; parent `:focus-within`) | input whose chrome is the parent row: composer-adjacent, launcher, command palette, session-title, sheet rows |

The `bare` variant keeps `border:0; background:transparent` but **inherits the
shared placeholder + disabled tokens**, so even chrome-less fields stop drifting
on the two axes that don't depend on the surrounding box. This is the report's
§4.1 recommendation.

`<Textarea>` is the same two variants with `height: auto; resize` and a
`min-height`. `<Select variant="boxed">` reuses the boxed shell (the *plain*
select call sites); the elevated popup select is untouched.

**Size axis** (applies to `boxed`; bare inherits its line-height from context):

| size | height | padding-x | role |
|---|---|---|---|
| `md` *(default)* | `--input-height` (canonical) | `--input-pad-x` | settings / batch-tag / node-context |
| `sm` | `--control-size-md` (24) | `--space-3` | dense view-toolbar popover row |

### Canonical token table (new; defined in `input.css`)

These are the single source for every axis; resolve to existing primitives so no
new raw values enter the system.

| token | value | replaces |
|---|---|---|
| `--input-height` | `--control-size-xl` (28) *(default — see Deferred)* | the 26/28/30/32/40 hard-codes |
| `--input-pad-x` | `var(--space-4)` (8) | `space-3`/`space-4`/`space-6` divergence |
| `--input-radius` | `var(--radius-sm)` (6) | `--radius-row` / `--radius-md` one-offs on box fields |
| `--input-border` | `var(--border)` | the `--border` / `--border-subtle` / `color-mix(text 12%)` split |
| `--input-bg` | `var(--fill-2)` | `--surface` / `--surface-soft` / `--fill-2` / `--bg-elevated` split |
| `--input-bg-focus` | *(none — focus is ring-only)* | the `--fill-3` focus-bg swap on settings |
| `--input-placeholder` | `var(--text-faint)` (= `--text-tertiary`, alpha 0.30) | the 20%/22%/28%/UA-default zoo (8 fields had no rule) |
| `--input-disabled-method` | `opacity: 0.45; cursor: default` | the "2 of 24 fields define it" gap; matches `select-popup-input` |

Focus: **neutral global ring only** (`--focus-ring-shadow`, already inherited
from `base.css:115-119`). The primitive does NOT re-declare a focus rule for
`boxed`; it just stops overriding the global ring. This kills the border-color
swap idiom (`--focus-border` on settings, `--border-emphasis` on definition,
`--focus-ring` on search builder, `--agent-accent` on subagent) in one move.

### Per-input migration table (file:line → collapse target)

Verified against the source. "Collapse target" = the primitive variant/size the
call site folds into. **Wave 1** = non-settings, ships with the primitive.
**Wave 2** = settings-fields/controls files (#118-owned), lands after #118.
**Token-only** = keep bespoke geometry, adopt the shared placeholder token.

| # | Selector | file:line | Today (height / border / focus / placeholder / disabled) | Collapse → | Wave |
|---|---|---|---|---|---|
| 1 | `.agent-settings-field input/select` | `settings-fields.css:24` | 32 / `--border` / border-swap+bg → `--fill-3` / none / none | `boxed md` | **2** |
| 2 | `.agent-settings-key-row input` | `settings-fields.css:60` | row 32 / 0 / parent `:focus-within` / none / none | `bare` (keep key-row parent) | **2** |
| 3 | `.batch-tag-input` | `outliner.css:2331` | 30 / `--border` / global ring / `--muted-2` / none | `boxed md` | **1** |
| 4 | `.node-context-search` | `outliner.css:2291` | 28 / `--border` / global ring / none / none | `boxed md` | **1** |
| 5 | `.view-toolbar-popover input/select` | `outliner.css:426` | 26 / `--border-subtle` / global ring / none / none | `boxed sm` | **1** |
| 6 | `.view-toolbar-date-input` (`type=date`) | uses #5 rule (`ViewToolbar.tsx:782`) | as #5 | `boxed sm` | **1** |
| 7 | `.definition-text-input` | `outliner.css:159` | 28 / transparent→`--border-emphasis` / border-swap+bg / none / none | `boxed md` | **1** |
| 8 | `.search-query-builder-textarea` | `outliner.css:628` | auto / `color-mix(text 12%)` / border+box-shadow / none / `:read-only`→`--muted` | `<Textarea boxed>` | **1** |
| 9 | `.agent-profile-prompt-preview` (readOnly) | `settings-agents.css:80` | 120 / `--border-subtle` / none / n/a / n/a | `<Textarea boxed>` (readOnly) | **2** *(settings-agents.css — see Collision)* |
| 10 | `.agent-subagent-followup textarea` | `agent-subagent.css:213` | 42–140 / `--border-subtle`→**`--agent-accent`** / **brand-accent border** / none / bg+color swap | `<Textarea boxed>` (removes accent focus — coordinate with `design-system-consistency` §3) | **1** |
| 11 | `.settings-sheet-row-input` | `settings-provider-sheet.css:107` | row / 0 / parent `:focus-within` `--outline-focus` / none / none | `bare` | **2** |
| 12 | `.agent-session-title-input` | `agent-dock.css:361` | 32 / 0 / global ring / none / none | `bare` | **1** |
| 13 | `.agent-user-edit-input` (textarea) | `agent-message.css:161` | 72 / 0 / none (card border) / none / none | `<Textarea bare>` | **1** |
| 14 | `.agent-composer-input` (textarea) | `agent-composer.css:305` | 32–160 / 0 / none / `--text-faint` / none | **token-only** (bespoke composer surface; point placeholder at `--input-placeholder`) | **1** |
| 15 | `.command-input` | `overlay-palette.css:19` | 40 / bottom-1px only / none / `--muted-2` / none | `bare` (keep bottom rule on palette container) | **1** |
| 16 | `.launcher-input` | `launcher.css:82` | auto / none / none / `--muted-2` / none | `bare` | **1** |
| 17 | `.row-input` | `outliner.css:1791` | line-height / 0 / none / `--muted-2` / none | **token-only** (inline editor) | **1** |
| 18 | `.field-name-input` | `outliner.css:1051` | control-height / 0 / none / `color-mix(text 20%)` / none | **token-only** | **1** |
| 19 | `.field-option-picker-input` | `outliner.css:1321` | control-height / 0 / parent / `color-mix(text 28%)` / none | **token-only** | **1** |
| 20 | `.typed-field-input` | `outliner.css:1343` | control-height / 0 / `--underline-focus-shadow` / `color-mix(text 28%)` / none | **token-only** (keep underline focus) | **1** |
| 21 | `.node-description` (textarea) | `outliner.css:1825` | auto / 0 / none / `color-mix(text-main 22%)` / none | **token-only** (note: uses `--text-main`, a *different base token*) | **1** |
| 22 | `.code-block-textarea` | `code.css:236` | sizer / 0 / none / n/a / none | **leave** (transparent caret-only overlay; no placeholder) | — |
| 23 | `.typed-field-date-date-input` | `outliner.css:1457` | auto / 0 / parent / `color-mix(text 28%)` / none | **token-only** | **1** |
| 24 | `.typed-field-date-time-input` | `outliner.css:1474` | min 32 / `--outline-faint`→`--outline-muted` / **box-shadow (hover==focus)** / `color-mix(text 28%)` / none | **token-only** (keep micro-input box-shadow; placeholder only) | **1** |
| 25 | `.select-popup-input` | `controls.css:137` | auto / 0 / popup chrome / n/a / **opacity 0.45** | **leave** (compliant popup select; #118-owned file) | — |
| 26 | `.view-toolbar-add-field select` | `outliner.css:503` | 24 / 0 / global ring / n/a / none | `boxed sm` *(or leave — toolbar bespoke; decide at build)* | **1** |
| 27 | `.agent-session-select` | `agent-dock.css:313` | `<button>`, not a field | **leave** (button, not input) | — |

**Collapse targets summary:**
- ~6 boxed text fields (#1,3,4,5/6,7,26) → `<Input boxed>`, 1 height / 1 border /
  1 focus.
- ~3 boxed textareas (#8,9,10) → `<Textarea boxed>` (removing the #10 accent
  breach for free).
- ~6 bare fields (#2,11,12,13,15,16) → `<Input/Textarea bare>`, standardized
  placeholder + disabled.
- ~7 inline/date editors (#14,17–21,23,24) → token-only: shared placeholder
  (4 `color-mix` values → 1).
- Net: **fixes two real defects app-wide** — no disabled state, and UA-default
  placeholders that break in dark mode.

### Spec sync (A6)

Add an "Input / Field" row to the Components table in `design-system.md`
documenting the variant/size taxonomy and the canonical tokens, next to the
`IconButton` / (incoming) `Button` entries. `design-system.md` is **#118-owned**
— this spec edit lands **after #118**, alongside the Wave-2 settings migration.

## Decisions deferred (defaults proposed; PM ratifies the one-pager)

- **Q-A — canonical `--input-height`.** Default **`--control-size-xl` (28)** — the
  densest common boxed value, on the {20,24,28} control ladder (collapses the
  off-ladder 30/32). Alternative: 30 (matches more current settings fields but is
  off-ladder, same problem the button audit flagged). *Default: 28.*
- **Q-B — single height vs sized.** Default **md (28) + sm (24)** so the
  view-toolbar popover row (currently 26) lands on an on-ladder 24 rather than
  forcing every boxed field to one height. Alternative: one size only (everything
  28; view-toolbar grows 2px). *Default: md + sm.*
- **Q-C — placeholder token.** Default **`--text-faint`** (= `--text-tertiary`,
  alpha 0.30 — the most common existing value, and theme-tracking). Alternative:
  introduce a dedicated `--input-placeholder` alias pointing at it (clearer
  intent, one more token). *Default: alias `--input-placeholder` → `--text-faint`
  so call sites read intent, not the raw faint token.*
- **Q-D — disabled method.** Default **`opacity: 0.45; cursor: default`** (matches
  the only existing field convention, `select-popup-input`). Alternative: a
  color-swap (`--surface-disabled` bg + `--text-disabled`) to match the *button*
  primitive's filled-disabled method. Opacity is simpler and survives the
  transparent `bare` variant; color-swap needs a fill the bare variant doesn't
  have. *Default: opacity for inputs (diverges from the button primitive
  deliberately, because bare fields have no fill to swap).*
- **Q-E — `<Field>` wrapper scope.** Default **yes, a thin `Field.tsx`**
  (label `<span>` + control + optional meta/error) matching the
  `agent-settings-field` shape, so the label/spacing also unifies. Alternative:
  ship only `<Input>/<Textarea>/<Select>` and leave the label wrapper per-feature.
  *Default: include `<Field>` but keep it minimal (no validation logic).*
- **Q-F — `<Input>` supersedes the bare passthroughs.** Default **fold
  `TextInputControl` / `NumberInputControl` into `<Input type>`** (one component,
  `type="number"` prop) and migrate their call sites; keep the `label` contract.
  Alternative: keep the passthroughs and add a sibling styled `<Input>`. *Default:
  supersede (one component), but this touches more call sites — confirm scope.*

## Collision check

Run 2026-06-05. `gh pr list` + `docs/TASKS.md` scan + grep of intended files
against open-PR scopes.

- **PR #118** (`codex/settings-macos-clarity`) owns `settings-base.css`,
  `settings-provider-sheet.css`, `settings-fields.css`, **`controls.css`**,
  `SelectControl.tsx`, `settings-agents.css`, and `design-system.md`.
  **Mitigation / boundary:**
  - **New CSS goes in a NEW `src/renderer/styles/input.css`**, *not* `controls.css`
    (which is #118-owned). The `.input-*` block + the canonical tokens live there.
  - **Wave 1** (this PR) touches only non-settings files: `outliner.css`
    (batch-tag, node-context, view-toolbar, definition, search builder, inline
    editors), `agent-subagent.css`, `agent-dock.css`, `agent-message.css`,
    `agent-composer.css`, `overlay-palette.css`, `launcher.css`, `code.css`
    (no-op), + the new `Input.tsx`/`Textarea.tsx`/`Field.tsx` and their call
    sites. None are infrastructure-ownership.
  - **Wave 2** (after #118 merges) migrates #1,2,9,11 (`settings-fields.css`,
    `settings-provider-sheet.css`, `settings-agents.css`) and adds the
    `design-system.md` Components row. `SelectControl.tsx` edits (if the plain
    select path is restyled) also wait for #118.
- **PR #119** (`cc/incremental-projection`) — core/IPC projection perf; **no
  overlap** with any input CSS or `ui/primitives` input files.
- **`button-primitive.md`** — sibling Layer-2 plan. Shares the *pattern* (variant
  primitive + new `*.css`) but **no file overlap**: buttons → `button.css`,
  inputs → `input.css`; disjoint call sites. The only seam is the subagent
  surface (button there is button-primitive's; the textarea there is ours) — same
  file `agent-subagent.css`, different selectors; sequence so they don't rebase
  on each other's uncommitted lines (coordinate via PR, land one then rebase).
- **`design-system-consistency.md` §3** owns the accent-focus neutrality fix
  (#10's `--agent-accent` focus). Our migration of #10 to `<Textarea boxed>`
  *implements* the neutral focus as a side effect. **Resolution:** if §3 ships
  first, our migration just confirms it; if we ship first, note in the PR that §3
  can drop #10 from its scope. Do not double-edit `agent-subagent.css:228`.

## Risks

- **Visual regression across many surfaces** — a primitive swap touches settings,
  batch-tag, node-context, view-toolbar, search builder, subagent, launcher,
  command palette, composer at once. Verify each in light + dark, all states
  (rest / hover / focus / disabled / read-only / placeholder-visible).
- **Bare-variant focus parity** — bare fields rely on a *parent* `:focus-within`
  ring (settings inset card, command palette, launcher row). The primitive must
  **suppress** its own `:focus-visible` ring for `bare` (as the current borderless
  fields do, `base.css:108-114` notes the clipped-inset case) so we don't get a
  double / clipped ring. Test the inset-card case specifically.
- **Height shift is visible** — collapsing 26/30/32 to 28 moves field heights a
  couple px; check it doesn't break view-toolbar row alignment or settings grid
  rhythm (the sm size for view-toolbar mitigates this).
- **Placeholder base-token swap** — #21 `node-description` uses `--text-main`, a
  different base than everyone's `--text`; pointing it at `--input-placeholder`
  slightly changes its alpha. Confirm it still reads in dark mode (this is the
  fix, but verify).
- **Behavioral parity** — preserve each call site's `onChange`/`disabled`/`aria`/
  `readOnly`/`type`; the migration is visual-token consolidation, not logic.
- **`<Input>` superseding passthroughs (Q-F)** widens the diff to every
  `TextInputControl`/`NumberInputControl` call site — keep that as its own commit
  so it can be reverted independently if scope balloons.
- **#118 sequencing** — Wave 2 + the `design-system.md` spec row must wait for
  #118; do not pre-touch its files.

## Checklist

- [ ] PM ratifies the one-pager (defaults Q-A…Q-F above). Build NOT started.
- [ ] Open `cc-2/input-primitive` Draft PR (first body line = file/area scope).
- [ ] `Input.tsx` + `Textarea.tsx` + `Field.tsx` in `ui/primitives/`; new
      `styles/input.css` with `.input-{variant}` / `--input-*` tokens (NOT in
      `controls.css`).
- [ ] Wave 1: migrate non-settings boxed (#3,4,5,6,7,26) + boxed textareas
      (#8,10) + bare (#12,13,15,16) call sites; delete the redundant CSS.
- [ ] Wave 1: token-only placeholder unification for inline/date editors
      (#14,17,18,19,20,21,23,24) → `--input-placeholder` (4 `color-mix` → 1).
- [ ] Confirm #10 migration removes the `--agent-accent` focus; note the overlap
      with `design-system-consistency` §3 in the PR.
- [ ] `bun run typecheck` + `bun run test:renderer` + e2e guard suite (token/hex
      guards, cursor-affordances, any focus-ring guard).
- [ ] Visual verify settings (Wave 2 preview) / batch-tag / node-context /
      view-toolbar / search builder / subagent / launcher / command palette /
      composer placeholder — light + dark, all states.
- [ ] Wave 2 (after #118): migrate settings fields (#1,2,9,11) + `SelectControl`
      plain path + add the `design-system.md` Components "Input / Field" row.
