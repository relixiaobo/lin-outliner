# Dark-Mode Contrast Verification

**Shape:** (a) ONE complete correction PR when verification confirms defects.
A clean walk is a complete verification-only result and requires no product PR.

## Goal

Run a light/dark product walk on one selected release candidate and fix
only contrast failures confirmed in the rendered application. The alpha-on-ink
theme mechanism is already correct, and #377 already lifted dark
`--text-tertiary` to its current value. The remaining work is evidence-driven
verification plus the smallest token-level corrections that the run proves are
necessary. The verification target is a named commit and finite surface set,
not eventual completion of every visual plan in the backlog.

## Non-goals

- No renderer theme bridge, `[data-theme]` selector, new palette, or theming
  mechanism.
- No speculative token movement based only on static ratios.
- No per-site raw colors, broad component restyling, icon changes, or layout
  work.
- No claim of WCAG certification; accessibility preference paths still require
  explicit verification.

## Design

### Requirements

- **FR-1:** Every candidate correction is preceded by a rendered light/dark
  comparison on the actual affected surface.
- **FR-2:** A repeated contrast failure is corrected at the narrowest semantic
  token authority; raw site colors are forbidden.
- **FR-3:** Reduced motion, increased contrast, and reduced transparency remain
  independently testable after every token change.
- **FR-4:** Release-gate evidence, and a correction PR when needed, records both
  unchanged confirmations and changed tokens so a quiet diff cannot masquerade
  as an incomplete walk.

### Verification order

At claim time, record the candidate commit and derive the surface inventory from
the shipped UI, changed consumers and current token usage. Include Settings
working states or new previews when present on that candidate; unimplemented
plans are not prerequisites. Each feature still supplies its own visual evidence.
Walk the same content in light and dark, then repeat the critical cases with
increased contrast, reduced motion and reduced transparency.

If another visual change lands before release, recheck its affected surfaces and
any shared tokens it changes. Do not restart the whole walk or silently add every
new backlog proposal. A clean walk is a valid verification result: record its
evidence at the release gate without manufacturing a token edit or an empty PR.

Confirm these current risks:

| Surface | Current token question | Allowed correction |
| --- | --- | --- |
| Load-bearing faint text and disabled labels | Does `--text-tertiary` / `--text-quaternary` remain readable without flattening hierarchy? | Reassign a mis-tiered site first; lift a dark tier only when several correct consumers fail. |
| Plain success, warning, and danger text | `--status-success-strong` has a dark lift while plain `--status-success` does not. | Adjust the dark status token, never a component literal. |
| Menus and captions over material | Does backdrop variation make faint text disappear? | Fix the shared tier or material token, not one menu. |
| Selected inverse controls | Is the neutral keyboard focus ring visible against the inverse fill? | Use a narrowly scoped neutral ring; do not weaken the global focus token. |
| Separators, scrollbar thumb, and mark highlight | Are quiet structural cues still perceivable? | Small dark token nudge only when the real run confirms failure. |
| Overlay elevation | Do menus and dialogs remain distinct from the dark content floor? | Correct the shared elevated-surface/material token before shadows. |

### Correction rules

1. A site wearing the wrong semantic tier moves to an existing token.
2. A repeated failure across correct consumers gets one dark token override in
   `theme-dark.css`.
3. A theme-independent failure changes the shared token only when both themes
   need it.
4. Raw color literals remain confined to token declarations, and every changed
   value is folded into the current design-system specification.

The PR body records the ephemeral walk as surface, result, and any token change;
the repository keeps only the resulting current behavior and spec.

### Verification

Cover Agent transcript and Settings metadata, launcher and menus, Outliner
empty/loading hints and disabled controls, selected keyboard-focused controls, status
messages, separators, scrollbars, highlighted text, chrome material, and both
menu/dialog elevation levels. Run the design guards and focused E2E visual
assertions after any token change.

## Acceptance Criteria

- **AC-1:** The PR body contains a result for every risk family in light, dark,
  and the applicable accessibility-preference paths.
- **AC-2:** Every changed color is a token declaration or a semantic reassignment
  to an existing token; component CSS gains no raw color.
- **AC-3:** Changed token values are reflected in the current design-system spec
  and all token/design guards pass.
- **AC-4:** Keyboard focus, status meaning, text hierarchy, and overlay elevation
  remain distinguishable after the smallest confirmed corrections.
- **AC-5:** The evidence identifies the verified commit and finite surface set;
  a later visual diff receives affected-surface verification. Zero confirmed
  failures requires no speculative product change.

## Open questions

None before the visual run. Exact numeric token changes are evidence-derived
implementation values: start with the smallest correction that preserves the
existing hierarchy and record the measured/rendered reason in the PR.

## Implementation checklist

- [ ] Select the candidate commit and regenerate its bounded surface queue from
      shipped consumers, the release diff and current token usage.
- [ ] Capture light/dark and accessibility-preference evidence for every risk
      family.
- [ ] Apply only confirmed token or semantic-tier corrections.
- [ ] Update the design-system spec for every changed token.
- [ ] Run typecheck, renderer/design guards, focused E2E, docs check, and diff
      check.
