---
status: in-progress
owner: cc
topic: settings-design-consistency
---

# Settings UI design-consistency pass

## Goal

Bring **every** Settings pane onto one design language and close the
design-system conformance gaps found in the 2026-06-04 audit. The Providers
pane was reworked onto the macOS System-Settings `inset-*` grouped-list idiom;
Permissions / Skills / Agent Profiles were never migrated, so the Settings
window currently reads as **two visual generations**. This plan unifies them and
fixes a small set of B3/B8 nits, so the whole Settings surface is consistent,
spec-conformant, and concentric.

Authority: `docs/spec/design-system.md` (B1–B11). The **Providers pane is the
reference** for the target look — do not re-style it; bring the others to it.

## Non-goals

- **Not** redesigning Settings information architecture (categories, what each
  pane contains, navigation) — only the shared visual primitives.
- **No** behavior / logic / protocol change. Pure renderer + CSS + spec.
- **Not** re-working the Providers pane, the provider-config window form layout,
  or the OAuth flow content — those are the canonical source; only adjust the
  small shared items called out below (sheet body-block radius, focus ring).
- **No** new tokens unless an item genuinely lacks one (prefer existing ladders).

## Background — what the audit found

The mechanical layer is clean: the `typography-tokens` guards (8/8) keep
tokenization / raw-hex / elevation honest; selection/hover/active are neutral
`--fill-*` (B3), no rose misuse, no hover scale (B7), the `⋯` trigger is a
circular color-deepen icon control (B6). The concentric **main chain is
correct**: window `--radius-window` 24 → settings rail `--panel-radius` 16
(= 24 − `--layout-gap` 8) → provider-window `inset-card` `--radius-lg` 12
(= 24 − `--space-6` 12).

The real issues are an **incomplete migration** plus a few polish items.

## Design

Two work items. **WI-1** is low-risk renderer polish (fast-track candidate).
**WI-2** is the pane migration (plan-track, user-visible).

### Guardrails — already canonical, DO NOT regress

- The Providers pane (`settings-providers.css` + `settings-inset-list.css`) and
  its `inset-group` / `inset-card` / `inset-row` primitive are the **target**.
- The concentric main chain (window 24 → rail 16 → card 12) is correct.
- **Control** radii are correct and not part of the concentric chain (B6):
  inputs / buttons / chips / avatars use `--radius-sm` 6 / `--radius-md` 8 /
  `--radius-pill`. Do not "concentric-ize" controls.
- Neutral selection/hover (`--selection-bg` / `--control-hover`), the circular
  `.settings-row-menu-trigger`, and the strong-neutral primary
  (`.agent-settings-primary` / `.settings-sheet-primary` = `--surface-inverse` +
  `--panel-bg`) stay as-is.

### WI-1 — conformance + polish (low-risk, renderer/CSS only)

**W1.1 — Danger-button hover is inconsistent (B3).**
`.agent-settings-danger:hover` (`settings-fields.css:191-193`) paints a status
fill `color-mix(in srgb, var(--status-danger) 12%, transparent)` on the hover
state, but the sheet's `.settings-sheet-danger:hover`
(`settings-provider-sheet.css:281-283`) hovers to neutral `--control-hover`.
Two danger buttons, opposite hover language. Per B3 (functional state is
neutral; status color carries status meaning, not hover) → make
`.agent-settings-danger:hover` use `--control-hover` to match the sheet. The
resting danger affordance stays the `--danger` text label.

**W1.2 — Missing keyboard focus rings (B8).** Three focusable controls set
`outline: none` with no `:focus-visible` ring:
- `.settings-sheet-row-input` (`settings-provider-sheet.css:119-124`) — the
  **API-key and base-URL inputs** in the provider-config window have *no*
  visible keyboard focus indicator.
- `.agent-profile-prompt-preview` textarea (`settings-agents.css:141-154`).
- `.agent-settings-field input/select` (`settings-fields.css:24-41`) uses
  `:focus` (not `:focus-visible`) and shows focus only via border+bg, no ring.

There is no global `input/textarea/select:focus-visible` fallback (only
`button:focus-visible` in `base.css`). Add a **shared** neutral
`:focus-visible` ring for text controls, reusing an existing focus token
(`--outline-focus` / `--focus-ring-shadow` — pick one and standardize; today
inset-row uses `--outline-focus`, checkbox uses `--focus-ring-shadow`, fields
use a `--focus-border` border-only treatment — consolidate to one focus
language). Respect `prefers-contrast` (B8).

**W1.3 — Provider-config window body blocks use three radii.** Inside
`.provider-config-window` (native 24 corner, `--space-6` 12 padding) the
same-level body surfaces disagree:
- `inset-card` (field group) = `--radius-lg` 12 (concentric with the window).
- `.settings-sheet-note` (`settings-provider-sheet.css:164`) = `--radius-md` 8.
- `.settings-sheet-oauth-*` step/code/connected blocks (`:320`, `:386`) = 8.
- `.settings-sheet-result` validation banner (`:180`) = `--radius-sm` 6.

Pick **one** radius for sheet content-block surfaces (see Q5) and apply it to
note / result / oauth blocks. Leave the inputs/buttons (control radii) alone.

**W1.4 — Dead CSS.** `.settings-provider-sheet`
(`settings-provider-sheet.css:27-37`, the old centered in-renderer modal card:
`min(520px…)` + `--overlay-shadow-level-2` + `--radius-md`) is no longer
rendered — the form now fills the native `.provider-config-window` (`:16`). No
TSX reference. Remove it (and any other now-unused `.settings-sheet-*` rules the
native-window move orphaned — verify each).

**W1.5 — `settings-connection.css` appears superseded.** Its `.connection-test-*`
/ `.settings-url-summary` connection-test feedback UI has **no renderer
reference** (validation now lives in `ProviderConfigForm` via
`.settings-sheet-result`). Confirm it is fully unwired, then delete the file
(and drop its `@import`/build reference). If any part is still used, fold it
into the `settings-sheet-result` treatment instead.

### WI-2 — migrate the legacy panes onto the `inset-*` idiom (plan-track)

`settings-inset-list.css`'s own header says "Providers is the first consumer;
Permissions / Skills can adopt it" — finish that. Today
(`AgentSettingsView.tsx`): Providers (`:672`) uses `inset-*`; **Permissions**
(`:698`) and **Skills** (`:758`) use bespoke `.settings-skill-row`
(`settings-skills.css:89`, a per-row bordered card); **Agent Profiles** (`:848`)
uses `.settings-agent-item-row` (`settings-agents.css:25`).

**W2.1 — List rows → `inset-*`.** Re-render Permissions, Skills, and Agent
Profiles row lists with `inset-group` / `inset-card` / `inset-row`
(+ `inset-row-leading` / `-text` / `-trailing`), deleting the bespoke
`.settings-skill-row` / `.settings-agent-item-row` card+border+gap styling.
Selection/hover/focus come from the primitive (neutral, inset focus ring).
Map each pane's row content onto the leading / label / sublabel / trailing
slots. Agent Profiles' master-detail selection uses `.inset-row.is-selected`.

**W2.2 — Section container model.** `.agent-settings-section`
(`settings-base.css:56`, a `--fill-1` card with `--space-6` padding) vs
`.settings-providers-section` (`settings-providers.css:91`, transparent, flat on
the content base). Decide one model (Q2) and apply to all panes so they share a
container language (the inset cards are designed to float on the flat base).

**W2.3 — Section header.** 4 panes render `.settings-section-title-row`
(`settings-skills.css:2`) = `<h3>` + `.settings-section-desc`; Providers omits
it deliberately ("the rail already names the pane"). Resolve the asymmetry (Q1):
either give Providers a title too, or drop the per-pane title everywhere and let
the rail name the pane. Apply uniformly.

**W2.4 — Sub-group headers.** `.inset-group-header`
(`settings-inset-list.css:22`) vs `.settings-subheading`
(`settings-skills.css:19`, an `<h4>`) — same size/weight, different
element/spacing. Standardize on `.inset-group-header` (primitive-backed) once
the panes use the primitive.

**W2.5 — Secondary buttons.** `.settings-sheet-secondary`
(`settings-provider-sheet.css:251`, 30px, bordered/ghost) vs
`.agent-settings-secondary` (`settings-base.css:115`, 28px, `--fill-2` filled,
no border). Pick one secondary language (Q3) and use it across panes and sheets.
Primary is already unified; danger after W1.1.

**W2.6 — Empty / loading states.** `.settings-empty-placeholder`
(`settings-skills.css:70`, dashed bordered box) vs `.agent-settings-empty`
(`settings-fields.css:202`, plain muted text). Standardize on one (Q4) for all
empty/loading states (Skills, Agents, top-level, provider window).

**W2.7 — Badges / tag chips.** Three geometries for the small status/tag chip:
`.settings-provider-badge` (`settings-providers.css:202`, `--radius-pill`,
letter-spaced uppercase), `.skill-source-badge` (`settings-skills.css:133`,
`--radius-xs`, `--control-hover`), `.agent-profile-tag` (`settings-agents.css:190`,
`--radius-xs` mono). Unify to one chip (radius + fill + casing).

**W2.8 — Notice / banner primitive.** `.settings-sheet-note` / `-result`
(neutral `--fill-*`, status color on text only — the B4-correct treatment) vs
`.agent-settings-alert` (`settings-fields.css:147`, danger color-mix tint).
Consolidate to the neutral-box + status-text-only treatment (B4). (Overlaps
W1.5.)

**W2.9 — Leading-mark convention.** Provider rows carry a 22px neutral
`.settings-provider-avatar` tile; skill/permission rows have no leading mark,
agent rows lead with a switch. Decide whether the migrated rows adopt a leading
tile (e.g. a status/kind glyph) or stay text-led; keep it consistent within the
`inset-row-leading` slot.

### Spec sync (A6, required)

Update `docs/spec/design-system.md` in the SAME PRs: record that the `inset-*`
primitive is the canonical Settings list idiom for **all** panes, and fold in
the resolved decisions (container model, header, secondary button, empty state,
badge, focus-ring token, sheet body-block radius). Guard tests track the real
DOM/CSS — extend/adjust `tests/e2e/typography-tokens.spec.ts` /
`workspace-layout.spec.ts` if a class they assert is renamed/removed.

## Open questions — RESOLVED (PM ratified 2026-06-04)

- **Q1 — Section title → drop the per-pane `<h3>` everywhere.** The rail names the
  pane (Providers model); a pane keeps a one-line muted `.settings-section-desc`
  intro where it helps.
- **Q2 — Container model → all panes flat-base + floating inset cards.**
  `.agent-settings-section` carries no `--fill-1` card; the inset cards float on the
  window base (the idiom the primitive was built for).
- **Q3 — Secondary button → filled `--fill-2`, no border**
  (`.agent-settings-secondary`); the sheet's `.settings-sheet-secondary` matches.
  The native push-button, pairing with the filled-strong primary.
- **Q4 — Empty state → plain muted text** (`.agent-settings-empty`, `+ .is-centered`
  for a detail pane); no dashed box.
- **Q5 — Sheet body-block radius → `--radius-md` 8** (the small-surface tier; only
  the validation banner was 6). Decided by the dev (reversible CSS local).
- **Q6 — `settings-connection.css` → fully dead, deleted.** Its `.connection-test-*`
  / `.settings-url-*` classes have no renderer reference (validation now lives in
  `.settings-sheet-result`). Verified by the dev.

## Sequencing

1. **PR-A (WI-1, fast-track):** W1.1–W1.5 — danger hover, focus rings, sheet
   body-block radius (needs Q5), dead-CSS removal (needs Q6 for W1.5). Renderer
   /CSS only, low blast radius. Gate: visual verification (light + dark) + token
   guards.
2. **PR-B (WI-2, plan-track):** the pane migration. Needs Q1–Q4 ratified.
   Consider splitting per pane (Permissions, then Skills, then Agent Profiles)
   to keep each PR small and reviewable. Gate: visual verification (light +
   dark) + token guards; one PR per pane merges within hours.

Keep WI-1 and WI-2 on separate branches (`cc/settings-polish-*` /
`cc/settings-inset-*`); unrelated concerns, separate PRs (AGENTS.md).

## Subtasks

- [x] PM ratifies plan + answers Q1–Q6 (2026-06-04).
- [x] **PR-A (#105):** W1.1 danger hover → neutral; W1.2 shared `:focus-visible`
      ring; W1.3 unify sheet body-block radius (Q5 → 8); W1.4 delete dead
      `.settings-provider-sheet` (+ verified no other `.settings-sheet-*` orphans);
      W1.5 remove dead `settings-connection.css` (Q6). Ready for gate.
- [x] **PR-B (#106):** all panes migrated in ONE PR (shared CSS lands once, more
      coherent to review than three near-identical PRs — deviates from the
      per-pane split the plan floated). Permissions / Skills / Agent Profiles /
      General → `inset-*`; container/header/secondary/empty/badge/banner per
      Q1–Q4 + W2.7/W2.8. `InsetRow` gained a `wrap` variant; toggles/selects moved
      to the trailing slot. Ready for gate (visual verified light + dark).
- [x] Folded decisions into `docs/spec/design-system.md`; adjusted
      `agent-settings.spec.ts` (the `<h3>` it keyed on is gone per Q1).
- [ ] **Main agent, post-merge:** merge #105 then #106 (rebase #106 after #105);
      flip this plan `done`; archive to `docs/plans/archive/`.
