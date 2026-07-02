# Tenon Design System Implementation

This file owns design-system maintenance, versioning, and validation rules. Start
at the [design-system kernel](../design-system.md) for product principles,
decision routing, exceptions, and validation.

## Implementation Rules

1. Product behavior remains authoritative.
2. Update the smallest owning design-system layer before or with UI changes that
   alter system contracts.
3. Use tokens before adding one-off values.
4. Add abstractions only when they remove real duplication or clarify ownership.
5. Keep component primitives thin. They should not absorb product behavior by
   accident.
6. Do not style fake preview panels as if they were shipped UI.
7. Keep reference snippets tokenized and source-backed. They may simplify
   examples but should not invent a second visual language.
8. When changing frontend behavior or visuals, run focused e2e coverage and
   update screenshots or specimens when useful.

## Versioning & Maintenance

- **Compression target.** The design system should stay a small set of reusable
  rules, not a growing surface encyclopedia. Use
  `bun scripts/design-system-metrics.ts --json` to inspect the current state and
  `bun scripts/design-system-metrics.ts --check` once the compression target is
  satisfied. The ratified target is: surface-specific contract lines are at least
  40% below the post-split baseline (`surfaces.md` <= 403 lines from a 672-line
  baseline); the sampled [decision audit](./decision-audit.md) proves at least
  80% derived decisions; component coverage is at least 80%; Exception Registry
  evidence coverage is 100%; raw hex outside token declarations stays 0.
- **Derivation audit.** For a new or changed UI, the PR must be able to answer
  four questions: which surface owns it, which component primitive or pattern it
  uses, which state-model row it maps to, and which foundation tokens carry its
  visual values. If the answer needs a page-local special case, either promote a
  reusable rule or add a named exception with evidence.
- **Tokens are the dev variables.** Two tiers: **foundation tokens** (the ones in
  Foundations — color, type, spacing, radius, elevation, motion) are the CSS
  custom properties in `src/renderer/styles/tokens.css` and are documented in
  [foundations.md](./foundations.md);
  **component-private tokens** (e.g. `--panel-content-*`, `--inline-ref-*`) may
  live in component CSS without a foundation entry, as long as they derive from
  foundation tokens. Add or rename a foundation token in
  [foundations.md](./foundations.md) in the same change that touches the CSS. The
  live token set is the source file; this spec explains the contract and should
  not inventory every component-private variable.
- **Naming:** tokens are semantic-role names (`--text-primary`, `--fill-3`,
  `--material-sidebar`), never raw-value names (`--gray-200`). Component contracts
  use the component name matching the source file.
- **Migration:** legacy aliases bridge old names onto the semantic layer; remove
  an alias once all usages migrate. Pre-launch, so no compatibility burden —
  cut over directly rather than keeping shims.
- **Change discipline:** the smallest owning design-system layer is updated
  before or with any UI change that alters a system contract (Implementation Rule
  2). The main agent records notable system changes in `CHANGELOG.md` on merge.
- **Native-control exceptions.** Product surfaces prefer shared primitives over
  raw native controls. Direct `button`, `input`, `textarea`, and `select` usages
  outside primitive implementations must either migrate to a primitive or appear
  in `scripts/design-system-metrics.ts` with a named reason. The reason must be a
  real semantic/native requirement, not a styling shortcut.

## Validation

Expected checks for design-system changes:

- `bun run typecheck`
- `bun run docs:check`
- `bun scripts/design-system-metrics.ts --json` for the current compression,
  decision-derivation, component-coverage, exception-evidence, and
  token-discipline baseline. Use `--check` before publishing a design-system
  compression or contract PR.
- Focused Playwright tests for touched surfaces.
- `tests/e2e/typography-tokens.spec.ts` for token discipline.
- `tests/e2e/cursor-affordances.spec.ts` for native cursor/chrome rules when
  interaction affordances change.
- `tests/e2e/window-material.spec.ts` for window-material and inactive-window
  behavior when material rules change.
- `git diff --check`

Use screenshot review for shell, panel, outliner, overlay, and agent changes
when visual judgment is central to the request.
