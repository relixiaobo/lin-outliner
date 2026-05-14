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
| App shell | `App.tsx`, `TopBar.tsx`, `Sidebar.tsx`, `WorkspaceCanvas.tsx`, `AgentDock.tsx` | `patterns.md`, `surfaces.md` | Structure mostly aligned; tokens and responsive rules incomplete. |
| Workspace tabs | `TopBar.tsx`, `useWorkspaceTabs.ts` | `components.md`, `patterns.md` | Real behavior exists; close/reorder semantics need component contract. |
| Multi-panel canvas | `WorkspaceCanvas.tsx`, `useResizableLayout.ts`, `useWorkspaceTabs.ts` | `patterns.md`, `surfaces.md` | Real tiled panels exist; minimum width and overflow strategy incomplete. |
| Outliner panel | `NodePanel.tsx`, `OutlinerView.tsx`, `OutlinerItem.tsx` | `surfaces.md`, `components.md` | Real product UI exists; should remain authoritative for rows. |
| Outliner rows | `OutlinerItem.tsx`, `RowLeading.tsx`, `RowHost.tsx`, `useOutlinerRowInteraction.ts` | `components.md` | Rich behavior exists; visual primitives are not yet isolated. |
| Editor | `RichTextEditor.tsx`, `FloatingEditorToolbar.tsx`, `editorRegistry.ts` | `components.md`, `implementation.md` | ProseMirror-based editor is core infrastructure; toolbar needs shared overlay treatment. |
| Tags | `TagBar.tsx`, `tagColors.ts`, `TagSelector.tsx`, `BatchTagSelector.tsx` | `components.md`, `patterns.md` | Behavior exists; applied tag hover layout is not yet the stable gapped model. |
| Fields and definitions | `DefinitionConfigPanel.tsx`, `FieldValueRenderer.tsx`, `OptionsPicker.tsx`, field row files | `components.md`, `surfaces.md` | Domain controls exist; need component-level form/control primitives. |
| Commands | `CommandPalette.tsx`, `useWorkspaceKeyboard.ts` | `components.md`, `implementation.md` | Core overlay exists; should share menu/list primitives. |
| Node menus | `NodeContextMenu.tsx`, `TriggerPopover.tsx`, `SlashCommandMenu.tsx`, `ReferenceSelector.tsx` | `components.md`, `implementation.md` | Multiple menu systems exist; keyboard/focus and positioning should converge. |
| Agent dock | `AgentDock.tsx`, `AgentChatPanel.tsx` | `surfaces.md`, `patterns.md` | Real surface exists and is persistent; tokens and message primitives need consolidation. |
| Agent messages | `AgentMessageRow.tsx`, `AgentProcessBlock.tsx`, `AgentToolCallBlock.tsx` | `components.md`, `surfaces.md` | Useful production UI exists; needs component contracts for message, process, and tool-call blocks. |
| Agent composer | `AgentComposer.tsx` | `components.md`, `surfaces.md` | Rich behavior exists; model menu and reasoning controls should use shared popover/menu primitives. |
| Agent settings | `AgentSettingsDialog.tsx` | `components.md`, `implementation.md` | Dialog exists; should share modal, field, button, and alert primitives. |
| Icons | `icons.ts` | `foundations.md`, `components.md` | Central alias file exists; icon sizes need token alignment. |
| CSS tokens | `styles.css` | `foundations.md` | Product tokens diverge from canonical design-system tokens. |

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

Gaps:

- Product CSS does not yet expose canonical width tokens for sidebar min/max,
  agent min/max, or outline panel minimum width.
- Panel resize uses proportional `MIN_PANEL_SIZE` instead of the
  `--outline-panel-min-width` contract.
- Canvas uses `overflow: hidden`; the design system requires horizontal
  scrolling when minimum panel widths exceed available width.
- Responsive collapse rules are not implemented beyond one narrow CSS tweak.
- Resize handles do not support keyboard resizing.

## Outliner

Source:

- `src/renderer/ui/NodePanel.tsx`
- `src/renderer/ui/outliner/OutlinerView.tsx`
- `src/renderer/ui/outliner/OutlinerItem.tsx`
- `src/renderer/ui/outliner/RowLeading.tsx`
- `src/renderer/ui/outliner/RowHost.tsx`
- `src/renderer/ui/outliner/useOutlinerRowInteraction.ts`
- `src/renderer/ui/outliner/TrailingInput.tsx`
- `src/renderer/ui/outliner/DoneCheckbox.tsx`
- `src/renderer/ui/outliner/IndentGuide.tsx`
- `src/renderer/ui/outliner/NodeDescription.tsx`

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

Gaps:

- Row visual pieces are not yet formal component primitives:
  `OutlinerRow`, `RowLeading`, `RowBullet`, `DoneCheckbox`,
  `NodeDescription`, `TrailingInput`.
- Shell CSS and row CSS share one large file, which makes accidental row rhythm
  changes likely.
- Focus-visible treatment is inconsistent because global button focus is reset.
- Field rows and content rows share concepts but not a documented visual
  contract.

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

Gaps:

- Applied tag CSS still uses inline-flex spacing and opacity swapping. It does
  not yet implement the gapped relative layout from `patterns.md`.
- Hover/focus state does not use a same-measured-box absolute overlay.
- Tag background pill behavior is not yet standardized across applied tags,
  selector tags, batch selector rows, and trashed tags.
- Keyboard/focus treatment for tag remove and tag open controls needs explicit
  validation.

## Agent

Source:

- `src/renderer/ui/AgentDock.tsx`
- `src/renderer/ui/agent/AgentChatPanel.tsx`
- `src/renderer/ui/agent/AgentComposer.tsx`
- `src/renderer/ui/agent/AgentMessageRow.tsx`
- `src/renderer/ui/agent/AgentProcessBlock.tsx`
- `src/renderer/ui/agent/AgentToolCallBlock.tsx`
- `src/renderer/ui/agent/AgentSettingsDialog.tsx`

Current state:

- Agent dock is persistent and resizable.
- Chat panel has header, status dots, empty suggestions, streaming state, error
  state, messages, process blocks, tool-call blocks, composer, model menu,
  reasoning control, queued follow-up, and settings dialog.
- Provider settings include model, reasoning, base URL, API key, enable switch,
  remove provider, remove key, save/cancel, and alerts.

Aligned:

- Agent dock is separate from workspace tabs.
- Header title follows `# conversation`.
- Agent surface is real, not a placeholder.
- Tool calls and process/thinking blocks are visible product concepts.

Gaps:

- Agent messages, process blocks, tool-call blocks, composer controls, and
  settings dialog are not documented as component contracts.
- Agent model menu uses a local floating menu implementation instead of shared
  popover/menu primitives.
- Agent settings dialog has its own button, field, alert, and dialog styles.
- Composer typography and rounded surfaces are more prominent than the rest of
  the dense desktop system; tokens need normalization before visual polish.

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

Gaps:

- There is no shared overlay host or shared positioning primitive.
- Menu/list item visuals are duplicated across command palette, context menus,
  trigger popovers, options picker, and agent model menu.
- Focus trapping and roving focus are not consistently defined.
- Z-index values and elevation are not yet tokenized against `foundations.md`.

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

Gaps:

- Definition config rows need a documented dense form-row primitive.
- Field controls use several local input styles without shared input tokens.
- Color, select, switch, and number controls should map to component contracts
  before broader visual refactors.

## Shared Component Candidates

These are not necessarily files yet. They are the component boundaries that
should stabilize before broad UI refactors.

| Candidate | Current sources | Notes |
| --- | --- | --- |
| `IconButton` | top chrome, panel close, agent actions, toolbar buttons | Needs size, hover, active, disabled, focus-visible variants. |
| `ToolbarButton` | `FloatingEditorToolbar`, agent message actions, top chrome | May be an `IconButton` variant. |
| `WorkspaceTab` | `TopBar.tsx` | Needs active, hover, close, count, focus, future reorder states. |
| `PanelSurface` | `WorkspaceCanvas.tsx`, `styles.css` | Owns radius, active outline, close slot, scroll container. |
| `ResizeHandle` | `WorkspaceCanvas.tsx`, `Sidebar.tsx`, `AgentDock.tsx` | Needs pointer and keyboard behavior. |
| `AppliedTag` | `TagBar.tsx` | Needs gapped relative layout and keyboard-reachable remove/open controls. |
| `MenuSurface` | node context menu, command palette, trigger popover, model menu | Needs elevation, radius, z-index, width, positioning rules. |
| `MenuItem` | command item, context item, popover item, model item | Needs icon slot, label slot, meta slot, active/selected/disabled states. |
| `Dialog` | `AgentSettingsDialog.tsx`, command palette overlay | Needs modal semantics, header/body/footer, focus management. |
| `FormField` | agent settings, definition config, field value rows | Needs label, help/error, input, select, switch, color, number variants. |
| `OutlinerRow` | `OutlinerItem.tsx`, row files | Must wrap existing behavior without replacing row model. |
| `AgentMessage` | `AgentMessageRow.tsx` | Needs user, assistant, error, streaming, copy action states. |
| `AgentProcessBlock` | `AgentProcessBlock.tsx`, `AgentToolCallBlock.tsx` | Needs collapsed/expanded, pending/done/error, input/output sections. |
| `Composer` | `AgentComposer.tsx` | Needs textarea, toolbar, send/stop, model picker, reasoning controls. |

## Refactor Phases

### Phase 0: Inventory And Contracts

- Keep this inventory current.
- Add or refine component contracts in `components.md`.
- Add surface-specific rules in `surfaces.md`.
- Do not change product visuals until the target component boundary is named.

### Phase 1: Foundations And Shell

- Align product `:root` tokens with `foundations.md`.
- Add missing width tokens: sidebar min/max, agent min/max,
  `--outline-panel-min-width`, and focus ring.
- Implement responsive shell defaults and minimum panel overflow behavior.
- Keep row typography untouched.

### Phase 2: Shared Primitives

- Extract `IconButton`, `ResizeHandle`, `WorkspaceTab`, `PanelSurface`,
  `MenuSurface`, `MenuItem`, `Dialog`, and `FormField` where they reduce real
  duplication.
- Keep behavior local if abstraction would obscure domain rules.

### Phase 3: Outliner And Tags

- Stabilize applied tag hover layout.
- Document and protect outliner row rhythm.
- Consolidate row leading, bullet, checkbox, description, field row, and
  trailing input visual contracts.

### Phase 4: Agent System

- Normalize agent message, process, tool-call, composer, model menu, and
  settings dialog components against shared primitives.
- Preserve current agent behavior while reducing duplicated menu/form/button
  styling.

### Phase 5: Overlay And Accessibility Pass

- Introduce a shared overlay host if needed.
- Normalize z-index, elevation, menu positioning, focus-visible, Escape, outside
  click, and focus management.
- Add screenshot checks for shell states and interaction checks for keyboard
  reachable controls.

## Refactor Rule

No UI refactor should start from CSS alone. Start from the inventory item, then
choose the owning design-system module:

1. Inventory item and source files.
2. Product pattern in `patterns.md`.
3. Surface rule in `surfaces.md`.
4. Component contract in `components.md`.
5. Token and accessibility requirements in `foundations.md`.
6. Implementation and validation rules in `implementation.md`.
