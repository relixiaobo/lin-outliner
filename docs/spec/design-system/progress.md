# Design System Progress

Last updated: 2026-05-18

This file tracks the UI refactor work at project level. It complements
`inventory.md`: inventory names the surfaces and component candidates; this file
records implementation progress and the next implementation step.

## Current Stage

Stage: full UI system refactor in progress.

This branch finishes the UI refactor as one product-system pass. The design
system, product UI, and browsable design-system site must converge together:
shell, workspace layout, outliner, tags, fields, definition configuration,
overlays, dialogs, forms, agent messages, agent process disclosure, composer,
settings, tokens, and validation.

Product behavior remains authoritative. The refactor changes visual structure,
component boundaries, and shared UI infrastructure; it must not replace the
existing outliner editing model, agent runtime model, document state model, or
workspace tab model.

Completion means:

- `docs/spec/design-system/` describes the same contracts implemented in
  product code.
- `docs/spec/design-system/index.html` is a browsable map of the real product
  system, not a separate demo language.
- Product UI uses shared tokens and primitives where those boundaries are real.
- Outliner, agent, overlays, forms, and shell have screenshot and interaction
  coverage for their primary states.

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
- Promoted `CheckboxMark` styling into the global primitive layer and adopted it
  for agent provider enablement so settings checkboxes no longer use a native
  browser mark.
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
- Added keyboard resize behavior for sidebar, agent dock, and workspace panel
  splits, using the same minimum-width contract as pointer resizing.
- Added `useAnchoredOverlay` for shared viewport-aware positioning across
  trigger popovers, node context menu, tag context menu, option pickers,
  trailing option picker, floating editor toolbar, agent model menu, and agent
  conversation menu.
- Reworked trailing-input materialization so plain text and `#`/`@` triggers
  are created after a short idle boundary, preventing fast typing from being
  split across multiple nodes while preserving IME-safe composition behavior.
- Extracted `WorkspaceTab` for tab title, active state, panel count, and close
  affordance while `TopBar` keeps shell controls, tab strip layout, and tab
  creation behavior.
- Extracted `FormField` for the visible label/control wrapper used by agent
  settings fields while leaving provider/model/reasoning behavior local to the
  settings dialog.
- Extracted `Dialog` for agent settings backdrop, semantic dialog surface, title
  linkage, Escape close, Tab focus trap, and focus restoration while leaving
  caller-owned content and action behavior intact.
- Reworked agent settings information architecture into Provider, Connection,
  and Model behavior sections; API key removal now sits with key configuration,
  while provider removal remains the secondary destructive footer action.
- Adopted shared input, select, and text-button primitives inside agent
  settings while keeping provider/model persistence behavior local.
- Completed an agent composer visual pass so the textarea remains primary,
  toolbar controls stay compact, and focus treatment follows the shared ring.
- Reworked agent debug into a compact Overview, Request Context, and Provider
  Timeline hierarchy; refresh and copy actions now use the shared icon-button
  primitive while runtime debug data remains caller-owned.
- Documented the agent approval/tool-preview boundary: runtime approval events
  and node-tool `previewOnly` results exist, but no renderer approval overlay is
  shipped yet, so the site and spec must not fake controls.
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
  model/reasoning menu, reasoning switch, thinking-level menu, direct settings
  trigger, toolbar composition, and the shared send/stop action slot while
  keeping textarea draft, sending state, attachments state, menu open state,
  provider updates, and queue/stop behavior in `AgentComposer`.
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
- Opened the unified full-system refactor branch and updated progress,
  inventory, implementation, and README docs to track one complete UI system
  pass instead of a temporary checkpoint.
- Added the missing foundation tokens to product `:root`: font stacks, overlay
  backgrounds, overlay shadows, spacing aliases, min/max shell widths,
  outline-panel minimum width, radius scale, focus ring, and z-index scale.
- Aligned sidebar and agent resize limits with the design-system tokens.
- Changed workspace panels to honor `--outline-panel-min-width` and allow
  horizontal canvas overflow when available width is below the panel minimums.
- Added keyboard resizing for sidebar, agent, and panel split resize handles.
- Updated workspace layout e2e coverage for keyboard resizing, panel minimum
  width behavior, and horizontal overflow.
- Added a shared anchored overlay positioning hook and adopted it for trigger
  popovers and the agent composer model/reasoning menu.
- Kept anchorless trailing trigger popovers on their row-local placement path
  while anchored editor triggers use viewport-aware positioning.
- Fixed fast trailing trigger input so `#project` and `@Zeta` create one
  trigger row with the full query instead of splitting the query into a second
  plain node.
- Continued outliner visual convergence by making parent chevrons lightly
  visible by default while preserving the same leading/bullet axis.
- Removed hover scale from non-content row markers so tag, field, and reference
  leading states remain visually stable.
- Aligned reference bullets to a smaller centered dashed marker inside the fixed
  leading slot.
- Aligned row tags with the row text baseline using the shared `AppliedTag`
  measured pill instead of a vertical offset.
- Removed the inner value bullet from field value rows so field values and
  definition configuration now share the same dense label/value treatment.
- Adopted `CheckboxMark` for checkbox field values so outliner done controls,
  field checkbox values, and agent settings no longer use separate checkbox
  glyph systems.
- Added e2e coverage for persistent parent chevrons and field value dense-row
  alignment.
- Moved root-owned field entries into explicit row-model `headingRows`, with
  content and hidden-field reveal rows in `bodyRows`; both sections still render
  through the real `OutlinerView` / `OutlinerFieldRow` path.
- Refined inline reference atoms from filled chip styling to text-like inline
  reference styling with semantic color and underline.
- Refined drag/drop inside state to use an inset treatment that does not shift
  row content.
- Added e2e coverage for heading field placement, tree reference marker
  geometry, inline reference text-like rendering, and drag/drop visual axes.

## In Progress

The full-system pass is organized by product boundary, not by temporary risk
avoidance:

1. **Plan and source-map refresh**
   - Bring `progress.md`, `inventory.md`, and implementation rules up to date.
   - Remove stale gap descriptions that were already closed by previous UI
     work.
   - Make remaining work explicit enough to execute without inventing a second
     design language.
2. **Foundations and tokens**
   - Canonicalize color, typography, spacing, radius, elevation, focus,
     z-index, shell width, panel width, overlay, row, tag, and agent tokens.
   - Reduce one-off CSS values where they represent system decisions.
3. **Shell and workspace layout**
   - Finish app shell, top chrome, sidebar, workspace canvas, panel surface,
     workspace tabs, resize handles, agent dock sizing, collapse states,
     minimum widths, overflow, and responsive desktop behavior.
4. **Overlay infrastructure**
   - Converge command palette, trigger popovers, tag/reference/slash menus,
     options picker, node context menu, model menu, floating editor toolbar,
     dialogs, positioning, Escape/outside dismissal, focus restoration, z-index,
     and elevation.
5. **Outliner system**
   - Continue the remaining product convergence after the first real-code pass:
     richer field value examples, reference/inline-ref screenshots, drag/drop
     screenshots, and design-system site specimens.
6. **Rich text, cursor, and IME semantics**
   - Recheck ProseMirror text editing, split/merge, description editing,
     field-value editing, inline reference atoms, trigger anchors, paste, and
     Chinese IME composition after the visual refactor.
7. **Agent system**
   - Agent message/process/composer/settings/debug have converged to real
     source maps and shared primitives. Remaining agent work is screenshot
     review across narrow dock widths and any future real approval workflow.
8. **Design-system site convergence**
   - Update `index.html` so each specimen maps to real source files and shared
     tokens.
   - Remove fake layout, fake icon, fake outliner, and static-only patterns.
9. **Validation**
   - Add or update focused renderer/e2e coverage while changing each boundary.
   - Finish with full typecheck, renderer/core/e2e tests, build, diff checks,
     and screenshot review for desktop and narrow desktop states.

## Next

1. Refresh `inventory.md` to reflect previous UI work and this full refactor
   scope.
2. Start the foundations/token pass, then shell/workspace layout.
3. Continue through the modules in the order above until the product UI,
   design-system docs, and design-system site are aligned.

## Open Milestones

- Foundations and tokens.
- Shell and workspace layout.
- Overlay infrastructure.
- Outliner system.
- Rich text, cursor, and IME semantics.
- Agent system.
- Design-system site convergence.
- Final validation and screenshots.

## Out Of Scope For This Refactor

- New product workflows that are not already present in Lin.
- Replacing ProseMirror with another editor.
- Replacing the document state model, workspace tab model, or agent runtime.
- Copying reference-app visual styling instead of implementing Lin's own design
  system.
- Creating a second icon system in the static design-system site.

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
