---
status: draft
priority: P1
owner: relixiaobo
created: 2026-05-28
updated: 2026-05-28
---

# Design System Rollout (two-theme · materials · shell redesign)

## Why this plan exists

`docs/spec/design-system.md` was upgraded to describe the **target design
language**: a two-theme alpha-on-ink token system, a Liquid-Glass-inspired
material layer (approximated in Electron), neutral functional state with sparse
rose brand, and a floating-rails shell (full-height sidebar + per-pane headers +
no global tab strip + right-side agent toggle).

That document is the design contract; it intentionally describes the system as
designed, not what each release ships. **This plan tracks the gap to current code
and stages the work** so the spec and the code converge without the spec becoming
an implementation tracker. (Origin: a Codex review flagged that landing the whole
target into a `spec/` file at once would make the spec describe unbuilt behavior.)

Related: [`native-feel-remediation.md`](native-feel-remediation.md) — overlapping
native-feel work; the main agent should reconcile any duplicate scope on merge.

## Current state (the gap)

Measured on the `cc/native-sidebar-vibrancy` branch:

- `styles.css` has **no `--ink`** / no alpha-on-ink semantic layer. It has
  `color-scheme: light dark` and a first-pass dark `@media` palette that is *not*
  the `--ink` system, plus the legacy light tokens. Font stack leads with
  `-apple-system` but still includes Inter as a fallback.
- `main.ts` has a conditional `vibrancy: 'sidebar'` behind a `material` flag, but
  **no `nativeTheme.themeSource`** (no in-app light/dark/system toggle).
- Shell is still the old model: a full-width top chrome with a **global tab
  strip** and **Back/Forward**; sidebar and agent are flat grid columns, not
  floating rails; panes are card-ish, not flush hairline columns.
- `--primary` is a live rose alias used by many action/active/focus surfaces.
- Live tokens exist that the design doc doesn't enumerate (`--tab-*`,
  `--scrollbar-thumb`, `--panel-content-*`, `--inline-ref-*`,
  `--agent-side-panel-shadow`, `--overlay-backdrop`, `--font-ui-3xs`, …).

## Target

`docs/spec/design-system.md` in full. Each phase below folds its slice into the
spec as it lands (per the plans convention: a done plan's substance lives in
`spec/`).

## Staged delivery

**Phase 1 (token foundation) shipped in #55.** What remains is split into **two
parallel tracks that both depend only on Phase 1 and are otherwise independent**,
so they can run concurrently on separate clones. The original linear "chrome →
component → shell" order was mis-scoped: the #55 review showed dark depends on
component theme-awareness (not the token layer), and rail material + the theme
toggle depend on the shell — so the work regroups by dependency, not by concept.

Coordination boundary (the one shared file): **Track A owns the `styles.css`
token block + component colour usages + `outliner.css`; Track B owns the shell
layout CSS + the rail rules.** Avoid both editing the same rule; rebase on each
merge. Convergence points: Track B's rail material (B4) consumes Track A's
theme-aware tokens, and B5's theme toggle surfaces Track A's dark — whichever
lands first, the other rebases onto it.

### Phase 1 — Token foundation ✅ (shipped, #55)
`--ink` + the semantic layer; legacy aliases re-pointed; dark palette defined but
**gated** behind `:root[data-theme='dark']` (not auto-activated — `color-scheme:
light` default). `--primary` kept as a deprecated alias. Light renders normally;
dark is inert until Track A un-gates it.

---

### Track A — Component correctness → dark  (CSS/token sweeps; `cc/<topic>`)

One coherent migration **per surface** (single-touch: each surface PR does both
neutralization *and* theme-awareness, since both are just "use the token layer").
Dark stays gated until A5; each PR is verified in light + via the dev `data-theme`
gate in dark.

- **A1 — outliner.css** (#: the biggest surface): `--primary*` → neutral
  `--fill-*`/`--focus-ring`; hardcoded `rgba()` glass/text → alpha-on-ink tokens;
  inline-ref `--semantic-info` (blue) → `--link` (rose). Keep the row grid /
  editing model untouched.
- **A2 — agent surfaces**: chat/composer/message/tool CSS → token layer; neutral
  functional state.
- **A3 — menus / overlays / dialogs + primitives**: overlay taxonomy
  (`MenuSurface` → `--material-popover`; `Dialog`/palette → `--bg-elevated`);
  migrate primitive control CSS.
- **A4 — remaining `styles.css` hardcoded `rgba()` + fields/definition-config**;
  then **delete the `--primary` alias** once no usage remains.
- **A5 — un-gate dark + window material**: switch the gate from
  `[data-theme='dark']` to the target (`@media (prefers-color-scheme: dark)` +
  nativeTheme override); `main.ts` `vibrancy: 'sidebar'` + transparent
  `backgroundColor`; `prefers-reduced-transparency` fallback. Full light/dark
  screenshot matrix. **Deliverable: dark mode ships (follows OS).**

### Track B — Shell restructure → identity  (React; separate clone, e.g. `cc-2/` or `anti/`)

The big `App.tsx` / `TopBar.tsx` restructure to the floating-rails shell.

- **B1 — shell scaffold**: full-bleed opaque content base + floating sidebar &
  agent rails (rounded, inset, soft `--shadow-rail`); panes flush with 1px
  `--separator` + drag divider.
- **B2 — top strip**: dissolve `TopBar` into per-pane breadcrumb headers + the two
  symmetric fixed rail toggles on the shared centreline; remove the global tab
  strip (sidebar becomes the switcher) and Back/Forward.
- **B3 — agent dock + window chrome**: right rail toggled top-right with the
  agent-seed unfurl interaction; traffic-light geometry via shared constants;
  sidebar-collapsed chrome anchoring.
- **B4 — rail material**: per-rail `--material-*` tint + `backdrop-filter`
  (`--material-blur`/`--material-saturate`) + `rail-edge`; reduced-transparency on
  rails. (Consumes Track A's theme-aware tokens.)
- **B5 — theme toggle home**: `nativeTheme.themeSource` + persisted preference +
  the light/dark/system control in the new sidebar Settings (task #45).
  **Deliverable: the floating-rails identity + in-app theme switch.**

## Outliner impact (migration notes)

The design system reskins the outliner's **colour + outer frame**; it does **not**
change the editing model or internal interactions. Node/tree model, the row grid
(`15/4/15/8`, `42px` leading), indentation, bullet/chevron, triggers (`/ # >`),
field rows, reference semantics, the keyboard model, and multi-select/drag are all
untouched (multi-select drag and field-value `Enter` are separate feature tasks,
not design-system work). Row radius `5px`, row height, and padding stay.

Concrete migrations the outliner needs (Track A / A1, recolour + theme-aware):

- **Inline references go blue → rose.** Today `--inline-ref-default: var(--semantic-info)`
  (blue) in `styles.css`. The spec allows exactly one link colour: rose `--link`
  (or the first-supertag colour). Re-point `--inline-ref-*` off `--semantic-info`.
  This is the most visible outliner change.
- **Rose `--primary*` leaks go neutral.** `src/renderer/styles/outliner.css` uses
  `--primary` / `--primary-soft` / `--primary-hover` / `--outline-primary` in
  several spots (definition-config, field surfaces, drop-target indicators, etc.).
  Migrate each to the neutral `--fill-*` ladder + `--focus-ring`; some faint-rose
  fills/borders become grey. Done as part of deleting the `--primary` alias.
- **Row selection is already neutral** (`--row-selection-bg → --row-selected`,
  border `text 18%`) — verify it stays neutral; no blue/rose selection.
- **Dark mode** must be verified for the outliner specifically (alpha-on-ink
  inverts automatically, but it was never visually checked in dark before).
- **Hover/cursor discipline:** rows keep fill-on-hover; icon affordances
  (chevron, row controls) switch to colour-only feedback; no `cursor: pointer` on
  rows (inline references are real links and may keep the pointer).

Structural reframe (Track B — changes the outliner's *frame*, not its tree):

- The per-pane **breadcrumb header relocates into the single top strip**; the
  outliner's internal tree layout is unchanged but its header/container placement
  moves. Sticky-breadcrumb + title-dock behaviour is preserved.
- Panes become the flush opaque content base **under** the floating rails; outliner
  content gains padding to clear the rails; 1px `--separator` + drag divider
  between panes.
- Top-strip **Back/Forward is removed**; in-pane page history stays, driven by
  breadcrumb path segments (existing interaction).

## Coordination / risk notes

- Touches `App.tsx`, `TopBar.tsx`, `styles.css`, `main.ts`. Does **not** touch
  `src/core/types.ts` or `commands.ts` (no protocol change).
- **Two-track parallelism (the shared file is `styles.css`).** Track A edits the
  token block + component colour usages + `outliner.css`; Track B edits shell
  layout + rail rules. They should not edit the same CSS rule; whoever merges
  first, the other rebases. Track B is a large React restructure — keep it
  isolated from Track A's token sweeps.
- Suggested ownership: **Track A → `cc/`** (owns the token layer from #55, and the
  dark un-gate is the critical path); **Track B → a separate clone** (`cc-2/` or
  `anti/`) so the two run concurrently. Main agent assigns + sequences merges.
- `docs/plans/README.md` index row for this plan landed with #55 (coordination
  file).
