# Dark-mode Contrast Pass

The dark-mode token mechanism is sound — the static review (`tmp/ui-review/A-dark-mode-visual-risk.md`)
confirmed **no hardcoded hex outside `tokens.css` / `theme-dark.css`** (the only
`#…` in component CSS is a GitHub-issue number in a comment), every classic
invert-trap already carries an explicit fix (white tick on green via
`--text-on-accent`; `pm-highlight` forcing `color: inherit`;
`--status-success-strong` lifted for dark; the agent-dock
rail icons bumped off the 0.30 tier because 0.30 read "blurry" on the dark rail).
So this is **not** a mechanism change. It is a **visual confirm + nudge pass**:
run the app in both themes, eyeball the residual contrast risks the static review
could only *flag*, and where the run confirms a problem, apply a **dark-only,
one-token nudge** in `theme-dark.css` (or `tokens.css` where the issue is
theme-identical) — never per-site edits.

This pass **runs late**, after Layer 1 (`design-system-consistency`,
`composition-rhythm`) and Layer 2 (`button-primitive`, `input-primitive`,
`feedback-states`) land, so it verifies the *final* rendered state rather than an
interim one. The core deliverable cannot be fully specified statically — the
report's risk table is the **checklist of what to confirm on the real run**, and
the actual edits are decided at the keyboard with both themes open.

The fix shape is already proven twice in the repo:
- **`agent-dock.css` `.agent-menu-button`** — rail icons moved off `--text-faint` (0.30) onto
  `--text-secondary` (0.55) *because 0.30 read blurry on the dark rail*. This is
  the precedent and the canary: if icon strokes at 0.30 needed lifting, body text
  at 0.30 likely does too.
- **`a11y.css` `prefers-contrast: more`** — lifts the exact text tiers
  (`--text-tertiary` 0.30→0.52, `--text-quaternary` 0.16→0.38) and separators
  (0.10→0.32) via a single `:root` token redefinition. That block is the
  **template** for a dark-only lift: same tokens, same one-place redefinition,
  scoped to `@media (prefers-color-scheme: dark)` instead.

## Goal

- Run `bun run dev:cc-2` under both light and dark (in-app Settings › General ›
  Theme, and/or a dark OS) **after Layer 1/2 land**, and walk every surface in the
  report's "must-confirm" list.
- For each confirmed contrast/legibility problem, apply a **targeted, dark-only,
  single-token nudge** in `theme-dark.css` — mirroring the rail-icon precedent and
  the `a11y.css` lift template — so the whole alpha-on-ink system inverts the fix
  for free with no per-site CSS.
- Keep light mode untouched: alphas are theme-identical by design, so any nudge
  that would help dark but hurt light is scoped to the dark `@media` block, never
  pushed into the shared `:root`.
- Update `docs/spec/design-system.md` in the same change **only if** a token value
  actually moves (e.g. record a lifted dark text tier), per A6.

## Non-goals

- **No mechanism change.** The two-themes-over-one-ink model, the
  `@media (prefers-color-scheme)` driver, and the `a11y.css` override layer all
  stay exactly as they are.
- **No new hardcoded hex** outside `tokens.css` / `theme-dark.css`. Fixes are
  token redefinitions, not per-site color literals.
- **No per-site color edits.** If a single site genuinely needs a different ink
  level than its tier, that is a tier-assignment bug to flag, not a job for this
  pass — prefer moving the site to an existing tier over inventing a one-off.
- **No icon/control shape or fill work** (owned by `design-system-consistency` /
  `button-primitive`), **no text-input/placeholder styling** (owned by
  `input-primitive`), **no empty-state copy** (owned by `feedback-states`). This
  pass only touches color/contrast *values*.
- **No `settings-*.css` edits** (see Collision check) — status-color fixes there,
  if any, land as token nudges in `theme-dark.css`. (#118 is merged; its tokens —
  added `--inset-hairline`, routed through `--separator` — don't affect this pass's
  targets.)
- Not a WCAG-AA certification effort — the bar is "reads cleanly in the product on
  a real dark screen", judged by eye, consistent with the design system's
  perceptual-over-benchmark stance (A9).

## Design

### Fix mechanism (decided)

Every confirmed fix is one of two shapes, in priority order:

1. **Tier-level dark lift (preferred).** Add a token redefinition inside the
   `@media (prefers-color-scheme: dark)` block in `theme-dark.css`, e.g.
   `--text-tertiary: rgb(var(--ink) / 0.40)`. One line fixes every consumer of
   that tier in dark, light is untouched. This is the `a11y.css` template scoped
   to dark. Use for the high-volume text-tier and separator risks.
2. **Single-token dark literal lift.** For a per-theme literal already living in
   the dark block (status colors, materials), add/raise its dark value the way
   `--status-success-strong` → `#5fc88a` is already done. Use for status colors
   and any material/scrollbar adjustment.

A site-level edit is the fix **only** when the run shows a single misassigned tier
(a body label wearing `--text-quaternary`), and even then the edit is "move it to
the right existing tier", not "give it a custom color".

### Candidate risk table

The checklist for the run. Columns: token pair · usage evidence · static
reasoning · proposed nudge (if confirmed) · needs-visual-confirm. **Every row is
`needs-visual-confirm: yes`** — nothing here is applied without seeing it. Use
selector/token evidence instead of brittle `file:line` references; re-grep the
selectors at run time.

| Sev | Surface / where | Token pair | Usage evidence | Static reasoning | Proposed nudge (if confirmed) |
|---|---|---|---|---|---|
| S2 | code captions, agent/transcript meta, sidebar secondary, canvas hints | `--text-faint` = `--text-tertiary` (0.30 ink) | `code.css` captions/chrome, `canvas.css` hints, `agent-message.css` meta, `sidebar.css` secondary lines, `agent-transcript.css` meta | 0.30 ink ≈ 3:1 at best; rail icons were already moved OFF 0.30 (`agent-dock.css` `.agent-menu-button`) for reading "blurry" in dark. Highest-volume risk. | Lift `--text-tertiary` in the dark block, e.g. 0.30 → **0.38–0.42** (a11y `more` goes to 0.52; pick the smallest that reads). One line. |
| S2 | outliner dimmed bullet / placeholder + faint labels | `--text-quaternary` (0.16 ink) | `outliner.css` dimmed bullet / placeholder / faint label selectors | 0.16 alpha is far below AA in both themes; legible only as decoration. Confirm it isn't load-bearing copy in dark. | If load-bearing: lift `--text-quaternary` in dark, e.g. 0.16 → **0.22–0.26**. If purely decorative: leave. |
| S2 | settings success result line, other plain-success text | `--status-success` `#3f9e6a` (NOT lifted in dark) | `settings-provider-sheet.css` success/result selectors using `--status-success` | `theme-dark.css` lifts `--status-success-strong`→`#5fc88a` *expressly because the dark green read too dark*; the **plain** `--status-success` keeps `#3f9e6a` — the same too-dark green the lift fixed. | Add a dark `--status-success` lift in `theme-dark.css` (mirror the `-strong` lift), e.g. → **`#5fc88a`-ish mid green**. Token-only; does **not** touch `settings-*.css` (#118-safe). |
| S2 | validation warning glyph; danger reset/remove labels | `--status-warning` `#d99a1c` / `--status-danger` `#e5484d` (no dark lift) | warning/danger selectors in `outliner.css` and settings sheets | Amber on near-black usually OK; `#e5484d` red on `#1e1e1e` is borderline — confirm it doesn't muddy. | Only if confirmed muddy: small dark lift of `--status-danger` (and/or `-warning`) in `theme-dark.css`. Likely leave amber. |
| S2 | faint text inside open menus / popovers / sidebar | `--text-faint` (0.30) over `--material-popover` (0.72) / `--material-sidebar` (0.55) | captions in `agent-composer.css`, agent dock menus, `popover-command.css`, and sidebar menus | Text floor is *translucent*, so effective contrast is lower than nominal and varies with backdrop bleed-through. Captions in menus most at risk. | Largely **covered** by the `--text-tertiary` dark lift above (same token). If still weak, that is evidence the lift value should be a touch higher; do not special-case the menu. |
| S2 | keyboard focus ring on a *selected* inverse pill | `--focus-ring-shadow` (white 0.22 in dark) around control on `--surface-inverse` (`#e6e6ea`, light in dark) | `panel.css` selected calendar day and inverse-chip controls in settings / `agent-composer.css` | In dark the 2px outset ring is white but the selected pill is *light* → low ring contrast; keyboard focus may be invisible on selected items. | If confirmed: give selected-inverse controls a focus ring that reads on a light pill (a dark/ink-based ring scoped to the inverse-pill context), or have those controls use `--outline-focus` (ink-based) on selection. Decide at the keyboard — narrow, may be a single-rule fix rather than a token. |
| S3 | hairline dividers throughout | `--separator` = 0.10 ink | `--separator` consumers in `agent-tool-rows.css`, `agent-run-detail.css`, `code.css`, `agent-debug.css`, `settings-agents.css` | 0.10 white on dark is very faint; where it divides two near-equal dark surfaces it may vanish (no opaque fallback outside `prefers-contrast`). | If invisible where it matters: lift `--separator` in the dark block, e.g. 0.10 → **0.14–0.16**. One line. |
| S3 | editor `<mark>` highlight | `--highlight-mark` dark `rgba(120,100,30,0.55)` under `color: inherit` body text | `outliner.css` mark styling and `theme-dark.css` `--highlight-mark` override | Black-text trap already fixed (`color: inherit`); the olive-over-dark *fill* + inherited ~0.88 white text needs an eye for legibility/aesthetics. | If murky: adjust the dark `--highlight-mark` literal (lighter/less-olive) in `theme-dark.css`. Token-only. |
| S3 | launcher row bullet (a *filled dot*, not text) | `background: var(--text-tertiary)` (0.30) | `launcher.css` row bullet dot | A 5px dot painted with 0.30 ink: faint on the launcher's `--bg-elevated` in dark; small enough that low contrast hurts findability. | Auto-improves with the `--text-tertiary` dark lift. If still faint at dot size, that is a tier-assignment call (point the dot at `--text-secondary`) — flag, don't custom-color. |
| S3 | scrollbar thumb on translucent rails | `--scrollbar-thumb` 0.22 ink over `--material-*` | `base.css` scrollbar thumb token | 0.22 white thumb on see-through dark material — confirm it's visible at all before the 0.34 hover fade-in. | If invisible at rest: small dark lift of `--scrollbar-thumb` (e.g. 0.22 → 0.28) in `theme-dark.css`. |
| S3 | disabled labels/controls | `--text-quaternary` (0.16 ink) | disabled selectors in `breadcrumb.css`, `shell.css`, and `agent-composer.css` | 0.16 white on dark is near-invisible. Acceptable as "disabled", but flag any spot where a disabled value must still be *read*. | Tied to the `--text-quaternary` decision above. Likely leave at disabled-faint unless a disabled value must remain readable. |
| S3 (likely-OK) | drop shadows on dark floor | `--shadow-rail` / `--overlay-shadow-level-*` (deepened in dark) | shadow tokens in `tokens.css` and dark overrides in `theme-dark.css` | Dark shadow on near-black floor adds little; elevation reads via the lighter elevated *surface* step (`#2e2e30` vs `#1e1e1e`). | Confirm floating chrome still reads as raised. If flat: nudge the elevated-surface step, not the shadow. Probably no change. |
| S4 (likely-OK) | inverse-on-fill hover color flip | `color: var(--surface-inverse)` on `background: var(--control-hover)` | inverse-on-fill hover selectors in `agent-composer.css`, `code.css`, and related controls | Deliberate label flip; readable in both themes by construction. Listed only so the pass confirms the flip isn't jarring. | None expected. |

### What "done" looks like

- A short walk recorded in the PR body: surface · "reads fine" / "lifted X from a
  to b" — the ephemeral finding, not a committed doc.
- A diff that is, in the typical case, a handful of added lines inside the dark
  `@media` block of `theme-dark.css` (plus a `tokens.css` line only if a
  theme-identical value like `--separator` is lifted in both — which it should
  not be unless light needs it too).
- `docs/spec/design-system.md` updated **iff** a token value moved (A6).
- `bun run typecheck` + the guard tests green (the token/hex guard must still pass
  — fixes are token redefinitions, so it will).

## Decisions deferred (defaults if the PM doesn't weigh in)

These are taste calls best made with both themes on screen; recorded here with a
default so the pass isn't blocked.

- **How far to lift the 0.30 `--text-tertiary` tier in dark.** Default: the
  *smallest* lift that resolves the blur — start at **0.38**, go up toward the
  a11y `more` value (0.52) only if 0.38 still reads soft. Do not match `more`
  wholesale; that tier is meant to be quiet.
- **Whether to lift the 0.16 `--text-quaternary` tier at all.** Default:
  **leave it** (it is the disabled/decorative floor); lift only if the run finds a
  load-bearing label wearing it. Prefer re-tiering that one site.
- **Lift status colors globally vs per-use.** Default: **globally, in the token**
  — add a dark `--status-success` lift mirroring `-success-strong`, so every
  plain-success text site fixes at once and stays consistent with the already-
  lifted strong variant. Per-use color literals are out (would add hex outside the
  token files).
- **Separator / scrollbar / highlight nudges.** Default: lift only the ones the
  run shows are genuinely invisible *where it matters*; leave the rest. These are
  S3 — opportunistic.
- **Focus-ring-on-inverse-pill.** Default: narrowest fix that works — an ink-based
  focus ring scoped to selected-inverse controls — decided at the keyboard; do not
  change the global `--focus-ring-shadow` (that would weaken focus everywhere).

## Collision check

- Last refreshed 2026-07-01: no open PR currently claims this dark-mode contrast
  pass. The historical adjacent PRs #119 (cc/incremental-projection — core↔renderer
  projection protocol, no CSS) and #118 (codex/settings-macOS-clarity) are both
  merged; #118's tokens (added `--inset-hairline`, routed through `--separator`) don't
  affect this pass's targets.
- **Settings sites:** the report cites `settings-provider-sheet.css`
  plain-success text selectors and other `settings-*.css` sites. This pass's fix
  is a **token nudge in `theme-dark.css`** — it does **not** edit any
  `settings-*.css` regardless. Re-grep cited selectors against `main` (#118
  reshaped the settings CSS).
- **Sequence after Layer 1/2** (`ui-quality-roadmap.md`): this pass verifies the
  *final* state. Running it before `design-system-consistency`, `composition-rhythm`,
  `button-primitive`, `input-primitive`, `feedback-states` land would re-confirm a
  surface those plans then change. Pull this plan **last** (it is P3 and explicitly
  scheduled "(4) `dark-mode-contrast-pass` last" in the roadmap).
- **No overlap** with `design-system-consistency` (icon shape/fill, overlay
  radius, focus *neutrality*) — that owns focus-ring *neutrality*, this owns focus-ring
  *contrast on a specific inverse-pill context*; coordinate only if both touch the
  focus-ring token (they should not — that plan keeps it neutral, this scopes a
  context-specific ring).

## Risks

- **Over-lifting hurts light mode.** Alphas are theme-identical by design, so any
  lift placed in the shared `:root` would also brighten light, where these tiers
  already pass. **Mitigation:** every text-tier / separator / scrollbar nudge goes
  inside the `@media (prefers-color-scheme: dark)` block in `theme-dark.css`, never
  in `tokens.css` `:root`. Light mode tokens stay byte-for-byte unchanged. (Status
  colors and materials already live only in the dark block, so they are dark-only
  for free.)
- **Lifting the quiet tiers too far flattens the hierarchy.** The whole point of
  0.30/0.16 is a *quiet* label; pushing toward 0.55 erases the step from
  `--text-secondary`. **Mitigation:** smallest lift that resolves the blur; keep
  the inter-tier gap visible (secondary 0.55 must still read clearly above a lifted
  tertiary).
- **a11y override interaction.** `a11y.css` is `@import`ed AFTER `theme-dark.css`
  and re-redefines these tokens under `prefers-contrast`/`reduced-transparency`. A
  dark lift sits *below* it in source order, so the `more` block still wins when
  both match — verify the high-contrast path still reads correct after the nudge
  (it lifts further, so it will, but confirm no regression).
- **Token guard tests.** `theme-dark.css` is one of the two files allowed to carry
  literals; status-color hex there is fine. Confirm the renderer guard's exception
  set still covers any new line (it should — same file, same shape as existing
  lifts).
- **Line-number drift.** Layer 1/2 will move some cited `file:line`s. The table is
  a checklist of *tokens × surfaces*, not a patch — re-grep each token's consumers
  at run time rather than trusting the recorded line.

## Checklist — the light + dark visual walk (per surface)

Run `bun run dev:cc-2`, toggle Settings › General › Theme between Light and Dark
(and ideally also flip the OS appearance to confirm the no-JS-bridge path). Walk
in priority order; for each, note "fine" or the nudge applied.

- [ ] **Every 0.30 / 0.16 text site in dark** (risks 1, 2, 11): agent transcript
      meta, code-block captions, sidebar secondary lines, outliner dimmed bullet /
      placeholder, disabled labels. The rail-icon precedent is the canary.
- [ ] **Plain status colors as text in dark** (risks 3, 4): settings
      success/error result line, validation warning glyph, danger reset/remove
      labels. Specifically check `--status-success` `#3f9e6a` vs the already-lifted
      `-success-strong`.
- [ ] **Faint text inside open menus / popovers in dark** (risk 5): model menu
      caption, session menu, command popover, settings menus — text-over-glass.
- [ ] **Keyboard-focus a *selected* item in dark** (risk 6): tab to a selected
      calendar day / inverse chip; confirm the focus ring is visible on the light
      inverse pill.
- [ ] **Hairline dividers in dark** (risk 7): agent tool rows / run detail /
      debug / settings list separators where content meets elevated surface — do
      they read at all?
- [ ] **Editor `<mark>` highlight in dark** (risk 8): legibility of body text over
      the olive fill.
- [ ] **Launcher bullet dot in dark** (risk 9): findable at 5px?
- [ ] **Scrollbar thumb on a translucent rail in dark** (risk 10): visible at rest
      before hover?
- [ ] **Elevation read in dark** (risk 12): does a floating rail / menu still read
      as raised, or flat against the floor?
- [ ] **Re-walk LIGHT** after any dark nudge: confirm the light surfaces are
      byte-for-byte unchanged (no shared-`:root` leakage).
- [ ] **High-contrast + dark** (`prefers-contrast: more` under dark OS): confirm
      the `a11y.css` `more` lift still wins and reads correct over the new dark
      values.
- [ ] `bun run typecheck` + `bun run test:renderer` (token/hex guard) green.
- [ ] Update `docs/spec/design-system.md` iff a token value moved.
