---
status: draft
priority: P2
owner: relixiaobo
created: 2026-06-05
updated: 2026-06-05
---

# Shared `<Button>` Primitive

A styled text-button primitive that mirrors `IconButton`'s variant system, so
every primary/secondary/danger/ghost button derives its height, padding, radius,
fill, label color, disabled, focus, and transition from ONE source — and future
features can't re-drift.

## Why (the audit)

A deep button audit found the inconsistency is structural, not incidental:
`IconButton.tsx` has a 7-variant system, but `ButtonControl.tsx` is a
**zero-styling** `<button>` wrapper, so every feature hand-rolls its text buttons.
Result (verified):

- **~9 "primary" / ~5 "secondary" / ~4 "danger"** implementations.
- **Affirmative fill splits two ways** — dark `--surface-inverse`
  (agent-settings, settings-sheet, composer action) vs neutral `--fill-3`
  (confirm-dialog confirm, search-query-builder save).
- **Height splits** — inline `28` (`--control-size-xl`) vs modal `30` (8 sites:
  confirm-dialog, settings-sheet, subagent) — **30 is off the {20,24,28} ladder**.
- **Padding** `8` (composer) vs `12` (dialog/sheet).
- **Disabled three ways** — `--text-disabled` color, opacity (and the opacity
  itself varies: 0.38 / 0.4 / 0.45 / 0.5 / 0.55 / 0.7), or nothing.
- **Hover transition** present on 3 buttons, **absent on 15+** (instant change).
- **Font-weight** hard-coded `500` on 3, `inherit` elsewhere; label size split
  11 / 12 / 13.
- Small bugs: `.confirm-dialog-confirm.is-danger` has **no `:hover`** feedback;
  secondary "hover" doesn't deepen (`--control-hover` == `--fill-2` == rest).

NOT a finding (debunked): `.row-chevron-button` / `.row-bullet-button` suppress
their focus ring, but both are `tabIndex={-1}` (RowLeading.tsx:57/71) — mouse-only,
never keyboard-focused, so suppression is correct per B8.

## Goal

1. Add `Button.tsx` to `src/renderer/ui/primitives/` with a `variant` (and a
   `size`) axis; CSS targets `.button-{variant}` like `.icon-button-{variant}`.
2. The primitive owns: height, padding, radius, fill (rest/hover/active), label
   color, border, **disabled (one method)**, transition, font. Focus uses the
   existing global `button:focus-visible` ring.
3. Migrate the hand-rolled text-button classes onto it; delete them.

## Non-goals

- Icon-only buttons — `IconButton` already covers them.
- Composer pill capsules (`.agent-composer-action/tool/model-button`) and the
  full-width `.agent-approval-button` — bespoke geometry; at most they *consume*
  the variant color tokens, they don't collapse into `<Button>`.
- Switches / segmented / select / checkbox — separate primitives, compliant.
- Redesigning the look — we adopt the **dominant** canonical per role, not a new
  visual language.
- `settings-*` button migration was originally deferred behind #118; #118 is now
  merged (see Collision), so settings buttons are unblocked and may land in the
  same wave.

## Design

### Variant taxonomy + canonical tokens (recommended defaults)

| variant | rest bg | hover bg | label | border | role |
|---|---|---|---|---|---|
| `primary` | `--surface-inverse` | `--surface-inverse-strong` | `--text-on-accent` | none | affirmative / default action |
| `secondary` | `--fill-2` | `--fill-3` *(fix: actually deepen)* | `--text-secondary`→`--text-primary` | none | neutral secondary |
| `ghost` | transparent | `--fill-2` | `--text-secondary`→`--text-primary` | none | toolbar / inline / cancel |
| `danger` | transparent | `--fill-2` | `--status-danger` | none | inline destructive (restrained) |
| `danger` + `tone="solid"` | `--status-danger` | darken | `--text-on-accent` | none | rare modal destructive default |

**Shared geometry / behavior (all variants):**
- Height: `--control-size-xl` (28) — collapses the off-ladder 30 *(Q-B)*.
- Padding: `0 var(--space-6)` (12) for `size="md"` (default); `0 var(--space-4)`
  (8) for `size="sm"` (dense contexts: composer-inline, subagent) *(Q-D)*.
- Radius: `--radius-sm` (6) — genuine text buttons are "controls" (6), not pills.
- Font: `--font-ui-sm` (13) / weight `500`; `size="sm"` → `--font-ui-xs` (11).
- Disabled: ONE method — filled variants `background: --surface-disabled; color:
  --text-disabled`; ghost/text variants `color: --text-disabled`. Drop the
  0.38–0.7 opacity zoo.
- Transition: `background var(--motion-fast), color var(--motion-fast)` on every
  variant (fixes the 15+ instant ones).
- Focus: inherit the global neutral ring; no per-call override.

### Migration list (~18 classes)

**Wave 1 (this PR — non-settings):**
- `confirm-dialog-confirm` → `primary` *(or neutral — Q-A)*; `confirm-dialog-cancel`
  → `ghost`/`secondary`; `.is-danger` → `danger tone=solid` (and gains a hover).
- `launcher-actionbar-primary` → `primary`/`ghost`; `launcher-actionbar-item` → `ghost`.
- `search-query-builder-save` → `primary`; `search-query-builder-button` → `ghost`.
- `command-action-button` → `ghost`.
- `agent-subagent-send-button` → `primary size=sm`; `-stop-button` → `danger size=sm`;
  `-small`/`-transcript-button` → `ghost size=sm`.

**Wave 2 (settings buttons — #118 merged, gate OPEN; may collapse into Wave 1):**
- `agent-settings-primary`/`-secondary`/`-danger`, `settings-sheet-primary`/
  `-secondary`/`-danger`/`-cancel-test` → the matching variants.

**Adopt-tokens-only (keep bespoke geometry):**
- `agent-approval-button` (full-width) consumes `primary`/`secondary`/`danger`
  color tokens but keeps its width/inset.

### Spec sync (A6)

Add a "Button" row to the Components table in `design-system.md` documenting the
variant taxonomy and the canonical tokens, next to the existing `IconButton`
entry. #118 (which also edited that file) is merged, so this is unblocked.

## Decisions (PM-ratified 2026-06-05 — all defaults below adopted)

- **Q-A — primary fill in dialogs.** Should `.confirm-dialog-confirm` become the
  dark `primary` (so dialogs get the dark default button), or do confirm dialogs
  keep a quieter neutral affirmative (a `neutral` variant on `--fill-3`)?
  *Default: make it `primary`.*
- **Q-B — height.** Collapse the 30px modal family to 28 (`--control-size-xl`,
  on-ladder), or keep a documented 30 for modal buttons? *Default: 28.*
- **Q-C — danger strategy.** One `danger` (ghost + red text) + a `tone="solid"`
  for the rare modal destructive default — confirm this is the shape. *Default:
  yes.*
- **Q-D — size axis.** Is a two-step `size` (md 28/12, sm dense) enough, or do we
  need only one size? *Default: md + sm.*
- **Q-E — approval button.** Keep `.agent-approval-button` bespoke (adopt color
  tokens only), or fold it fully into `<Button>` with a full-width prop? *Default:
  bespoke, tokens only.*

## Collision check

- **PR #118** (codex, `codex/settings-macos-clarity`) — **MERGED.** Its actual
  scope was `design-system.md`, `controls.css`, `tokens.css`,
  `settings-agents.css`, `settings-base.css`, `settings-inset-list.css`,
  `settings-providers.css`, `settings-skills.css`, `AgentSettingsView.tsx`,
  `SettingsInsetList.tsx`, `SelectControl.tsx`, i18n messages, settings e2e — it
  did NOT touch `settings-provider-sheet.css` or `settings-fields.css` (the
  settings buttons `agent-settings-primary`/`-danger` and `settings-sheet-*` live
  in those two files, never in #118's scope). In `controls.css` #118 touched only
  `.segmented-control-option` and `.select-popup`, not any text buttons. **Status:**
  the gate is OPEN — Wave 2 + the `design-system.md` Components edit are unblocked
  and may collapse into one wave (the dev's call at build time).
- This overlaps the `design-system-consistency.md` plan only at the edges
  (that plan's §1c thinking-level + the small button one-offs). **Resolution:**
  the button one-offs (danger hover, missing transitions, 30px) are absorbed HERE;
  remove them from that plan's scope to avoid double-editing the same lines.
- New files: `src/renderer/ui/primitives/Button.tsx` + a `.button-*` block. #118
  (merged) touched only `.segmented-control-option`/`.select-popup` in
  `controls.css`, not text buttons, so there is no collision there; still, put the
  new block in a NEW `button.css` to keep the primitive self-contained.
- Wave-1 CSS files touched: `confirm-dialog.css`, `launcher.css`, `outliner.css`
  (search builder), `overlay-palette.css`, `agent-subagent.css`, + new `button.css`
  and the TSX call sites. None are infrastructure-ownership.

## Risks

- **Visual regression across many surfaces** — a primitive swap touches dialogs,
  launcher, search, subagent at once. Verify each in light + dark, all states
  (rest/hover/active/disabled/focus).
- **Behavioral parity** — preserve each call site's onClick/disabled/aria; the
  migration is visual-token consolidation, not logic change.
- **Scope** — resist absorbing icon buttons / pill capsules; they have their own
  correct primitive.
- **#118 sequencing** — RESOLVED: #118 is merged, so Wave 2 + spec edit are
  unblocked.

## Checklist

- [x] PM ratified (2026-06-05) — all defaults adopted. Build NOT yet started.
- [ ] Open `cc-2/button-primitive` Draft PR.
- [ ] `Button.tsx` primitive + `button.css` (`.button-{variant}`, `size`).
- [ ] Wave-1 migrate non-settings call sites; delete the old classes.
- [ ] Trim the absorbed one-offs out of `design-system-consistency.md`.
- [ ] `bun run typecheck` + `bun run test:renderer` + e2e guard suite.
- [ ] Visual verify confirm-dialog / launcher / search / command palette /
      subagent, light + dark, all states.
- [ ] Wave 2 (settings) + `design-system.md` Components row — #118 merged, may
      land in the same wave.
