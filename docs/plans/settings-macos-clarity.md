---
status: in-progress
priority: P2
owner: codex
branch: codex/settings-macos-clarity
created: 2026-06-04
updated: 2026-06-05
---

# Settings macOS Clarity Pass

## Goal

Make the standalone Settings window read closer to macOS System Settings while
preserving Tenon's current design system:

- neutral functional state, not system-blue selection;
- material only on chrome, opaque content surfaces;
- grouped inset rows as the shared settings primitive;
- no raw colors outside token declarations.

The current window borrows the grouped-list interaction but still feels less
clear because the page lacks a right-pane title anchor, content stretches too
wide, the category rail is too text-heavy, and several panes expose explanatory
or technical copy at the first visual level.

## Non-goals

- Do not change the provider/runtime/permission data contracts.
- Do not introduce a system-blue selected state or a `--primary` token family.
- Do not add full-settings search in this pass.
- Do not redesign the provider configuration child window.
- Do not make settings depend on `[data-theme]`; keep `prefers-color-scheme`.

## Design

### 1. Restore the right-pane title anchor

Add a settings toolbar title beside the existing back/forward history controls.
The selected rail category remains the navigation label, but the right pane must
also name itself like System Settings (`‹ ›` + page title). Back/forward render as
one neutral capsule group with a divider; the individual arrows stay shared chrome
controls and do not gain independent filled boxes. The content scrollport starts
below the fixed toolbar with structural margin so rows cannot scroll behind the
history capsule.

### 2. Constrain the content reading width

Keep the content pane as the single scroll container, but give the settings
content column a stable max width so grouped rows no longer stretch across the
entire window. This should match the System Settings reading rhythm while still
allowing long provider lists to scroll.

### 3. Make the rail denser without changing the IA

Keep the five top-level categories. Add a compact neutral icon slot per category
and render each category as a single-line label. The rail selection stays neutral
(`--fill-*`) per B3/B4; the icon slot is identity/chrome, not functional color.

### 4. Reduce first-level explanatory noise

Remove or demote pane intro lines where the page title and section headers
already explain the pane. Keep explanations inside row sublabels only when they
help a concrete setting decision. Permissions should not surface raw
`Action(...)` rule strings as primary scan text; keep them as secondary technical
detail.

### 5. Soften grouped-card chrome

Keep `InsetGroup` / `InsetRow`, but make inset cards read more like native
grouped rows: surface fill + separators first, hairline border second. Rows with
trailing controls should align and breathe consistently across General,
Permissions, Skills, and Agent Profiles.

### 6. Sync the design spec

Update `docs/spec/design-system.md` so the current intended Settings behavior
matches the implemented toolbar title, content width, denser rail, and reduced
intro-copy strategy.

### 7. Refine native control and profile layout details

Keep settings pop-up selects transparent at rest, with neutral fill only on
hover / focus / press, matching macOS' text-led pop-up rhythm. Agent Profiles
should remain a top-level profile list; persona details live in a drill-down child
route reached by clicking the profile row and navigated through the same
back/forward capsule. Avoid showing list + detail together in the category page:
that flattens the hierarchy and creates a large competing detail surface. The
top-level profile row is pure navigation (chevron only); enable/disable belongs
inside the detail route as its own settings row, not beside the drill-down affordance.
Permission decision pop-ups keep a stable width across all rows, including the
non-allowable final rule, so the transparent chrome still scans as one aligned
control family.

Hierarchy audit: General, Permissions, and Skills are direct preference rows and
stay inline; Providers already opens provider configuration in its own native
window; Agent Profiles was the only Settings pane flattening a rich detail view
into its top-level category.

## Files

Expected implementation scope:

- `src/renderer/ui/agent/AgentSettingsView.tsx`
- `src/renderer/ui/agent/SettingsInsetList.tsx` if slot structure needs a small
  primitive adjustment
- `src/renderer/styles/settings-base.css`
- `src/renderer/styles/settings-providers.css`
- `src/renderer/styles/settings-inset-list.css`
- `src/renderer/styles/settings-skills.css`
- `src/renderer/styles/settings-agents.css`
- `src/renderer/styles/controls.css` only if control sizing needs a small
  settings-specific refinement
- `docs/spec/design-system.md`

## Risks

- Overfitting to Apple chrome would violate Tenon's neutral-state rules. Keep
  all functional states on the existing neutral token ladder.
- A too-narrow content column can harm provider and permission rows. Validate
  Providers, Permissions, Skills, and Agent Profiles at the target window size.
- Adding rail icons can increase clutter if the row also carries explanatory
  subcopy. Keep the row single-line and treat icons as compact scan aids, not
  decoration.

## Collision result

Checked on 2026-06-04:

- Open PR #117 claims `src/main/agentEventStore.ts`, `src/core/core.ts`.
- Open PR #116 is a performance plan and claims `docs/plans/performance-optimization.md`.
- `docs/TASKS.md` records prior settings work as shipped; no active claim on the
  files above.

No live file-level overlap.

## Checklist

- [x] Add toolbar page title and render history controls as one capsule group.
- [x] Keep the settings content scrollport below the fixed toolbar chrome.
- [x] Constrain the content column and tune vertical rhythm.
- [x] Add compact rail icon slots and remove rail hint subcopy.
- [x] Remove/demote redundant pane intro copy.
- [x] Soften inset-card chrome without weakening focus/selection states.
- [x] Keep pop-up selects transparent at rest with hover/focus/press fill only.
- [x] Keep Permissions decision pop-ups aligned through the non-allowable last row.
- [x] Move Agent Profiles persona details into a drill-down child route.
- [x] Keep Agent Profiles top-level rows pure drill-down; move enable switches into detail.
- [x] Audit all Settings panes for flattened detail surfaces.
- [x] Update `docs/spec/design-system.md`.
- [x] Run `bun run typecheck` and relevant renderer tests.
- [x] Visually verify light and dark settings panes.

## Verification

- `bun run typecheck`
- `bun run test:renderer`
- `bunx playwright test tests/e2e/agent-settings.spec.ts`
- `bunx playwright test tests/e2e/cursor-affordances.spec.ts -g "settings inset rows"`
- In-app Browser visual pass for Providers, General, and Permissions at
  `http://127.0.0.1:5174/?surface=settings`
- Playwright screenshot pass for Providers and Permissions in light + dark:
  `tmp/settings-dark.png`, `tmp/settings-permissions-dark.png`,
  `tmp/settings-light.png`, `tmp/settings-permissions-light.png`
