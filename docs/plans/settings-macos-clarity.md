---
status: in-progress
priority: P2
owner: codex
branch: codex/settings-macos-clarity
created: 2026-06-04
updated: 2026-06-04
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
also name itself like System Settings (`‹ ›` + page title). Back/forward stay
neutral chrome controls and do not gain a filled box.

### 2. Constrain the content reading width

Keep the content pane as the single scroll container, but give the settings
content column a stable max width so grouped rows no longer stretch across the
entire window. This should match the System Settings reading rhythm while still
allowing long provider lists to scroll.

### 3. Make the rail denser without changing the IA

Keep the five top-level categories. Add a compact neutral icon slot per category
and reduce the secondary copy's visual weight. The rail selection stays neutral
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
- Adding rail icons can increase clutter if the hint line remains equally
  prominent. Treat icons as compact scan aids, not decoration.

## Collision result

Checked on 2026-06-04:

- Open PR #117 claims `src/main/agentEventStore.ts`, `src/core/core.ts`.
- Open PR #116 is a performance plan and claims `docs/plans/performance-optimization.md`.
- `docs/TASKS.md` records prior settings work as shipped; no active claim on the
  files above.

No live file-level overlap.

## Checklist

- [x] Add toolbar page title and align it with the history controls.
- [x] Constrain the content column and tune vertical rhythm.
- [x] Add compact rail icon slots and reduce rail hint dominance.
- [x] Remove/demote redundant pane intro copy.
- [x] Soften inset-card chrome without weakening focus/selection states.
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
