# Design System Progress

Last updated: 2026-05-15

This file tracks the UI refactor work at project level. It complements
`inventory.md`: inventory names the surfaces and component candidates; this file
records implementation progress and the next safe step.

## Current Stage

Stage: UI refactor checkpoint ready for feature-work handoff.

The current checkpoint makes the product UI and the design-system site share the
same visual contract across shell, outliner, tags, definition config, and agent
surfaces. Product behavior stays authoritative; primitives preserve existing
outliner and agent behavior. After this checkpoint is committed, broader UI
refactor work can pause while other feature work proceeds.

## Completed

- Replaced the old single-file design-system draft with
  `docs/spec/design-system/`.
- Promoted `index.html` into a browsable design-system site.
- Added source maps for foundations, inventory, components, surfaces,
  outliner, agent, and implementation rules.
- Aligned product root tokens toward the design-system foundation palette.
- Updated applied tag colors to the future token model.
- Stabilized applied tag hover layout so the measured row width does not move.
- Documented outliner header structure: icon row, title row, description,
  title tag row, and optional field row.
- Preserved nodex-style `Mod+Enter` checkbox cycling:
  no checkbox -> unchecked checkbox -> checked checkbox.
- Kept mouse checkbox clicks as a two-state toggle between unchecked and
  checked once the checkbox affordance is visible.
- Reworked checkbox visuals into the three-state Tana-style model:
  bullet only, neutral filled square, success filled square with check.
- Extracted `CheckboxMark` as the first small primitive while keeping
  `DoneCheckbox` responsible for button behavior and accessibility.
- Extracted `IconButton` as a small primitive and adopted it in top chrome,
  workspace panel close, panel title actions, the floating editor toolbar,
  agent message actions, agent session actions, and agent composer actions.
- Extracted `MenuSurface` and `MenuItem` as thin primitives; `MenuSurface`
  covers trigger popovers, node context menu, option pickers, batch tag
  selector, and the agent model menu, while `MenuItem` also covers command
  palette rows.
- Audited menu semantics: command palette is dialog/listbox, trigger popovers
  are labeled listboxes, node context menu uses menu semantics only in its main
  action state, and history/model popovers expose explicit dialog/menu labels.
- Extracted `AppliedTag` for measured applied tag rendering while keeping
  lookup, command execution, and context menu state inside `TagBar`.
- Split `RowMarker` out of `RowLeading` so node leading visuals are separate
  from chevron, drag, and drill-down behavior.
- Extracted `FieldEntryGrid` for field name, value, and description layout
  slots while leaving field commit timing and keyboard flow unchanged.
- Extracted `TrailingInputLeading` so the trailing empty row uses the shared
  row marker contract while ProseMirror creation behavior stays local.
- Extracted `NodeDescriptionSurface` so description read/edit visuals are
  separate from draft, focus, commit, and IME-safe keyboard behavior.
- Extracted `OutlinerViewChrome` for group heading and hidden-field reveal
  visuals while row building and reveal state stay in `OutlinerView`.
- Extracted `OutlinerRowShell` for the shared wrapper and inner-row structure
  used by content rows and field rows, without moving row behavior.
- Split outliner-specific CSS into `src/renderer/styles/outliner.css` so row,
  field, tag, and metadata rhythm are separated from shell and agent styles.
- Extracted `WorkspacePanelSurface` for workspace panel shell, active state,
  close slot, and `--panel-size` wiring while leaving rendered content and tab
  state in `WorkspaceCanvas`.
- Extracted `ResizeHandle` for sidebar, panel, and agent resize buttons while
  leaving pointer math in `useResizableLayout`.
- Extracted `WorkspaceTab` for tab title, active state, panel count, and close
  affordance while `TopBar` keeps shell controls, tab strip layout, and tab
  creation behavior.
- Extracted `FormField` for the visible label/control wrapper used by agent
  settings fields while leaving provider/model/reasoning behavior local to the
  settings dialog.
- Extracted `Dialog` for agent settings backdrop, semantic dialog surface, title
  linkage, Escape close, Tab focus trap, and focus restoration while leaving
  caller-owned content and action behavior intact.
- Added e2e coverage for agent settings modal focus entry, focus cycling,
  Escape close, and trigger focus restoration.
- Adopted `Dialog` in the command palette while preserving the search input as
  initial focus, the listbox active-descendant model, arrow navigation, Enter
  execution, Escape close, and invoking-control focus restoration.
- Added e2e coverage for command palette modal focus entry, focus cycling,
  Escape close, focus restoration, and keyboard navigation through search
  results.
- Extracted agent message/process structure into `AgentMessageFrame`,
  `AgentBranchNavigator`, `AgentProcessTimeline`, `AgentThinkingBlock`, and
  `AgentToolCallDisclosure` while keeping turn rendering, expand state, copy,
  edit, retry, regenerate, and branch switching behavior in place.
- Added renderer summary coverage and e2e coverage for completed agent process
  collapse, thinking expansion, and tool input/output disclosure.
- Extracted `DefinitionConfigRowShell` for dense definition configuration
  icon/label/control geometry while keeping individual controls and persistence
  behavior in `DefinitionConfigPanel`.
- Extracted `SwitchControl` for shared switch semantics and checked toggling,
  then adopted it in definition configuration rows while keeping row-specific
  visuals and persistence local.
- Extracted `SelectControl` for native select semantics and accessible labels,
  then adopted it in definition configuration rows while leaving option content
  and value coercion caller-owned.
- Extracted `TextInputControl` and `NumberInputControl` for native input
  semantics and accessible labels, then adopted them in definition
  configuration rows while keeping draft state, commit timing, parsing, and
  Escape revert behavior caller-owned.
- Completed the definition config controls milestone by extracting
  `DefinitionConfigControls`, so the panel now maps config items to
  definition-scoped controls while select, switch, color, number, draft, commit,
  parsing, and revert behavior are contained in one module.
- Extracted `PopoverListbox`, `PopoverListItem`, `PopoverEmpty`, and
  `PopoverBulletIcon` for trigger popovers, field option pickers, trailing
  option popovers, tag/reference suggestions, and slash commands while keeping
  positioning, active index, keyboard flow, create/select behavior, and command
  execution caller-owned.
- Added e2e coverage for trigger popover listbox labels and selected option
  state across tag, reference, and slash command suggestions.
- Extracted `AgentComposerControls` and `AgentComposerModelMenu` for queued
  follow-up actions, attachment chips, attachment trigger, model picker button,
  model/reasoning menu, reasoning switch, thinking-level menu, and the shared
  send/stop action slot while keeping textarea draft, sending state,
  attachments state, menu open state, provider updates, and queue/stop behavior
  in `AgentComposer`.
- Added e2e coverage for composer send, attachment chip removal, model menu
  semantics, reasoning radio state, streaming stop, and queued follow-up
  submission.
- Aligned top-level panel outliner bullets with the header content column by
  letting the chevron slot sit in the left gutter while preserving internal row
  geometry.
- Raised the shared panel horizontal content inset so the left gutter has room
  for the chevron instead of making chevron spacing a one-off override.
- Removed the panel header's extra right inset so the More action aligns to the
  same panel content edge as the rest of the header system.

## In Progress

- No further UI refactor milestone is in progress for this checkpoint.
- Keep outliner row behavior inside current outliner components.
- Keep design-system site examples aligned with real product class semantics
  when UI work resumes.

## Next

1. Commit this checkpoint before starting unrelated feature work.
2. Keep full `OutlinerRow` behavior extraction deferred; row CSS is separated,
   but selection, editing, drag/drop, trigger, and paste behavior should remain
   in the current row model until dedicated tests cover a larger move.
3. When UI refactor resumes, choose one explicit milestone: agent settings
   form-control adoption, shared overlay positioning after more anchored-popover
   behavior is covered, or a focused visual-token pass for composer/settings.

## Open Milestones

- Shared form controls beyond definition config: evaluate whether agent
  settings can adopt `SelectControl`, `TextInputControl`, and
  `NumberInputControl` without weakening provider/model-specific behavior.
- Outliner row behavior wrapper: deferred until selection, edit, drag/drop,
  trigger, paste, and IME tests are broad enough for a larger move.

## Deferred

- Do not extract a large `OutlinerRow` wrapper yet.
- Do not rewrite agent process/tool-call rendering before menu/button
  primitives exist.
- Do not create a second icon system in the static design-system site.
- Do not replace real product behavior with static site-only specimens.

## Validation

For UI refactor changes, run the narrowest relevant validation first:

- `bun run typecheck`
- `bun run test:core`
- `bun run test:renderer`
- `bun run test:e2e -- tests/e2e/command-palette.spec.ts`
- `bun run test:e2e -- tests/e2e/agent-composer.spec.ts`
- `bun run test:e2e -- tests/e2e/agent-settings-dialog.spec.ts`
- `bun run test:e2e -- tests/e2e/agent-process.spec.ts`
- `bun run test:e2e -- tests/e2e/outliner-triggers.spec.ts`
- `bun run test:e2e -- tests/e2e/outliner-navigation-title.spec.ts`
- `bun run test:e2e -- tests/e2e/outliner-selection-keyboard.spec.ts`
- `bun run build`
- `git diff --check`

Checkpoint validation on 2026-05-15:

- `bun run typecheck`
- `bun run test:core`
- `bun run test:renderer`
- `bun run test:e2e`
- `bun run build`
- `git diff --check`
