# Components

This module defines reusable component-level visual and interaction contracts.
Start from [`inventory.md`](./inventory.md) to find the current product source
files. Layout and workflow behavior belongs in [`patterns.md`](./patterns.md).
Surface-level rules belong in [`surfaces.md`](./surfaces.md).

## Contract Rules

Every component contract must define:

- Purpose: why the component exists.
- Current sources: existing product files that implement or approximate it.
- Structure: required slots and DOM responsibilities.
- States: default, hover, active/pressed, selected, disabled, focus-visible, and
  loading where relevant.
- Accessibility: names, roles, keyboard behavior, focus behavior, and hit
  targets.
- Non-goals: behavior the component must not own.

Do not extract a component just because two class names look similar. Extract
only when the component boundary preserves product behavior and removes real
duplication.

## Interaction States

Every clickable control must define:

- Default.
- Hover.
- Active/pressed.
- Disabled.
- Focus-visible.

State rules:

- Focus-visible must remain visible. Do not remove `outline` or `box-shadow`
  without a replacement from `--focus-ring`.
- Disabled controls use actual `disabled` when they cannot act.
- Toggle controls use `aria-pressed`, `aria-expanded`, or `role="switch"` with
  `aria-checked`, depending on meaning.
- Icon-only controls need an accessible name through `aria-label` or equivalent
  visible text.
- Hover effects must not change measured size unless the component explicitly
  owns layout expansion.
- If a control exists and is enabled, it must perform a real action.

## IconButton

Current sources:

- `src/renderer/ui/TopBar.tsx`
- `src/renderer/ui/WorkspaceCanvas.tsx`
- `src/renderer/ui/AgentDock.tsx`
- `src/renderer/ui/agent/AgentMessageRow.tsx`
- `src/renderer/ui/editor/FloatingEditorToolbar.tsx`

Purpose:

- Compact icon-only command used in dense desktop chrome, toolbars, panel
  actions, message actions, and inline controls.

Structure:

- Root is a `button`.
- One icon slot using an alias from `src/renderer/ui/icons.ts`.
- Optional active/pressed state.
- Optional disabled state.
- Optional tooltip through `title` until a shared tooltip exists.

Variants:

- `chrome`: `26px` square, used in top chrome.
- `panel`: `22px` square, used for panel close and compact panel controls.
- `toolbar`: `28px` square, used in floating editor toolbar.
- `message`: `26px` square, used in agent message actions.
- `tiny`: `17px` to `20px`, used for tab close and compact inline controls.

States:

- Default: transparent background, neutral icon.
- Hover: `--control-hover`.
- Active/pressed/selected: `--control-active`.
- Disabled: muted icon and no hover.
- Focus-visible: visible `--focus-ring`.

Accessibility:

- Icon-only buttons require `aria-label`.
- Toggle buttons use `aria-pressed`.
- Disclosure buttons use `aria-expanded`.
- Minimum pointer hit area should be `24px` where the surrounding layout allows
  it.

Non-goals:

- IconButton does not own menu positioning, dialog state, or command execution.

## ToolbarButton

Current sources:

- `src/renderer/ui/editor/FloatingEditorToolbar.tsx`
- `src/renderer/ui/agent/AgentMessageRow.tsx`
- `src/renderer/ui/agent/AgentComposer.tsx`

Purpose:

- IconButton variant for temporary or contextual toolbars.

Structure:

- Root is an IconButton-compatible `button`.
- Supports active state for toggled formatting or selected tool mode.

States:

- Active state must be visually distinct without using brand color as the
  everyday active fill.
- Toolbar buttons inside overlays inherit overlay elevation and do not add their
  own card surfaces.

Accessibility:

- Formatting controls use clear labels such as `Bold`, `Italic`, `Code`, and
  `Highlight`.

## WorkspaceTab

Current sources:

- `src/renderer/ui/TopBar.tsx`
- `src/renderer/ui/useWorkspaceTabs.ts`

Purpose:

- Represents a workspace canvas layout, not an agent conversation.

Structure:

- Container owns tab shape and active visual state.
- Trigger button owns tab selection.
- Title slot truncates with ellipsis.
- Optional count slot shows number of visible panels.
- Optional close button appears only when closing is allowed.

States:

- Inactive: transparent until hover.
- Hover: subtle neutral fill.
- Active: `--tab-active-bg`, semibold title.
- Focus-visible: ring on trigger or close control.
- Disabled is not expected for normal workspace tabs.

Behavior:

- Selecting a tab activates its workspace layout.
- Closing a tab must be a real action.
- Do not show close affordance if only one tab can remain.
- Future reorder should preserve the same slots rather than changing tab shape.

Accessibility:

- Tab strip uses a navigation or tablist landmark.
- Active tab exposes `aria-current="page"` or equivalent.
- Close button label includes the tab title.

## PanelSurface

Current sources:

- `src/renderer/ui/WorkspaceCanvas.tsx`
- `src/renderer/ui/NodePanel.tsx`
- `src/renderer/styles.css`

Purpose:

- Structural white outliner surface inside the gray workspace canvas.

Structure:

- Surface container with `--panel-size`.
- Scroll container for real `NodePanel`.
- Top-right close slot when multiple panels are visible.
- Active-panel indication.

States:

- Default: white panel, `--panel-radius`.
- Active: subtle neutral outline or inset shadow.
- Multiple panels: close control available.
- Single panel: close control hidden or absent.

Behavior:

- Every product panel must contain a real `NodePanel`.
- PanelSurface does not own outliner row typography or row rhythm.
- Closing the last panel is not allowed.

Accessibility:

- Close button has accessible name.
- Active panel must be understandable through focus behavior, not color alone.

## ResizeHandle

Current sources:

- `src/renderer/ui/WorkspaceCanvas.tsx`
- `src/renderer/ui/Sidebar.tsx`
- `src/renderer/ui/AgentDock.tsx`
- `src/renderer/ui/useResizableLayout.ts`

Purpose:

- Resize boundary for sidebar, agent dock, and adjacent workspace panels.

Structure:

- Real button with accessible label.
- Hit area uses `--resize-hit-width`.
- Visible pill is centered inside an `8px` structural gap.
- Panel-to-panel handles live in a real gap slot, not inside either panel.

States:

- Default: invisible or very low emphasis.
- Hover/focus-visible/resizing: visible centered pill.
- Disabled: hidden or inert if resizing is unavailable.

Behavior:

- Pointer dragging adjusts width or adjacent panel ratio.
- Keyboard resizing should support arrow keys before resize is considered
  complete.
- Resize must respect canonical min/max tokens.

Accessibility:

- Use `aria-label` such as `Resize sidebar`, `Resize agent`, or
  `Resize panels`.
- Keyboard resizing should announce or expose the current size when practical.

## AppliedTag

Current sources:

- `src/renderer/ui/tags/TagBar.tsx`
- `src/renderer/ui/tags/tagColors.ts`

Purpose:

- Inline applied tag shown after node text or panel title.

Structure:

- Root owns measured inline width and row height.
- Normal state contains hash marker and label.
- Hover/focus state swaps inside the same measured box to remove target plus a
  label-only pill.
- Remove target and label target are separate interactive controls.

Color rules:

- Use `600` for tag text/icons and `50` for tag backgrounds.
- Do not rely on color alone to communicate destructive or selected states.
- Remove target is muted gray by default and turns Rose only on precise
  hover/focus.

Layout rules:

- Normal state owns the measured width.
- Hover/focus state is constrained to that exact box with
  `position: absolute; inset: 0`.
- Use a gapped relative layout so icon and text anchors do not move.
- Normal text starts at `6px left padding + 12px icon slot + 8px gap`.
- Hover text starts at
  `6px left padding + 12px remove slot + 2px physical gap + 6px label padding`.
- Both text starts resolve to `26px`.
- A real `2px` physical gap separates the remove icon from the label-only pill.
- Hover interactions must not change the tag's measured width or row height.

Behavior:

- Label click opens tag search or tag surface.
- Remove click removes the tag.
- Context menu may expose remove, everything tagged, and configure actions.

Accessibility:

- Remove control is keyboard reachable and has an accessible label.
- Label control has a meaningful title or label.
- Focus-visible must not move the tag or row.

## TagSelectorItem

Current sources:

- `src/renderer/ui/outliner/TagSelector.tsx`
- `src/renderer/ui/outliner/BatchTagSelector.tsx`
- `src/renderer/ui/outliner/NodeContextMenu.tsx`

Purpose:

- Selectable tag candidate in trigger menus, batch apply UI, and context menu
  tag mode.

Structure:

- Icon or hash slot.
- Label slot.
- Optional create/new indicator.
- Optional selected or already-applied state.

Behavior:

- Existing tag applies the tag.
- Create item creates and applies the new tag.
- Already-applied tags should be disabled or clearly marked.

## MenuSurface

Current sources:

- `src/renderer/ui/CommandPalette.tsx`
- `src/renderer/ui/outliner/NodeContextMenu.tsx`
- `src/renderer/ui/outliner/TriggerPopover.tsx`
- `src/renderer/ui/outliner/SlashCommandMenu.tsx`
- `src/renderer/ui/outliner/ReferenceSelector.tsx`
- `src/renderer/ui/outliner/OptionsPicker.tsx`
- `src/renderer/ui/agent/AgentComposer.tsx`

Purpose:

- Floating selection or command surface used for menus, popovers, model pickers,
  and contextual actions.

Structure:

- Surface container.
- Optional search/input header.
- Optional group headings.
- MenuItem list.
- Optional footer/action row.

States:

- Default elevation uses level 1 from `foundations.md`.
- Modal command palette may use level 2 overlay treatment.
- Empty state is compact and muted.
- Active item uses neutral hover/selected fill.

Behavior:

- Escape closes the surface.
- Outside pointer down closes non-modal surfaces.
- Keyboard navigation should use roving active item where the menu is a list of
  commands.
- Positioning must stay within viewport.

Accessibility:

- Menu-like surfaces use appropriate `role="menu"`/`menuitem"` only when menu
  keyboard semantics are implemented.
- Searchable listboxes should expose listbox/option semantics or keep focus in
  the input with active descendant.

## MenuItem

Current sources:

- `src/renderer/ui/CommandPalette.tsx`
- `src/renderer/ui/outliner/NodeContextMenu.tsx`
- `src/renderer/ui/outliner/OptionsPicker.tsx`
- `src/renderer/ui/agent/AgentComposer.tsx`

Purpose:

- Dense row item for commands, navigation choices, model choices, field options,
  and context actions.

Structure:

- Optional icon slot.
- Primary label slot.
- Optional meta/right slot.
- Optional check/selected slot.

States:

- Default.
- Hover.
- Active keyboard selection.
- Selected/current.
- Disabled.
- Destructive.

Rules:

- Icon slot width must be stable so labels align.
- Meta text truncates before primary label when space is constrained.
- Destructive rows use Rose text/icon, not a solid destructive fill unless they
  are primary destructive actions.

## Dialog

Current sources:

- `src/renderer/ui/agent/AgentSettingsDialog.tsx`
- `src/renderer/ui/CommandPalette.tsx`

Purpose:

- Modal surface for settings, confirmation, and command workflows.

Structure:

- Backdrop.
- Dialog surface.
- Header with title and optional subtitle.
- Body.
- Optional alert/notice region.
- Footer actions.

States:

- Loading.
- Error.
- Saving/submitting.
- Disabled actions.

Behavior:

- Backdrop click may close only when data loss is not possible.
- Escape closes only when safe or after confirmation.
- Primary action appears at the trailing edge of the footer.
- Destructive action is visually distinct but not dominant unless it is the
  primary purpose.

Accessibility:

- Use `role="dialog"` and `aria-modal="true"`.
- Dialog needs an accessible title.
- Focus should move into the dialog on open and return to the invoking control
  on close.
- Focus should be trapped while modal is open.

## FormField

Current sources:

- `src/renderer/ui/agent/AgentSettingsDialog.tsx`
- `src/renderer/ui/definition/DefinitionConfigPanel.tsx`
- `src/renderer/ui/outliner/FieldValueRenderer.tsx`
- `src/renderer/ui/outliner/OptionsPicker.tsx`

Purpose:

- Dense form control row for settings, definition configuration, and field
  values.

Structure:

- Label.
- Control.
- Optional icon.
- Optional help/meta text.
- Optional error/validation state.

Variants:

- Text input.
- Number input.
- Select.
- Checkbox.
- Switch.
- Color picker.
- Password/API key input.
- Option picker.

States:

- Default.
- Hover where the control is interactive.
- Focus-visible/focus-within.
- Invalid.
- Disabled.
- Read-only.

Rules:

- Definition configuration rows are dense and grid-based.
- Field value rows preserve outliner row rhythm.
- Settings fields can be roomier than outliner fields, but still use the same
  token scale.

Accessibility:

- Every control has a visible label or `aria-label`.
- Switches use `role="switch"` and `aria-checked`.
- Invalid fields expose an error message when validation blocks action.

## OutlinerRow

Current sources:

- `src/renderer/ui/outliner/OutlinerItem.tsx`
- `src/renderer/ui/outliner/RowLeading.tsx`
- `src/renderer/ui/outliner/RowHost.tsx`
- `src/renderer/ui/outliner/useOutlinerRowInteraction.ts`

Purpose:

- Editable outliner row with leading affordance, rich text editor, metadata,
  tags, description, selection, drag, and child hierarchy.

Structure:

- Row wrapper.
- Leading slot: chevron, bullet, tag glyph, reference marker, or field icon.
- Content line: checkbox, rich text editor, applied tags, description.
- Optional trigger popover.
- Optional context menu.
- Optional children and trailing input.

States:

- Default.
- Hover.
- Selected.
- Focused/editing.
- Dragging/drop target.
- Completed.
- Locked/read-only.
- Expanded/collapsed.

Rules:

- Row typography is owned by the existing outliner implementation:
  `15px / 24px` for row editors, `13px / 18px` for descriptions.
- Row geometry is fixed to the current outliner rhythm: `26px` minimum row
  height, `42px` leading slot, `15px 4px 15px 8px` leading columns, and
  selection fill starting at `21px`.
- Shell CSS must not override row font size or row rhythm.
- Applied tags render inline after node text using the future `AppliedTag`
  visual contract: fixed measured pill, stable hover/focus swap, and no row
  height or text-start movement. Current `TagBar` behavior is a migration
  source, not the future visual style.
- Normal content rows, reference rows, tag definition rows, field definition
  rows, field entry rows, completed rows, selected rows, and expanded/collapsed
  parent rows must all keep the same text-start grid.
- Bullet, chevron, indentation, selection, and edit/focus behavior should follow
  [`../ui-behavior.md`](../ui-behavior.md).
- Component extraction must wrap current behavior rather than replacing the row
  interaction model.

Accessibility:

- Editing and selection behavior must remain keyboard-first.
- Drag affordances need pointer behavior now and keyboard alternative later.
- Context menu should be reachable through keyboard shortcuts.

## RowLeading

Current sources:

- `src/renderer/ui/outliner/RowLeading.tsx`
- `src/renderer/ui/outliner/NodeBulletDot.tsx`
- `src/renderer/ui/outliner/fieldTypePresentation.tsx`

Purpose:

- Stable leading control cluster for outliner hierarchy and node type.

Structure:

- Chevron button.
- Bullet/open button.
- Optional type icon, reference marker, or tag glyph.
- Optional conic tag color indicator.

Rules:

- Chevron and bullet slots must keep fixed dimensions to avoid text jitter.
- Leading variants must cover content, reference, tag definition, field entry,
  and field definition rows.
- Collapsed/expanded state may change marker treatment, but must not shift row
  content.
- Double-click drill-down is product behavior and should remain owned by row
  interaction code.
- `tabIndex={-1}` may remain while row editor owns keyboard navigation, but the
  keyboard equivalent for open/collapse must be documented elsewhere.

## FieldEntryRow

Current sources:

- `src/renderer/ui/outliner/OutlinerFieldRow.tsx`
- `src/renderer/ui/outliner/FieldValueRenderer.tsx`
- `src/renderer/ui/outliner/FieldValueRow.tsx`
- `src/renderer/ui/outliner/OptionsPicker.tsx`

Purpose:

- Inline field row with editable field name, value renderer, optional child
  preview, and optional description.

Structure:

- Row wrapper and `RowLeading` field variant.
- Field name column.
- Field value column.
- Optional value child-count preview when expanded.
- Optional description spanning both columns.

Rules:

- Field rows use a grid, not a card or standalone form.
- Value renderers must cover plain text, options, options-from-tag, date,
  number, password, formula, user, URL, email, checkbox, boolean, and color.
- Invalid value state must not change row height or text start.
- Expanded field rows with children show a preview/focus affordance instead of
  duplicating child content in the value cell.

## PanelBreadcrumb

Current sources:

- `src/renderer/ui/panelBreadcrumb.ts`
- `src/renderer/ui/NodePanel.tsx`

Purpose:

- Compact ancestor navigation inside an outliner panel.

Rules:

- Workspace/root ancestors are hidden.
- Long ancestry collapses to first visible ancestor and last two visible
  ancestors with an ellipsis marker.
- Breadcrumb remains muted and subordinate to title.
- Breadcrumb buttons are real navigation actions.

## RichTextEditor

Current sources:

- `src/renderer/ui/editor/RichTextEditor.tsx`
- `src/renderer/ui/editor/FloatingEditorToolbar.tsx`
- `src/renderer/ui/editor/pmSchema.ts`
- `src/renderer/ui/editor/richTextCodec.ts`

Purpose:

- ProseMirror-backed editor used for panel titles and outliner rows.

Structure:

- Editor mount.
- Optional placeholder.
- Optional floating toolbar.
- Trigger anchor for slash, tag, reference, and field popovers.

Behavior:

- Owns text editing, mark toggles, inline reference selection, paste parsing,
  IME-safe keyboard handling, split/merge signals, trigger detection, and
  selection toolbar.

Rules:

- Do not replace this with a plain textarea for outliner rows.
- Visual changes must preserve ProseMirror selection and composition behavior.
- Floating toolbar should eventually use MenuSurface/ToolbarButton primitives.

## AgentMessage

See [`agent.md`](./agent.md) for the full agent turn model.

Current sources:

- `src/renderer/ui/agent/AgentMessageRow.tsx`

Purpose:

- Message row for user and assistant turns in the persistent agent dock.

Structure:

- Row container with role variant.
- User bubble or assistant content stack.
- Optional copy action.
- Optional error block.
- Optional streaming caret or capsule.
- Optional process/tool-call blocks.
- Optional actions: copy, retry, edit, regenerate, or branch controls when the
  product owns those commands.

States:

- User.
- Assistant.
- Streaming.
- Error.
- Copied.
- Empty pending assistant turn.
- Editing.
- Retrying/regenerating.

Rules:

- User messages may use compact bubbles.
- Assistant messages should read as content, not as nested cards.
- Assistant entries that belong to the same model turn should render as one
  turn-level stack.
- Final assistant prose is primary; process details are secondary and
  collapsed-first after a successful response.
- Message actions reveal on hover/focus-within but remain keyboard reachable.
- Error state uses semantic danger color and icon.
- Hidden thinking is not copied by default.

Accessibility:

- Copy actions need labels.
- Streaming indicator needs an accessible label unless purely decorative.
- Edit mode must preserve keyboard focus and expose save/cancel controls.

## AgentProcessBlock

See [`agent.md`](./agent.md) for process and tool-call behavior.

Current sources:

- `src/renderer/ui/agent/AgentProcessBlock.tsx`
- `src/renderer/ui/agent/AgentToolCallBlock.tsx`

Purpose:

- Collapsible representation of thinking, process segments, and tool calls.

Structure:

- Toggle row with chevron, status icon, and summary.
- Optional timeline/details section.
- Optional input and output sections for tool calls.
- Optional inline media or download affordance when the tool result is the
  content the user needs to inspect.

States:

- Collapsed.
- Expanded.
- Pending.
- Done.
- Error.
- Streaming.

Rules:

- Pending state may animate a spinner.
- Error state uses semantic danger.
- Process details may expand while live and collapse after final prose appears.
- User expand/collapse overrides must survive streaming updates and re-renders.
- Thinking and tool calls are grouped process-layer details for one assistant
  turn, not standalone response content.
- Thinking rows support collapsed preview and expanded full-text states.
- Tool rows default to one action-summary line.
- Expanded tool rows may show bounded input/output payload details.
- Long input/output payloads must scroll or truncate inside the detail area
  instead of expanding the dock indefinitely.
- Details use monospace only for exact tool input/output.
- Tool summaries should be concise and action-based.
- Tool rows should use stable icon slots so labels do not jump across status
  changes.

Accessibility:

- Toggle uses `aria-expanded`.
- Disabled toggle only when no details exist.

## AgentComposer

See [`agent.md`](./agent.md) for the full composer contract.

Current sources:

- `src/renderer/ui/agent/AgentComposer.tsx`

Purpose:

- Agent input area with message text, send/stop, queued follow-up, model picker,
  reasoning controls, and settings entry.

Structure:

- Optional queued follow-up preview.
- Composer surface.
- Textarea.
- Toolbar row.
- Attachment slot.
- Model picker.
- Reasoning switch/menu.
- Send/stop action.
- Single primary action slot shared by send and stop.
- Secondary control group for attachment, model, reasoning, and settings.

States:

- Idle.
- Draft.
- Submitting.
- Streaming.
- Steering/follow-up queued.
- Drag-over attachment, if attachments are enabled.
- Attachment error, if attachments are enabled.
- Config loading/disabled.

Behavior:

- Enter sends unless composing IME or Shift is held.
- When streaming, draft submits as steering/follow-up.
- Stop action replaces send action when streaming and no draft is present.
- Textarea auto-resizes up to a bounded maximum height.
- Composer layout must make the textarea visually primary; toolbar controls are
  compact and secondary.
- Failed send restores the draft only if the user has not started a new draft.
- Model and reasoning controls must stay usable without visually dominating the
  dock.
- Attachments are optional for the first Lin pass; if enabled, use compact chips
  and avoid turning the dock into a file browser.

Accessibility:

- Textarea has `aria-label`.
- Send/stop/action buttons have labels.
- Model picker exposes expanded state and menu semantics.

## Component Priority

Refactor priority should follow dependency order:

1. `IconButton`, `ResizeHandle`, `WorkspaceTab`, `PanelSurface`.
2. `AppliedTag`.
3. `MenuSurface` and `MenuItem`.
4. `Dialog` and `FormField`.
5. `OutlinerRow`, `RowLeading`, `RichTextEditor` contracts.
6. `AgentMessage`, `AgentProcessBlock`, `AgentComposer`.

This order keeps shell and token work stable before touching complex outliner
and agent behavior.
