# Surfaces

Surfaces are persistent or repeated product areas. They are larger than
components and smaller than product workflows. Start from
[`inventory.md`](./inventory.md) to find current source ownership, then use
[`components.md`](./components.md) for reusable primitives.

## Surface Rules

- A product surface must map to real behavior. Do not create fake product panels
  that look editable but are not backed by product state.
- Surfaces should be dense, quiet, and useful. Avoid marketing-page composition,
  decorative cards, large empty hero-like areas, and ornamental color.
- Shell and panel surfaces use neutral hierarchy. Brand or semantic color is
  sparse and action-specific.
- Surface CSS may control layout, scroll, padding, and containment. It must not
  override outliner row rhythm or editor behavior unless the outliner module owns
  that change.
- Shared primitives should be used where they reduce duplication, but domain
  behavior stays with the owning surface.

## Top Chrome

Top chrome is shell-level, not tab-owned.

Current sources:

- `src/renderer/ui/TopBar.tsx`
- `src/renderer/ui/icons.ts`
- `src/renderer/styles.css`

Regions:

- Left: native window space, sidebar toggle, back, forward.
- Center: workspace tabs and new-tab affordance.
- Right: agent toggle and account/global affordance.

Visual rules:

- Background: same as app background.
- Controls are icon-first.
- Disabled history controls remain visible but muted.
- Sidebar toggle must collapse/expand the sidebar.
- Agent icon must collapse/expand the agent dock.
- Workspace tabs and top chrome controls share the same vertical center line.
- Tabs represent workspace canvas layouts, not agent conversations.
- Active tab uses `--tab-active-bg`.
- Inactive tabs are transparent until hover.
- Tab labels are compact: `13px`, semibold only when active.
- Tabs should not visually dominate panels.
- Tabs can eventually support close/reorder, but the UI must not show a close
  affordance that does nothing.

Component dependencies:

- `IconButton`
- `WorkspaceTab`

## Sidebar Dock

The sidebar is persistent across tabs.

Current sources:

- `src/renderer/ui/Sidebar.tsx`
- `src/renderer/ui/useResizableLayout.ts`
- `src/renderer/styles.css`

Lin's current primary entries:

- Today
- Search
- Supertags
- Library
- Recents

Visual rules:

- Default width: `196px`.
- Resize range: `152px` to `280px`.
- Collapsed width: `0px`.
- Background: app gray, not a white card.
- Primary nav starts below the chrome with compact, non-decorative spacing.
- Primary entries use icons, not hash prefixes.
- Item height: `24px`.
- Item text: `13px`.
- Icon size: `16px`.
- Active item uses a subtle gray row highlight.
- Disabled entries use lower opacity but preserve layout.

Behavior:

- Sidebar root navigation updates the active panel root.
- Alternate open-panel behavior may exist, but it must be discoverable before it
  becomes core UI.
- Resize handle sits on the boundary between sidebar and canvas.

Collapsed sidebar:

- Content is hidden.
- The top chrome sidebar icon remains the only reopen control.
- Collapsing does not reset selected tab, panels, or outliner selection.

Component dependencies:

- `IconButton`
- `ResizeHandle`
- `MenuItem`-like nav rows, if extracted.

## Workspace Canvas

The canvas is the active tab's content area.

Current sources:

- `src/renderer/ui/WorkspaceCanvas.tsx`
- `src/renderer/ui/useWorkspaceTabs.ts`
- `src/renderer/ui/useResizableLayout.ts`
- `src/renderer/styles.css`

Visual rules:

- Canvas background is app gray.
- Panels sit directly on the canvas with the same `--layout-gap` used by the
  shell outer inset.
- Panels are white surfaces with `8px` radius.
- Panels are not nested inside another visible card.
- Panels use the real outliner implementation.

Panel behavior:

- Every visible panel must be a real outliner panel.
- Every panel can navigate its own root.
- The active panel is the target for keyboard commands when focus is in the
  workspace canvas.
- Closing the active panel moves active focus to the nearest remaining panel.
- Closing the last panel is not allowed.
- Panel resize preserves adjacent panel total size.
- If minimum panel widths exceed available canvas width, the canvas scrolls
  horizontally instead of shrinking panels below minimum width.

Component dependencies:

- `PanelSurface`
- `ResizeHandle`
- `OutlinerRow` through `NodePanel`

## Outliner Panel

All panels must use the same outliner typography and row system. Do not create
custom large-font preview panels in product UI.

Current sources:

- `src/renderer/ui/NodePanel.tsx`
- `src/renderer/ui/panelBreadcrumb.ts`
- `src/renderer/styles.css`

Regions:

- Breadcrumb.
- Heading area.
- Optional node icon.
- Optional title checkbox when done/check behavior is enabled.
- Title editor.
- Optional title description.
- Dedicated title tag row.
- Title action buttons, including More for the same node action surface as the
  row context menu.
- Optional heading field rows.
- Optional definition configuration.
- Optional definition template label.
- Outliner body.
- Trailing input.

Typography:

- Panel title: outliner contract title style, currently implemented through
  `NodePanel`.
- Row text: outliner contract row rhythm, currently implemented through
  outliner rows.
- Placeholder text: muted outliner placeholder rhythm.
- Metadata and descriptions: muted outliner metadata rhythm.

Spacing:

- Panel internal padding is `10px` top, `28px` left/right, and `30px` bottom on
  desktop.
- Breadcrumb-to-title spacing is `28px` by default.
- Panel header and row indentation are owned by `NodePanel`.
- Top-level outliner rows may bleed the chevron slot into the left gutter so
  row bullets align with the panel header content start. The internal row
  leading grid remains unchanged.
- Header action controls align to the panel content right edge. Do not add a
  second header-only right inset on top of `--panel-content-x`.
- Wrapper CSS may control panel surface size and scroll behavior, but should not
  override row font size or row rhythm.

Close control:

- Top-right inside panel.
- Small, muted, visible only when multiple panels are open.
- Hover state may show subtle gray background.
- It must be clickable and actually close the panel.

Active panel indication:

- The active panel should be visible without looking selected as content.
- Use a subtle neutral outline or shadow, for example
  `0 0 0 1px rgba(9, 9, 11, 0.10)`.
- Do not use brand color for active panel indication.

Component dependencies:

- `PanelSurface`
- `IconButton`
- `PanelBreadcrumb`
- `OutlinerRow`
- `FieldEntryRow`
- `AppliedTag`
- `FormField` for definition configuration.

## Outliner Body

The outliner body is the core editable content surface. Its behavior is more
important than visual reuse.

Current sources:

- `src/renderer/ui/outliner/OutlinerView.tsx`
- `src/renderer/ui/outliner/OutlinerItem.tsx`
- `src/renderer/ui/outliner/RowLeading.tsx`
- `src/renderer/ui/outliner/TrailingInput.tsx`
- `src/renderer/ui/outliner/NodeDescription.tsx`
- `src/renderer/ui/outliner/useOutlinerRowInteraction.ts`

Visual rules:

- Rows remain compact and text-first.
- Bullet, chevron, checkbox, editor, tags, and description align on a stable row
  grid.
- Content, reference, tag definition, field definition, field entry, selected,
  completed, expanded, collapsed, and trailing rows must all preserve the same
  row rhythm.
- Hover and selected states are neutral gray.
- Completed rows may reduce emphasis but remain readable.
- Drag/drop indicators must not shift row text.
- Indent guides are subtle and should not read as card borders.
- Field rows use name/value grids inside the row rhythm, not standalone form
  cards.

Behavior:

- Keyboard editing, row selection, drag, paste, split, merge, indent, outdent,
  and trigger behavior remain owned by outliner code.
- Row extraction must wrap existing behavior rather than replacing it.
- Context menus and trigger popovers must preserve selection semantics.
- Field value commit timing remains field-specific.

Component dependencies:

- `OutlinerRow`
- `RowLeading`
- `FieldEntryRow`
- `RichTextEditor`
- `AppliedTag`
- `MenuSurface`
- `MenuItem`

## Tags And Metadata

Tags and metadata stay attached to outliner content, but placement depends on
the surface: row tags are inline after row text; title tags live in the
dedicated heading tag row.

Current sources:

- `src/renderer/ui/tags/TagBar.tsx`
- `src/renderer/ui/tags/tagColors.ts`
- `src/renderer/ui/outliner/TagSelector.tsx`
- `src/renderer/ui/outliner/BatchTagSelector.tsx`
- `src/renderer/ui/outliner/NodeDescription.tsx`

Visual rules:

- Row applied tags render inline after node text.
- Title applied tags render in the dedicated title tag row.
- Applied tags must not become detached chip strips or separate cards during
  normal editing.
- Descriptions are muted metadata, not separate cards.
- Tag colors follow the user-defined palette from `foundations.md`.
- Remove affordances should feel precise, not destructive by default.

Behavior:

- Tag label opens tag search or tag surface.
- Remove action removes only the target tag.
- Context menu can expose remove, everything tagged, and configure actions.
- Batch tag selector is an overlay workflow, not an inline row surface.

Component dependencies:

- `AppliedTag`
- `TagSelectorItem`
- `MenuSurface`
- `MenuItem`

## Editor And Inline Controls

The editor surface is ProseMirror-backed and shared by outliner rows and panel
titles.

Current sources:

- `src/renderer/ui/editor/RichTextEditor.tsx`
- `src/renderer/ui/editor/FloatingEditorToolbar.tsx`
- `src/renderer/ui/editor/pmSchema.ts`
- `src/renderer/ui/editor/richTextCodec.ts`

Visual rules:

- Editor content inherits row or title typography from its parent surface.
- Inline references use semantic inline styling without becoming chips that
  break text flow.
- Floating toolbar uses low elevation and compact icon buttons.
- Selection toolbar must not cover the selected text when space allows.

Behavior:

- IME composition, selection, paste parsing, inline refs, marks, trigger
  detection, and split/merge signals are core editor behavior.
- Visual refactors must preserve ProseMirror selection and composition behavior.
- Trigger menus are overlays anchored to editor caret position.

Component dependencies:

- `RichTextEditor`
- `ToolbarButton`
- `MenuSurface`
- `MenuItem`

## Fields And Definition Configuration

Fields and definition configuration are dense product configuration surfaces,
not generic settings pages.

Current sources:

- `src/renderer/ui/definition/DefinitionConfigPanel.tsx`
- `src/renderer/ui/outliner/OutlinerFieldRow.tsx`
- `src/renderer/ui/outliner/FieldValueRenderer.tsx`
- `src/renderer/ui/outliner/FieldValueRow.tsx`
- `src/renderer/ui/outliner/OptionsPicker.tsx`
- `src/renderer/ui/outliner/ViewToolbar.tsx`

Visual rules:

- Definition configuration rows are dense grid rows.
- Field values and definition configuration share the same dense icon, name, and
  value row primitive while preserving outliner rhythm.
- Icons describe field meaning but should not dominate labels.
- Switch, select, color, number, and text controls use shared form tokens.
- Invalid number or field values must be visible without using color alone.

Behavior:

- Field controls commit on the existing product timing: immediate, blur, or
  explicit selection depending on field type.
- Option picker is a small overlay connected to the field value row; it uses
  the shared popover listbox shell while option creation and commit timing stay
  field-owned.
- View toolbar visibility is node configuration, not shell state.

Component dependencies:

- `FormField`
- `MenuSurface`
- `MenuItem`
- `PopoverListbox`
- `IconButton`

## Command Palette

The command palette is a modal command/search surface.

Current sources:

- `src/renderer/ui/CommandPalette.tsx`
- `src/renderer/ui/useWorkspaceKeyboard.ts`

Visual rules:

- Modal overlay uses level 2 elevation.
- Search input is the primary focus.
- Results use compact command rows.
- Footer action bar is secondary to the result list.
- Empty and loading states should be compact, not illustrative.

Behavior:

- Opens through keyboard command.
- Escape closes.
- Arrow keys move active result.
- Enter activates selected result.
- Mouse enter may update active result.
- Create action is shown only when query supports creation.

Component dependencies:

- `Dialog` or modal overlay primitive.
- `MenuSurface`
- `MenuItem`
- `FormField`

## Context Menus And Popovers

Context menus and popovers are transient surfaces anchored to rows, editors,
fields, or toolbar controls.

Current sources:

- `src/renderer/ui/outliner/NodeContextMenu.tsx`
- `src/renderer/ui/outliner/TriggerPopover.tsx`
- `src/renderer/ui/outliner/SlashCommandMenu.tsx`
- `src/renderer/ui/outliner/ReferenceSelector.tsx`
- `src/renderer/ui/outliner/OptionsPicker.tsx`
- `src/renderer/ui/outliner/PopoverList.tsx`
- `src/renderer/ui/agent/AgentComposer.tsx`

Visual rules:

- Level 1 elevation.
- Compact rows with stable icon slots.
- Search/input headers stay visually attached to the surface.
- Submodes, such as context menu tag or move mode, keep the same menu width
  where practical.
- Popovers must stay inside viewport bounds.

Behavior:

- Escape closes.
- Outside pointer down closes non-modal surfaces.
- Searchable popovers keep keyboard navigation predictable.
- Trigger and field-option listboxes share option-row structure; active index,
  filtering, positioning, and execution remain caller-owned.
- Context menu actions must apply to the current selection, not only the row
  under the pointer, when a multi-selection is active.

Component dependencies:

- `MenuSurface`
- `MenuItem`
- `PopoverListbox`
- `TagSelectorItem`
- `FormField`

## Agent Dock

The agent dock is persistent across tabs and independent from the workspace
canvas. Detailed interaction rules live in [`agent.md`](./agent.md).

Current sources:

- `src/renderer/ui/AgentDock.tsx`
- `src/renderer/ui/agent/AgentChatPanel.tsx`
- `src/renderer/ui/useResizableLayout.ts`

Visual rules:

- Default width: `344px`.
- Resize range: `280px` to `520px`.
- Collapsed width: `0px`.
- Background: app gray.
- Header aligns with panel top region.
- Header title is `# conversation`.
- The agent dock may show a disabled or empty state only if the backing behavior
  is not ready.
- The dock uses Lin's neutral palette and low elevation; it must not copy
  sider-agent's warm paper treatment.
- The dock should never look heavier than the central outliner panels.

Collapsed agent:

- Content is hidden.
- The top chrome agent icon remains the reopen control.
- Collapsing does not affect tabs, panels, or sidebar state.

Component dependencies:

- `ResizeHandle`
- `IconButton`
- `AgentMessage`
- `AgentComposer`

## Agent Chat

Agent chat is the dock's conversational content surface.
See [`agent.md`](./agent.md) for the turn model and sider-agent reference
boundary.

Current sources:

- `src/renderer/ui/agent/AgentChatPanel.tsx`
- `src/renderer/ui/agent/AgentMessageRow.tsx`
- `src/renderer/ui/agent/AgentProcessBlock.tsx`
- `src/renderer/ui/agent/AgentToolCallBlock.tsx`

Visual rules:

- Assistant content should read as text/process content, not nested card stacks.
- User messages may use compact muted bubbles.
- Process and tool-call blocks are compact, collapsible, and subordinate to
  final assistant text.
- Streaming indicator should be visible but quiet.
- Error state uses semantic danger and icon.
- Message actions reveal on hover/focus-within but remain keyboard reachable.
- Tool-call rows use stable icon and label slots across pending, done, and error
  states.
- Process details may use a subtle timeline rule, not a separate card for every
  event.
- Tool-call rows should not rely on a background or border per row in normal
  states; hierarchy comes from grouping, indentation, icon slots, and text
  weight.
- A tool call's default state is one action-summary row. Input/output payloads
  appear only in the expanded state and must be bounded so long output does not
  dominate the chat.

Behavior:

- Empty suggestions are real send actions.
- Copy actions copy the relevant message text.
- Process/tool-call details preserve input/output legibility.
- Chat scroll should stick to bottom only when the user is already near bottom.
- Assistant turns should merge prose, thinking, and tool calls into one readable
  turn-level stack.
- Process blocks may auto-collapse after final prose appears, but explicit user
  expand/collapse choices must win over automatic state.
- The normal completed-turn view is collapsed summary plus final response.
  Expanded thinking/tool details are an inspection state, not the default
  reading state.

Component dependencies:

- `AgentMessage`
- `AgentProcessBlock`
- `IconButton`
- `MenuItem`-like rows for process details where useful.

## Agent Composer

The agent composer is an input and control surface at the bottom of the agent
dock. Detailed behavior lives in [`agent.md`](./agent.md).

Current sources:

- `src/renderer/ui/agent/AgentComposer.tsx`
- `src/renderer/ui/agent/AgentComposerControls.tsx`
- `src/renderer/ui/agent/AgentComposerModelMenu.tsx`

Visual rules:

- Composer remains compact and dock-native.
- Textarea is the primary affordance.
- Model and reasoning controls are secondary.
- Settings has a direct secondary icon in the toolbar and may also be repeated
  inside the model menu.
- Send/stop action is clear and icon-first.
- Send and stop occupy the same primary action slot.
- Queued follow-up preview is visible but not a modal interruption.
- Attachment chips, if enabled, are compact inline objects above the textarea.

Behavior:

- Enter sends unless Shift is held or IME composition is active.
- During streaming, submitting text queues a follow-up or steer.
- Stop replaces send when streaming and no draft is present.
- Model picker and reasoning controls use overlay/menu behavior.
- Model/reasoning menu and conversation picker positioning use the shared
  anchored overlay model; open state, provider updates, and composer draft
  behavior remain in `AgentComposer` / `AgentChatPanel`.
- Textarea auto-resizes up to a bounded maximum height.
- Drag, paste, and picker attachments are optional and must be implemented as
  one coherent attachment model if shipped.
- Failed send restores draft state only when doing so does not overwrite newer
  user input.

Component dependencies:

- `AgentComposer`
- `AgentComposerControls`
- `AgentComposerModelMenu`
- `IconButton`
- `MenuSurface`
- `MenuItem`
- `SwitchControl`
- `FormField`
- `AnchoredOverlay`

## Agent Settings Dialog

Agent settings is a modal configuration surface.

Current sources:

- `src/renderer/ui/agent/AgentSettingsDialog.tsx`

Visual rules:

- Dialog uses level 2 elevation.
- Information architecture is sectioned as Provider, Connection, Model
  behavior, alert/notice, and footer actions.
- Provider choices are compact buttons that distinguish active, configured, and
  available providers.
- Connection owns Provider ID, Base URL, API key, key status, and enabled state.
- Model behavior owns Model ID, reasoning level, and context metadata.
- API key removal sits next to the API key field; provider removal stays in the
  footer as the secondary destructive action.
- Destructive provider removal is secondary unless the dialog is specifically in
  a destructive confirmation state.
- API key input should clearly indicate configured state without showing secret
  values.

Behavior:

- Loading, saving, error, and saved notice states are explicit.
- Save persists provider, model, reasoning, base URL, enabled state, and API key
  when supplied.
- Removing key and removing provider are real actions and should require clear
  visual affordance.
- Native input/select behavior is wrapped by shared form primitives; settings
  keeps provider/model persistence local.

Component dependencies:

- `Dialog`
- `FormField`
- `TextInputControl`
- `SelectControl`
- `ButtonControl`
- `CheckboxControl`
- `IconButton`

## Agent Debug Panel

Agent debug is an inspection surface for provider payloads and runtime
accounting. It lives in a workspace panel, not in the normal chat reading flow.

Current sources:

- `src/renderer/ui/agent/AgentDebugPanel.tsx`

Visual rules:

- Information architecture is Overview, Request Context, Provider Timeline.
- Overview is a compact metric strip: session, model, context, and status.
- Request context owns token budget, system prompt, tool schemas, and raw request
  payload links.
- Provider timeline owns query, round, message, response, and raw provider
  payload details.
- Long JSON, tool schema, thinking, tool input, and tool output bodies are
  bounded scroll regions.
- Debug cards may use subtle section backgrounds, but they must remain quieter
  than the primary outliner panel and agent chat.

Behavior:

- Refresh is an explicit icon action.
- Copy actions copy only the adjacent raw/debug payload.
- Disclosure rows preserve browser-native summary behavior while using the
  shared icon button primitive for actions.

Component dependencies:

- `IconButton`

## Agent Approval And Tool Preview

Approval and preview are trust surfaces for agent actions that may mutate the
outline.

Current sources:

- `src/core/agentTypes.ts`
- `src/main/agentNodeTools.ts`

Current product state:

- `AgentApprovalRequestEvent` exists in the runtime event type system.
- No renderer approval overlay is currently shipped.
- Node tool preview is exposed through `previewOnly` tool arguments and compact
  preview results.

Visual rules:

- Approval, when shipped, attaches to the requesting agent turn and uses the
  modal/dialog hierarchy only when the user must decide before the tool can
  continue.
- Tool preview summaries lead with status, affected node/reference counts,
  warnings, and next read step.
- Raw preview JSON, diffs, or long payloads are expanded details with bounded
  scroll regions.
- Do not render fake approval controls in the design-system site before product
  behavior exists; show the contract boundary instead.

Behavior:

- Approval actions must be explicit and keyboard reachable.
- Preview-only tool calls do not mutate state.
- Destructive previews use danger only for the destructive confirmation action,
  not for every preview row.

## Overlay Layering

Overlay surfaces include command palette, context menus, trigger popovers,
editor toolbar, options picker, model menu, and agent settings.

Rules:

- Use the elevation and z-index scale from `foundations.md`.
- Prefer a shared shell-level overlay host when clipping or stacking conflicts
  appear.
- Do not create arbitrary z-index values for each new overlay.
- Focus-visible must remain visible inside overlays.
- Escape and outside-click behavior must be explicit per surface.
- Modal overlays trap focus; non-modal popovers do not trap focus unless their
  interaction model requires it.
