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
  satisfied. The JSON `targets` object mirrors the ratified baselines enforced by
  `--check`. The ratified target is: surface-specific contract lines are at least
  40% below the post-split baseline (`surfaces.md` <= 403 lines from a 672-line
  baseline); the sampled [decision audit](./decision-audit.md) keeps at least the
  current 50-row sample with unique contiguous `Dxx` ids and no malformed rows,
  proves at least 80% derived decisions, uses only valid `Derived` / `Exception`
  result values, has 100% evidence coverage with no broken local evidence
  references, and names a kernel exception for every Exception row; the
  calibration Classification Model
  table stays limited to the four ratified classes with non-empty meaning and
  response cells, and the calibration ledger uses unique contiguous `CAxx` ids,
  no malformed finding rows, those same classes, and 100% evidence coverage with
  no broken local evidence references;
  component coverage is at least 80%; Exception Registry rows are well-formed
  with 100% evidence coverage and no broken local evidence references; raw colour
  literals outside foundation token declarations stay 0 after named exceptions;
  and the runtime surface matrix remains discoverable with unique case names and
  real light/dark theme variants. The
  raw-colour scan covers renderer CSS, TS, and TSX, and only the foundation token
  layer may declare raw-colour custom properties, so source literals cannot hide
  outside stylesheet files or behind component-private variables. Runtime surface
  counts are reported as cases and light/dark theme checks, not as a completeness
  claim for every possible UI state.
- **Source map accountability.** The kernel Source Map is the renderer UI audit's
  entry index. Its table rows must stay well-formed, and every Product Sources
  code span must resolve to a current renderer CSS/TS/TSX file; short names must
  resolve uniquely unless the code span is an intentional wildcard.
- **Derivation audit.** For a new or changed UI, the PR must be able to answer
  four questions: which surface owns it, which component primitive or pattern it
  uses, which state-model row it maps to, and which foundation tokens carry its
  visual values. If the answer needs a page-local special case, either promote a
  reusable rule or add a named exception with evidence.
- **Calibration audit.** A design-system calibration pass records findings in
  [calibration-audit.md](./calibration-audit.md) as code drift, spec drift, named
  exception, or open design decision. The audit's open-design-decision table must
  stay well-formed so escalation boundaries remain machine-checkable. Do not
  leave those classifications only in PR prose.
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
- **Alias discipline:** aliases are allowed only when they name a reusable role
  contract over the foundation layer. Retired compatibility names are guarded
  from returning; pre-launch means we cut callers to the owning semantic token
  instead of keeping shims.
- **Change discipline:** the smallest owning design-system layer is updated
  before or with any UI change that alters a system contract (Implementation Rule
  2). The main agent records notable system changes in `CHANGELOG.md` on merge.
- **Native-control exceptions.** Product surfaces prefer shared primitives over
  raw native controls. Direct `button`, `input`, `textarea`, and `select` usages
  outside component implementations must either migrate to a primitive or appear
  in `scripts/design-system-metrics.ts` with a named reason. The reason must be a
  real semantic/native requirement, not a styling shortcut. The metrics script
  scans renderer TS/TSX, including entry surfaces outside `src/renderer/ui`,
  reports named exception files and reasons in `--json`, fails stale exception
  entries, fails malformed audit rows, fails drift between the metrics exception
  map and the calibration audit's Native-Control Exceptions table, and reports
  component-implementation native controls separately from product-surface direct
  native controls, so a reusable primitive can own its internal semantics without
  hiding product-surface drift.
- **Raw-colour exceptions.** Renderer raw hex and raw functional colour literals
  belong in the foundation token declaration layer. Component-private CSS
  variables are product styling, so they derive from existing tokens. Any
  unavoidable source literal must be named in `scripts/design-system-metrics.ts`
  and in the kernel Exception Registry, with a narrow source-context scope and
  evidence. The metrics script fails undocumented entries, stale entries whose
  source literal no longer exists, and same-file/same-literal uses outside the
  named source context.
- **Audit local references.** Exception Registry authority/evidence text,
  decision-audit derivation/evidence text, and calibration evidence text must
  resolve any local links and path-like code spans to current repo files. Short
  filename evidence is accepted only when it resolves to exactly one file in the
  audit search roots. The metrics script reports and fails broken or ambiguous
  local references so named exceptions and Derived decisions do not keep passing
  after their proof files move or disappear.
- **Named exception summaries.** The calibration audit's Named Exceptions Kept
  table is a well-formed summary, not a second source of truth. Every Kernel
  Exception Registry entry must appear there, and any non-kernel entry must be
  named in the metrics script as a local calibration exception. The metrics
  script fails malformed summary rows, missing registry entries, unregistered
  summary entries, and missing local entries.

## Validation

Expected checks for design-system changes:

- `bun run typecheck`
- `bun run docs:check`
- `bun scripts/design-system-metrics.ts --json` for the current compression,
  source-map references, calibration classification/ledger integrity,
  decision-derivation, component-coverage,
  exception-evidence, and renderer-wide token-discipline baseline, including raw
  colour literals in CSS, TS, and TSX, calibration evidence references, plus the
  runtime surface matrix size, duplicate-name check, and light/dark variant
  discovery. Use `--check` before
  publishing a design-system compression or contract PR.
- Focused Playwright tests for touched surfaces.
- `tests/e2e/design-system-runtime.spec.ts` for representative shell, settings,
  settings-row-menu, launcher-renderer, overlay, outliner trigger, menu,
  tag-context, field-reuse, field-value-popovers including selected values,
  floating-tool, panel-date-navigation, view-configuration and toolbar tooltip,
  schema-definition, code-block, inline-file preview/context, confirm-dialog,
  error-state, file-preview row/header menus, document-outline, agent-composer
  menus/submenus, dream-manual, agent-message-details, agent/debug usage
  tooltips, agent-process, and run-detail surfaces staying bounded and
  OS-theme-native in light and dark.
- `tests/e2e/typography-tokens.spec.ts` for token discipline, the no renderer
  `[data-theme]` bridge rule, the registered dark-media rule allowlist, the
  registered `color-scheme` declaration allowlist, the registered reduced-motion
  / reduced-transparency / increased-contrast rule allowlists, the absent
  `--primary` token family, viewport-independent font sizing, neutral
  letter-spacing, the static no-scale feedback guard, and the registered
  layout-transition and interactive-state layout-declaration allowlists; it keeps
  global z-index values on the `--z-*` ladder without renderer source-owned
  inline `zIndex` / `z-index`, keeps foundation typography/radius/shadow styling
  out of renderer source-owned inline style objects, direct DOM style writes
  including same-file style aliases, inline style strings, and `cssText`
  assignment / append strings,
  keeps hidden scrollbars limited to the registered document-outline mini-rail
  exception, and keeps every
  `--material-*` background paired with the
  shared `--material-backdrop` filter, scoped to registered chrome / overlay
  surfaces, and routed through the shared accessibility fallback path; backdrop
  filters stay scoped to those material surfaces plus the
  registered preview-HUD exception, while preview HUD actions use
  `--preview-action-shadow` and rail chrome uses the shared
  `--rail-surface-shadow`. It also keeps level-2 focused overlays on the opaque
  elevated tier, not the material popover tier.
  It also keeps functional-state fills, borders, and rings from using brand,
  link, or status colour tokens outside the solid destructive-confirmation
  exception, keeps registered overlay root surfaces free of real outer borders,
  and fails overlay `box-shadow` declarations that mix level-1/2 shadow tokens
  with outline tokens. It also rejects the legacy generic
  `--shadow` and `--danger` aliases across renderer source evidence so surfaces
  name the actual elevation tier and semantic status role they use, keeps retired
  legacy aliases out of live CSS,
  keeps stylesheet raw functional color literals inside token declarations, fails
  undefined live token references outside named runtime/generated inputs, keeps
  motion timing literals routed through motion tokens outside zero delays,
  prevents design system docs from copying a second `:root` token table, and
  keeps component shadow custom properties routed through token-layer shadows,
  keeps component `color-mix()` recipes derived from tokens or `currentColor`,
  and keeps foundation token definitions unique in `tokens.css`.
- `tests/e2e/cursor-affordances.spec.ts` for native cursor/chrome rules when
  interaction affordances change, including pointer-cursor scope, help-cursor
  diagnostics scope, text-cursor editor/text scope, and forced
  `user-select: none !important` suppression staying limited to active drag /
  resize gestures. It also keeps direct, named, conditional, and spread renderer
  JSX inline styles, direct / object-assigned DOM style writes including
  same-file style aliases, inline style strings, and `cssText` strings from
  declaring cursor, user-select, or app-region affordance properties, keeps renderer drag
  regions from selecting chrome text, keeps the shared bare input primitive from
  suppressing the global
  keyboard focus ring, keeps local `:focus-visible` ring suppressions explicitly
  named, keeps local `:focus-visible` outline suppressions either paired with a
  focus token or explicitly named, keeps explicit `:focus-visible` indicator
  declarations routed through focus-named tokens, keeps resize cursors routed
  through the shared cursor tokens, keeps role-tooltip surfaces registered and
  pointer-transparent with read-only content, and keeps named chrome icon controls
  colour-only on hover, focus, and press.
- `tests/e2e/window-material.spec.ts` for window-material and inactive-window
  behavior when material rules change.
- `git diff --check`

Use screenshot review for shell, panel, outliner, overlay, and agent changes
when visual judgment is central to the request.
