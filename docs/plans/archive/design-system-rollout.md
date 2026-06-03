---
status: done
priority: P1
owner: relixiaobo
created: 2026-05-28
updated: 2026-06-03
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

Ordered by dependency. Each phase is one (or a small stack of) Draft PR(s) on a
`cc/<topic>` branch.

> ### Execution log (as shipped)
>
> Phase 1 (token foundation) shipped in **#55**. The remaining phases were then
> executed as **one in-clone agent team** on a single branch
> (`cc/design-system-implementation`) producing **one large PR** for the main
> agent to review — rather than the originally-floated separate-clone two-track
> split. The dependency order proved the components/shell were the gating
> concern, so the work ran as:
>
> - **P0 — modularize** `styles.css` (6851 lines) into 30 cascade-ordered
>   per-surface modules + an `index.css` barrel (byte-equivalent, brace-balanced;
>   pure move). This unblocked file-level parallelism for the migration.
> - **Token migration** — a read-only audit fanned out over the modules mapped
>   151 colour findings; 8 parallel per-module agents migrated `rgba`→alpha-on-ink
>   and `--primary*`→neutral `--fill-*`/`--focus-ring`; inline-ref blue→rose was
>   centralized at the token layer. Added `--text-on-accent`; neutralized the
>   confirm button; `--danger`→`--status-danger`.
> - **Alias cleanup + dark** — deleted the now-unused `--primary*` family;
>   `src/renderer/theme.ts` mirrors the OS colour scheme onto `[data-theme]`, so
>   dark follows the OS (single activation path; #45 extends it with a persisted
>   pref via `nativeTheme.themeSource`).
> - **Shell restructure** — dissolved `TopBar` into `WindowChrome` (fixed drag
>   strip + two centreline rail toggles) + per-pane breadcrumb headers; removed
>   the global tab strip/Back-Forward (sidebar is the switcher); floated the
>   sidebar/agent rails over a full-bleed opaque canvas; agent-seed unfurl.
>
> The phase write-ups below remain the rationale of record; the labels P0/token/
> alias/shell map onto Phases 1–4 here.

### Phase 1 — Token foundation (CSS-only; light active, dark gated)
- Introduce `--ink` + the semantic text/fill/separator/surface/material/accent/
  status tokens; define the dark palette (flip `--ink` + a few per-theme literals).
- **Dark is GATED, not auto-activated.** The dark block keys off
  `:root[data-theme='dark']`, *not* `@media (prefers-color-scheme: dark)`, and
  `color-scheme` stays `light` by default. Reason: the component layer
  (`outliner.css` + ~60 hardcoded glass/material `rgba()` in `styles.css`) is not
  theme-aware yet, so auto-dark on an OS-dark machine would be a broken half-dark
  regression. Light is the only active theme this phase ships.
- Map every legacy alias (`--deck-bg`, `--panel-bg`, `--text-main`, …) onto the
  semantic layer so components work unchanged. `--primary` stays a deprecated
  alias (still → accent); its usages are NOT yet neutralized here.
- **Why defer `--primary` neutralization to Phase 3:** recolouring buttons/active
  rows changes light visuals. Phase 1 lays the layer; Phase 3 flips functional
  state to neutral and deletes the alias.
- Live-token audit: classify each existing token as foundation / component-private
  / delete (the `--tab-*` set dies with the global tab strip in Phase 4).
- Verify: `bun run typecheck`, build, light renders normally, dark stays inert
  (no auto-activation on OS-dark).

> The dark-mode *target* (auto via `prefers-color-scheme` + nativeTheme override,
> as `design-system.md` describes) is reached only after Phase 3 makes components
> theme-aware. Until then dark is reachable only by explicitly setting
> `data-theme="dark"` (dev / Phase 2 plumbing), never automatically.

### Phase 2 — Chrome / material
- `main.ts`: `vibrancy: 'sidebar'` + transparent `backgroundColor`; wire
  `nativeTheme.themeSource` + a persisted theme preference (task #45). While dark
  is still gated (pre-Phase-3), the toggle drives the `data-theme` gate; the
  target wiring (themeSource → renderer `prefers-color-scheme`) lands when the
  gate is removed in Phase 3.
- `prefers-reduced-transparency` fallback: materials collapse to opaque seeds.
- NOTE: per-rail `--material-*` tints + `backdrop-filter` presuppose the floating
  rails, which are built in Phase 4 — so rail tinting moves there; Phase 2 does
  the window-level material + theme plumbing only.
- Verify: light unaffected; reduced-transparency degrades cleanly.

### Phase 3 — Component migration (neutral functional + overlay taxonomy)
- Make selection/hover/active/primary buttons neutral everywhere (kill residual
  rose/blue); confirm sparse rose only on links/caret/brand marks/status.
- **Delete the `--primary` alias** (deprecated in Phase 1): migrate every
  `--primary` / `--primary-soft` / `--primary-hover` / `--outline-primary` usage
  to the neutral `--fill-*` ladder + `--focus-ring`, and re-point
  `--inline-ref-*` off `--semantic-info` (blue) to `--link` (rose). See the
  Outliner impact notes.
- Apply the material-vs-overlay tiers: `MenuSurface` → `--material-popover`;
  `Dialog`/command palette → opaque `--bg-elevated`; clean up overlay borders.
- **Make the components theme-aware and UN-GATE dark.** Migrate `outliner.css` +
  the hardcoded glass/material `rgba()` in `styles.css` to the alpha-on-ink layer
  so dark is fully legible, then switch the gate from `[data-theme='dark']` to the
  target (`@media (prefers-color-scheme: dark)` + nativeTheme override) — this is
  what makes dark safe to ship.
- Light/dark screenshot matrix for outliner, panels, overlays, agent.

### Phase 4 — Shell / layout redesign (the big React restructure)
- `App.tsx`: full-height floating sidebar + agent rails over a full-bleed content
  base; content panes flush with 1px `--separator` (resize handle).
- `TopBar.tsx`: dissolve into the single top strip of per-pane breadcrumb headers
  + symmetric fixed rail toggles (sidebar top-left / agent top-right).
- Remove the global tab strip (sidebar becomes the switcher) and Back/Forward.
- Agent dock: right rail toggled by the fixed top-right control; header (`✦` +
  title) in the top strip.
- Traffic lights: `titleBarStyle` + `trafficLightPosition` aligned to the top
  strip via shared geometry constants; handle sidebar-collapse reflow.
- Verify: single / split / agent-open states; collapse; light + dark; keyboard
  parity; no regression in outliner editing.

## Outliner impact (migration notes)

The design system reskins the outliner's **colour + outer frame**; it does **not**
change the editing model or internal interactions. Node/tree model, the row grid
(`15/4/15/8`, `42px` leading), indentation, bullet/chevron, triggers (`/ # >`),
field rows, reference semantics, the keyboard model, and multi-select/drag are all
untouched (multi-select drag and field-value `Enter` are separate feature tasks,
not design-system work). Row radius `5px`, row height, and padding stay.

Concrete migrations the outliner needs (mostly Phase 3, recolour only):

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

Structural reframe (Phase 4 — changes the outliner's *frame*, not its tree):

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
- Phase 4 is a large restructure — keep it isolated from token/material PRs.
- This file's index row lives on `docs/TASKS.md` (the coordination-owned
  board); flag any status change for the main agent.
