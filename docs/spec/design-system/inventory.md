# UI System Inventory

This inventory maps the current product UI to the design-system modules. It is
the starting point for UI refactors: first identify the product area, then apply
patterns, foundations, surfaces, and component rules.

## Scope

Inventory covers shipped or in-progress product UI under `src/renderer/ui`:

- App shell and workspace layout.
- Outliner panels and rows.
- Tags, metadata, and definition configuration.
- Agent dock, messages, composer, and provider settings.
- Commands, menus, popovers, dialogs, and editor overlays.
- Shared component candidates that should become stable primitives.

## Inventory Map

| Area | Current implementation | Design-system home | Status |
| --- | --- | --- | --- |
| App shell | `App.tsx`, `TopBar.tsx`, `Sidebar.tsx`, `WorkspaceCanvas.tsx`, `AgentDock.tsx` | `patterns.md`, `surfaces.md` | Structure and first primitives are aligned; full token, responsive, overflow, and screenshot pass is in scope for this refactor. |
| Workspace tabs | `TopBar.tsx`, `WorkspaceTab.tsx`, `useWorkspaceTabs.ts` | `components.md`, `patterns.md` | Tab title, active state, count, and close affordance are isolated; strip layout and tab creation remain in `TopBar`. |
| Multi-panel canvas | `WorkspaceCanvas.tsx`, `WorkspacePanelSurface.tsx`, `ResizeHandle.tsx`, `useResizableLayout.ts`, `useWorkspaceTabs.ts` | `patterns.md`, `surfaces.md` | Real tiled panels exist; panel shell, resize button structure, minimum width, overflow, and keyboard resize are isolated; responsive behavior remains. |
| Outliner panel | `NodePanel.tsx`, `OutlinerView.tsx`, `OutlinerItem.tsx` | `surfaces.md`, `components.md` | Real product UI remains authoritative; this pass finishes heading, row, field, tag, definition, and trailing-input visual convergence. |
| Outliner rows | `OutlinerItem.tsx`, `OutlinerRowShell.tsx`, `RowLeading.tsx`, `RowMarker.tsx`, `NodeDescriptionSurface.tsx`, `OutlinerViewChrome.tsx`, `RowHost.tsx`, `useOutlinerRowInteraction.ts` | `components.md` | Row shell, leading marker, description visuals, and view chrome are isolated; full row visual contract and behavior boundary cleanup are in scope. |
| Editor | `RichTextEditor.tsx`, `FloatingEditorToolbar.tsx`, `editorRegistry.ts` | `components.md`, `implementation.md` | ProseMirror-based editor is core infrastructure; floating toolbar now uses shared anchored overlay positioning. |
| Tags | `AppliedTag.tsx`, `TagBar.tsx`, `tagColors.ts`, `TagSelector.tsx`, `BatchTagSelector.tsx` | `components.md`, `patterns.md` | Applied tag measured rendering is isolated and tokenized; tag context menu now uses shared anchored positioning while selector, batch, focus, and validation convergence remain. |
| Fields and definitions | `DefinitionConfigPanel.tsx`, `DefinitionConfigControls.tsx`, `DefinitionConfigRowShell.tsx`, `FieldEntryGrid.tsx`, `FieldValueRenderer.tsx`, `OptionsPicker.tsx`, field row files | `components.md`, `surfaces.md` | Field entry layout, definition row shell, definition controls, and option popover shell are isolated; option pickers now use shared anchored positioning while field values and definition configuration receive one final dense-row visual pass in this refactor. |
| Commands | `CommandPalette.tsx`, `useWorkspaceKeyboard.ts` | `components.md`, `implementation.md` | Core overlay exists; dialog shell and menu item rows are shared while search/list behavior stays command-owned. |
| Node menus | `NodeContextMenu.tsx`, `TriggerPopover.tsx`, `SlashCommandMenu.tsx`, `ReferenceSelector.tsx` | `components.md`, `implementation.md` | Trigger listbox shell, option rows, trigger positioning, and node context-menu positioning are shared; context-menu submodes and keyboard/focus convergence remain. |
| Agent dock | `AgentDock.tsx`, `AgentChatPanel.tsx`, `AgentDebugPanel.tsx` | `surfaces.md`, `patterns.md` | Real surface exists and is persistent; chat/message primitives are mostly isolated and debug now has a sectioned inspection hierarchy. |
| Agent messages | `AgentMessageRow.tsx`, `AgentMessageFrame.tsx`, `AgentBranchNavigator.tsx`, `AgentProcessBlock.tsx`, `AgentProcessTimeline.tsx`, `AgentThinkingBlock.tsx`, `AgentToolCallBlock.tsx`, `AgentToolCallDisclosure.tsx` | `components.md`, `surfaces.md` | Production UI exists; message frame, branch navigator, process timeline, thinking, and tool-call disclosure are isolated while turn behavior stays product-owned. |
| Agent composer | `AgentComposer.tsx`, `AgentComposerControls.tsx`, `AgentComposerModelMenu.tsx` | `components.md`, `surfaces.md` | Rich behavior exists; queued follow-up controls, attachment chip, toolbar composition, model picker, reasoning menu/switch, settings trigger, send/stop slot, anchored model menu, conversation menu positioning, and final compact visual hierarchy are isolated while composer behavior remains product-owned. |
| Agent settings | `AgentSettingsDialog.tsx` | `components.md`, `implementation.md` | Dialog shell, sectioned provider/connection/model behavior architecture, form field wrapper, shared input/select/button primitives, key action placement, and shared checkbox mark are in place while destructive confirmation remains future work. |
| Agent approval and preview | `agentTypes.ts`, `agentNodeTools.ts` | `agent.md`, `surfaces.md` | Runtime approval event type and node-tool `previewOnly` results exist; no renderer approval overlay is shipped, so the design system documents the boundary instead of rendering fake controls. |
| Icons | `icons.ts` | `foundations.md`, `components.md` | Central alias file exists; icon sizes need token alignment. |
| CSS tokens | `styles.css`, `styles/outliner.css` | `foundations.md`, `implementation.md` | Product tokens and outliner stylesheet boundary exist; this pass canonicalizes remaining one-off values, widths, z-index, overlays, and focus states. |

## App Shell

Source:

- `src/renderer/ui/App.tsx`
- `src/renderer/ui/TopBar.tsx`
- `src/renderer/ui/Sidebar.tsx`
- `src/renderer/ui/WorkspaceCanvas.tsx`
- `src/renderer/ui/AgentDock.tsx`
- `src/renderer/ui/useResizableLayout.ts`
- `src/renderer/ui/useWorkspaceTabs.ts`

Current state:

- `TopBar` owns sidebar toggle, disabled history controls, workspace tabs, agent
  toggle, and account affordance.
- `App` owns persistent sidebar and agent visibility state.
- `WorkspaceCanvas` renders real `NodePanel` instances.
- `useWorkspaceTabs` owns tab, panel, active panel, close panel, open panel, and
  persisted layout state.
- `useResizableLayout` owns sidebar, agent, and panel pointer resize.

Aligned:

- Shell state classes exist: `.app-shell`, `.sidebar-collapsed`,
  `.agent-collapsed`, and combined collapsed state.
- Sidebar and agent docks are outside workspace tab state.
- Panel state is inside workspace tab state.
- Closing the last panel is blocked.
- Closing the active panel moves focus to a neighboring panel.

Remaining convergence:

- Continue replacing shell-level one-off values with the canonical width,
  gutter, radius, focus, overlay, and z-index tokens where those values express
  system decisions.
- Finish responsive desktop collapse rules.
- Continue screenshot validation across desktop and narrow desktop states.

## Outliner

Source:

- `src/renderer/ui/NodePanel.tsx`
- `src/renderer/ui/outliner/OutlinerView.tsx`
- `src/renderer/ui/outliner/OutlinerItem.tsx`
- `src/renderer/ui/outliner/OutlinerRowShell.tsx`
- `src/renderer/ui/outliner/RowLeading.tsx`
- `src/renderer/ui/outliner/RowHost.tsx`
- `src/renderer/ui/outliner/useOutlinerRowInteraction.ts`
- `src/renderer/ui/outliner/TrailingInput.tsx`
- `src/renderer/ui/outliner/TrailingInputLeading.tsx`
- `src/renderer/ui/outliner/DoneCheckbox.tsx`
- `src/renderer/ui/outliner/IndentGuide.tsx`
- `src/renderer/ui/outliner/NodeDescription.tsx`
- `src/renderer/ui/outliner/NodeDescriptionSurface.tsx`
- `src/renderer/ui/outliner/OutlinerViewChrome.tsx`

Current state:

- `NodePanel` owns title, breadcrumb, definition configuration, outliner body,
  trailing input, and panel-level context menu.
- `OutlinerItem` owns row editing, row selection, row context menu, inline tag
  display, description editing, trigger popovers, indentation, drag state, and
  child rendering.
- `RichTextEditor` owns text editing, inline references, marks, slash/hash/at
  triggers, paste parsing, keyboard editing, and floating toolbar.

Aligned:

- Product uses real outliner rows, not static preview panels.
- Row typography and editing are owned by outliner code.
- Tags render inline with row content.
- Row behavior is rich enough to remain the authority for keyboard and editing
  contracts.

Remaining convergence:

- Finish the full row visual contract while preserving the current row
  interaction model.
- Keep row, field, tag, and metadata rhythm inside `styles/outliner.css` and
  prevent shell styles from redefining row typography.
- Normalize focus-visible treatment for row controls and inline controls.
- Make field rows, content rows, definition rows, trailing rows, completed rows,
  reference rows, and collapsed-parent rows share one documented text-start and
  leading-grid contract.

## Tags And Metadata

Source:

- `src/renderer/ui/tags/TagBar.tsx`
- `src/renderer/ui/tags/tagColors.ts`
- `src/renderer/ui/outliner/TagSelector.tsx`
- `src/renderer/ui/outliner/BatchTagSelector.tsx`
- `src/renderer/ui/outliner/NodeContextMenu.tsx`

Current state:

- Applied tags can be opened, removed, and configured.
- Tag context menus and batch tag selection exist.
- Tag colors are resolved through `tagColors.ts`.

Aligned:

- Applied tags render inline.
- Remove control has a real action.
- Tag menu behavior is backed by product state.

Remaining convergence:

- Keep applied tag hover/focus inside the same measured box and validate that
  row height, text start, and neighboring text do not move.
- Standardize tag background pill behavior across applied tags, selector tags,
  batch selector rows, tag context submodes, and trashed tags.
- Validate keyboard/focus treatment for tag open and remove controls.
- Keep the future tag visual style as the product target, even when migrating
  from existing node tag styles.

## Agent

Source:

- `src/renderer/ui/AgentDock.tsx`
- `src/renderer/ui/agent/AgentChatPanel.tsx`
- `src/renderer/ui/agent/AgentComposer.tsx`
- `src/renderer/ui/agent/AgentMessageRow.tsx`
- `src/renderer/ui/agent/AgentMessageFrame.tsx`
- `src/renderer/ui/agent/AgentBranchNavigator.tsx`
- `src/renderer/ui/agent/AgentProcessBlock.tsx`
- `src/renderer/ui/agent/AgentProcessTimeline.tsx`
- `src/renderer/ui/agent/AgentThinkingBlock.tsx`
- `src/renderer/ui/agent/AgentToolCallBlock.tsx`
- `src/renderer/ui/agent/AgentToolCallDisclosure.tsx`
- `src/renderer/ui/agent/AgentComposerControls.tsx`
- `src/renderer/ui/agent/AgentComposerModelMenu.tsx`
- `src/renderer/ui/agent/AgentSettingsDialog.tsx`
- `src/renderer/ui/agent/AgentDebugPanel.tsx`

Current state:

- Agent dock is persistent and resizable.
- Chat panel has header, status dots, empty suggestions, streaming state, error
  state, messages, process blocks, tool-call blocks, composer, model menu,
  reasoning control, queued follow-up, and settings dialog.
- Provider settings include model, reasoning, base URL, API key, enable switch,
  remove provider, remove key, save/cancel, and alerts.
- Agent debug includes session/model/context overview, request context,
  provider timeline, raw payload disclosure, refresh, and copy actions.

Aligned:

- Agent dock is separate from workspace tabs.
- Header title follows `# conversation`.
- Agent surface is real, not a placeholder.
- Tool calls and process/thinking blocks are visible product concepts.
- Message shell, branch navigation, process timeline, thinking rows, and
  tool-call disclosure shells are componentized without moving runtime turn
  behavior.
- Composer controls are componentized around existing primitives while draft,
  streaming, provider update, attachment, and queue behavior stay local.
- Agent settings and debug information architecture are sectioned while runtime
  data and persistence remain local.

Remaining convergence:

- Keep thinking and tool-call disclosure grouped under assistant turns, with
  bounded expanded payloads.
- Validate agent dock, composer, settings, debug, and process specimens with
  screenshots across default and narrow dock widths.
- Implement a renderer approval overlay only after product behavior exists; do
  not fake it in the design-system site.

## Commands And Overlays

Source:

- `src/renderer/ui/CommandPalette.tsx`
- `src/renderer/ui/outliner/NodeContextMenu.tsx`
- `src/renderer/ui/outliner/TriggerPopover.tsx`
- `src/renderer/ui/outliner/SlashCommandMenu.tsx`
- `src/renderer/ui/outliner/ReferenceSelector.tsx`
- `src/renderer/ui/outliner/OptionsPicker.tsx`
- `src/renderer/ui/editor/FloatingEditorToolbar.tsx`

Current state:

- Command palette is a modal overlay with search, default navigation, node hits,
  create action, keyboard navigation, and action footer.
- Node context menu supports main, tag, and move modes.
- Trigger popovers support slash commands, references, tags, and field creation.
- Editor toolbar floats above text selection.
- Options picker provides a small popover inside field values.

Aligned:

- Overlays are real product workflows.
- Most overlays have Escape behavior and outside-click dismissal.
- Command palette has keyboard navigation.
- Command palette uses the shared `Dialog` shell while retaining its search
  input focus and active-descendant listbox behavior.

Remaining convergence:

- Introduce a shared overlay positioning contract for anchored popovers and
  floating toolbars beyond the trigger popover and agent model menu.
- Bring context menu variants and remaining agent overlays onto the same row,
  focus, and active-state vocabulary where their semantics match.
- Define focus trapping, roving focus, Escape, outside pointer dismissal, and
  focus restoration per overlay type.
- Tokenize z-index and elevation against `foundations.md`.

## Fields And Definition Configuration

Source:

- `src/renderer/ui/definition/DefinitionConfigPanel.tsx`
- `src/renderer/ui/definition/definitionConfig.ts`
- `src/renderer/ui/outliner/OutlinerFieldRow.tsx`
- `src/renderer/ui/outliner/FieldValueRenderer.tsx`
- `src/renderer/ui/outliner/FieldValueRow.tsx`
- `src/renderer/ui/outliner/OptionsPicker.tsx`
- `src/renderer/ui/outliner/ViewToolbar.tsx`

Current state:

- Definition configuration has rows for field type, tag inheritance, checkbox
  behavior, autocollect options, hidden field modes, min/max numbers, and color.
- Field values support plain text, number, URL, email, password, checkbox,
  boolean switch, date, color, and options.
- Options picker supports keyboard open/select/create.

Aligned:

- Domain controls exist and are real product behavior.
- Icons are used for config row meaning.
- Switch controls expose `role="switch"` and `aria-checked`.

Remaining convergence:

- Use the extracted definition row and control primitives as the dense-row
  baseline for both field values and definition configuration.
- Normalize field controls around shared input, select, switch, number, color,
  invalid, disabled, and focus tokens.
- Preserve field-specific commit timing and keyboard flow while aligning visual
  structure.

## Shared Component Candidates

These are not necessarily files yet. They are the component boundaries that
should stabilize before broad UI refactors.

| Candidate | Current sources | Notes |
| --- | --- | --- |
| `CheckboxMark` | `src/renderer/ui/primitives/CheckboxMark.tsx`, `DoneCheckbox.tsx`, `AgentSettingsDialog.tsx` | Shared primitive; owns three-state visual mark only, not row, form, or settings behavior. |
| `IconButton` | `src/renderer/ui/primitives/IconButton.tsx`, top chrome, panel close, title actions, editor toolbar, agent message/composer actions | Extracted for icon-only command buttons while preserving existing surface class names. |
| `ButtonControl` | `src/renderer/ui/primitives/ButtonControl.tsx`, `AgentSettingsDialog.tsx` | Extracted for text button semantics and default button type; surface-specific visual variants remain class-owned. |
| `ToolbarButton` | `FloatingEditorToolbar`, agent message actions, top chrome | May be an `IconButton` variant. |
| `MenuSurface` | `src/renderer/ui/primitives/MenuSurface.tsx`, `PopoverListbox`, context menu, option/model menus | Extracted as a wrapper only; keyboard behavior remains local. |
| `AnchoredOverlay` | `src/renderer/ui/primitives/useAnchoredOverlay.ts`, trigger popovers, context menus, option/model/session menus, floating editor toolbar | Shared viewport-aware positioning hook; callers still own open state, dismissal, focus, and command behavior. |
| `MenuItem` | `src/renderer/ui/primitives/MenuItem.tsx`, `PopoverListItem`, command item, context item, model item | Extracted for icon/label/meta row slots while preserving local classes and roles. |
| `PopoverListbox` / `PopoverListItem` | `src/renderer/ui/outliner/PopoverList.tsx`, trigger popover, option picker, trailing option picker, tag/reference/slash suggestions | Extracted for listbox popover shell, option rows, empty rows, and bullet placeholder; active index, positioning, creation, selection, and command execution stay caller-owned. |
| `WorkspaceTab` | `src/renderer/ui/WorkspaceTab.tsx`, `TopBar.tsx` | Extracted for title, count, active state, and close affordance; `TopBar` still owns strip layout and tab creation. |
| `PanelSurface` | `WorkspacePanelSurface.tsx`, `WorkspaceCanvas.tsx`, `styles.css` | Extracted for workspace panel shell, active class, close slot, and sizing variable. |
| `ResizeHandle` | `src/renderer/ui/primitives/ResizeHandle.tsx`, `WorkspaceCanvas.tsx`, `Sidebar.tsx`, `AgentDock.tsx` | Extracted for shared resize button structure; pointer behavior remains in `useResizableLayout`. |
| `AppliedTag` | `src/renderer/ui/tags/AppliedTag.tsx`, `TagBar.tsx` | Extracted for measured applied tag rendering; `TagBar` still owns tag lookup, commands, and context menu state. |
| `Dialog` | `src/renderer/ui/primitives/Dialog.tsx`, `AgentSettingsDialog.tsx`, command palette overlay | Extracted for settings and command-palette modal shells, semantic surface, label linkage, Escape close, focus trap, initial focus, and focus restoration. |
| `FormField` | `src/renderer/ui/primitives/FormField.tsx`, agent settings, definition config, field value rows | Extracted for visible label/control wrapper in settings; this refactor decides where definition config and outliner field variants should adopt it. |
| `SwitchControl` | `src/renderer/ui/primitives/SwitchControl.tsx`, `DefinitionConfigPanel.tsx` | Extracted semantic switch wrapper for `role=switch`, `aria-checked`, and checked toggle; visual treatment remains surface-owned. |
| `SelectControl` | `src/renderer/ui/primitives/SelectControl.tsx`, `DefinitionConfigPanel.tsx` | Extracted native select wrapper for accessible label and prop forwarding; options and value coercion remain caller-owned. |
| `TextInputControl` | `src/renderer/ui/primitives/TextInputControl.tsx`, `DefinitionConfigControls.tsx`, `AgentSettingsDialog.tsx` | Extracted native input wrapper for accessible label, type, and prop forwarding; draft/commit behavior remains caller-owned. |
| `NumberInputControl` | `src/renderer/ui/primitives/NumberInputControl.tsx`, `DefinitionConfigControls.tsx` | Extracted native number input wrapper for accessible label and prop forwarding; parsing and empty-value semantics remain definition-owned. |
| `DefinitionConfigControls` | `src/renderer/ui/definition/DefinitionConfigControls.tsx`, `DefinitionConfigPanel.tsx` | Extracted definition-scoped select, switch, color, and number controls; panel now owns item mapping and persistence patches. |
| `DefinitionConfigRow` | `src/renderer/ui/definition/DefinitionConfigRowShell.tsx`, `DefinitionConfigControls.tsx`, `DefinitionConfigPanel.tsx` | Extracted dense icon/label/control shell for tag and field definition settings; control behavior remains definition-scoped. |
| `RowLeading` | `RowLeading.tsx`, `RowMarker.tsx` | Leading control cluster is isolated; marker visuals are split from chevron and drill-down behavior. |
| `FieldEntryGrid` | `FieldEntryGrid.tsx`, `OutlinerFieldRow.tsx` | Extracted for field name, value, and description slots without owning commit behavior. |
| `TrailingInput` | `TrailingInput.tsx`, `TrailingInputLeading.tsx` | Leading display is isolated; ProseMirror mount, creation, triggers, paste, and option behavior stay local. |
| `NodeDescription` | `NodeDescription.tsx`, `NodeDescriptionSurface.tsx` | Read/edit visuals are isolated; draft state, commit, focus, and keyboard behavior stay local. |
| `OutlinerViewChrome` | `OutlinerView.tsx`, `OutlinerViewChrome.tsx` | Group heading and hidden-field reveal visuals are isolated; row building and reveal state stay local. |
| `OutlinerRowShell` | `OutlinerRowShell.tsx`, `OutlinerItem.tsx`, `OutlinerFieldRow.tsx` | Extracted wrapper/inner-row structure; behavior and row model stay with existing row code. |
| `OutlinerRow` | `OutlinerItem.tsx`, row files | Must wrap existing behavior without replacing row model. |
| `AgentMessage` | `AgentMessageRow.tsx`, `AgentMessageFrame.tsx`, `AgentBranchNavigator.tsx` | Message frame and branch navigation are extracted; copy/edit/retry/regenerate behavior remains in the row. |
| `AgentProcessBlock` | `AgentProcessBlock.tsx`, `AgentProcessTimeline.tsx`, `AgentThinkingBlock.tsx`, `AgentToolCallBlock.tsx`, `AgentToolCallDisclosure.tsx` | Process summary, timeline, thinking row/body, and tool disclosure shell are isolated; expand state and tool data stay caller-owned. |
| `Composer` | `AgentComposer.tsx`, `AgentComposerControls.tsx`, `AgentComposerModelMenu.tsx` | Queued follow-up controls, attachment chip, model picker, reasoning menu/switch, and send/stop slot are extracted; textarea draft, file processing, menu state, and provider updates stay in `AgentComposer`. |

## Full Refactor Plan

This pass finishes the UI system rather than preserving a temporary stopping
point.
The work is sequenced by dependency order, but every item below is in scope for
the unified refactor branch.

### 1. Inventory, Contracts, And Site Source Map

- Keep this inventory current while product code changes.
- Remove stale gaps after each product boundary lands.
- Update `components.md`, `surfaces.md`, `outliner.md`, and `agent.md` before
  or alongside product changes.
- Keep `index.html` specimens mapped to real product source files and shared
  token names.

### 2. Foundations And Tokens

- Align product `:root` tokens with `foundations.md`.
- Canonicalize text, muted text, theme accent, semantic success/danger,
  selected rows, overlay active rows, focus rings, radius, elevation, z-index,
  panel widths, shell widths, row rhythm, tag colors, and agent dock sizing.
- Move repeated CSS values into tokens when they express system decisions.
- Keep behavior-specific measurements local only when they belong to a domain
  contract such as outliner row geometry.

### 3. Shell And Workspace Layout

- Finish app shell, top chrome, sidebar, workspace tab strip, workspace canvas,
  panel surface, panel close/more actions, resize handles, agent dock placement,
  collapse states, minimum widths, overflow, and responsive desktop behavior.
- Validate left/right panel insets, chevron gutter, title column, tag column,
  and More action alignment as one panel geometry system.

### 4. Shared Overlay Infrastructure

- Add shared anchored overlay positioning for trigger popovers, context menus,
  option pickers, model menus, and floating editor toolbar.
- Keep modal dialogs on the shared `Dialog` primitive.
- Normalize z-index, elevation, active rows, Escape/outside dismissal,
  viewport collision, focus restoration, and role/item semantics.

### 5. Outliner And Tags

- Finish `NodePanel`, heading structure, breadcrumb, title icon/check/title,
  description, title tags, heading fields, panel actions, definition
  configuration, outliner rows, row leading states, field rows, descriptions,
  trailing input, applied tags, tag selectors, and row state visuals.
- Preserve current selection, editing, paste, trigger, drag/drop, collapse,
  checkbox, and keyboard behavior.
- Validate tag hover stability, row text-start stability, and nodex-style row
  parity.

### 6. Rich Text, Cursor, And IME

- Recheck `RichTextEditor`, ProseMirror selection, inline reference atoms,
  description editing, field-value editing, split/merge behavior, trigger
  anchors, paste, undo/redo, and Chinese IME composition after visual changes.
- Keep text editing behavior close to the current nodex-compatible contract.

### 7. Agent System

- Finish agent dock, chat panel, turn stack, message frames, branch navigation,
  thinking disclosure, process timeline, tool-call disclosure, bounded
  input/output payloads, composer, queued follow-up, model/reasoning controls,
  settings dialog, debug surfaces, and approval/tool-preview states.
- Use sider-agent only as an interaction-structure reference; visual style
  remains Lin's own token system.

### 8. Validation And Closure

- Add or update targeted renderer/e2e coverage for every changed boundary.
- Run full validation before merge: typecheck, core tests, renderer tests, e2e
  tests, build, `git diff --check`, and screenshot review at desktop and
  narrow desktop widths.
- Update `progress.md` and `index.html` after each completed boundary so docs,
  site, and product code stay synchronized.

## Refactor Rule

No UI refactor should start from CSS alone. Start from the inventory item, then
choose the owning design-system module:

1. Inventory item and source files.
2. Product pattern in `patterns.md`.
3. Surface rule in `surfaces.md`.
4. Component contract in `components.md`.
5. Token and accessibility requirements in `foundations.md`.
6. Implementation and validation rules in `implementation.md`.
