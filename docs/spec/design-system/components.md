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

## CheckboxMark

Current sources:

- `src/renderer/ui/primitives/CheckboxMark.tsx`
- `src/renderer/ui/outliner/DoneCheckbox.tsx`
- `src/renderer/ui/agent/AgentSettingsDialog.tsx`
- `src/renderer/styles.css`

Purpose:

- Stable visual mark for checkbox-like done or enabled state.
- Represents the visual state only; it does not own click handling, keyboard
  handling, persistence, or row behavior.

Structure:

- Root is a decorative `span` with a fixed measured box.
- Checked state keeps the same measured box and adds an internal `CheckIcon`
  glyph from `src/renderer/ui/icons.ts`.
- The parent control owns button semantics and accessible naming.

States:

- No checkbox: parent row renders no `CheckboxMark`; the row shows only its
  normal bullet.
- Unchecked: neutral filled square using the shared measured box.
- Checked: success filled square using `--semantic-success` with white internal
  check glyph.
- Hover may adjust fill color, but it must not change the measured box.

Accessibility:

- `CheckboxMark` is decorative and uses `aria-hidden`.
- The parent button, row, label, or field control exposes `aria-pressed`,
  `aria-checked`, label text, and keyboard behavior as appropriate.

Non-goals:

- CheckboxMark does not own `Mod+Enter` cycling, mouse toggling, row selection,
  completion timestamps, settings persistence, or title/row layout.

## IconButton

Current sources:

- `src/renderer/ui/primitives/IconButton.tsx`
- `src/renderer/ui/TopBar.tsx`
- `src/renderer/ui/WorkspaceCanvas.tsx`
- `src/renderer/ui/NodePanel.tsx`
- `src/renderer/ui/agent/AgentChatPanel.tsx`
- `src/renderer/ui/agent/AgentComposer.tsx`
- `src/renderer/ui/agent/AgentMessageRow.tsx`
- `src/renderer/ui/editor/FloatingEditorToolbar.tsx`

Purpose:

- Compact icon-only command used in dense desktop chrome, toolbars, panel
  actions, message actions, and inline controls.

Structure:

- Root is a `button`.
- One icon slot using an alias from `src/renderer/ui/icons.ts`.
- Icon SVG receives a fixed slot and must not decide the button's measured
  size.
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

## MenuSurface

Current sources:

- `src/renderer/ui/primitives/MenuSurface.tsx`
- `src/renderer/ui/outliner/NodeContextMenu.tsx`
- `src/renderer/ui/outliner/PopoverList.tsx`
- `src/renderer/ui/agent/AgentComposer.tsx`

Purpose:

- Shared menu/popover surface wrapper for dense command lists, context menus,
  trigger popovers, option pickers, and model menus.
- Keeps ref, role, className, style, and preserve-selection wiring consistent
  without owning open state or keyboard behavior.

Structure:

- Root is a `div`.
- The caller supplies role: `menu`, `listbox`, or no role when an existing
  surface already owns semantics.
- The caller supplies surface className so product-specific size, elevation,
  and positioning remain local.

States:

- Surface open/closed state is owned by the caller.
- Positioning is supplied by the caller, usually through `useAnchoredOverlay`.
- Preserve-selection is opt-in for outliner context menus and other popovers
  that must not clear block selection.

Accessibility:

- The caller owns focus management, Escape handling, outside click, and
  keyboard navigation.
- Surface role must match the item role used inside it.

Non-goals:

- MenuSurface does not own portal rendering, anchor calculation, roving focus,
  filtering, or command execution.

## AnchoredOverlay

Current sources:

- `src/renderer/ui/primitives/useAnchoredOverlay.ts`
- `src/renderer/ui/outliner/TriggerPopover.tsx`
- `src/renderer/ui/outliner/NodeContextMenu.tsx`
- `src/renderer/ui/tags/TagBar.tsx`
- `src/renderer/ui/outliner/OptionsPicker.tsx`
- `src/renderer/ui/outliner/TrailingInput.tsx`
- `src/renderer/ui/editor/FloatingEditorToolbar.tsx`
- `src/renderer/ui/agent/AgentComposerModelMenu.tsx`
- `src/renderer/ui/agent/AgentChatPanel.tsx`

Purpose:

- Shared viewport-aware overlay positioning for anchored popovers, pointer
  context menus, selection toolbars, and agent menus.
- Keeps margin, flip, clamp, max-height, and scroll/resize reflow behavior in
  one place.

Rules:

- Callers provide an anchor rect, anchor element ref, or pointer-derived anchor.
- Callers still own open state, dismissal, focus restoration, keyboard
  navigation, and command behavior.
- Overlays must not invent local z-index stacks; use design-system z tokens.

## MenuItem

Current sources:

- `src/renderer/ui/primitives/MenuItem.tsx`
- `src/renderer/ui/CommandPalette.tsx`
- `src/renderer/ui/outliner/PopoverList.tsx`
- `src/renderer/ui/outliner/BatchTagSelector.tsx`
- `src/renderer/ui/outliner/NodeContextMenu.tsx`
- `src/renderer/ui/agent/AgentComposer.tsx`

Purpose:

- Shared button row with icon, label, and optional meta slots.
- Keeps measured row layout and active class naming stable while allowing each
  menu to preserve its own behavior and semantics.

Structure:

- Root is a `button`.
- Optional icon slot.
- Required label slot.
- Optional meta slot.
- The caller supplies class names for the root and slots so existing surfaces
  keep their local visual contract.

States:

- Default.
- Active/highlighted through an explicit active class.
- Disabled through native `disabled` when the row cannot act, or
  `aria-disabled` when focus/selection behavior still needs the row to remain
  present.
- Selected state is caller-owned through `aria-selected`, `data-selected`, or
  surface-specific class names.

Accessibility:

- Listbox items use `role="option"` and `aria-selected`.
- Menu items use `role="menuitem"` where the surrounding surface is a menu.
- The caller owns keyboard navigation and focus restoration.

Non-goals:

- MenuItem does not own search, async loading, creation flows, submenu state,
  or close-on-select behavior.

## PopoverListbox

Current sources:

- `src/renderer/ui/outliner/PopoverList.tsx`
- `src/renderer/ui/outliner/TriggerPopover.tsx`
- `src/renderer/ui/outliner/OptionsPicker.tsx`
- `src/renderer/ui/outliner/TrailingInput.tsx`
- `src/renderer/ui/outliner/TagSelector.tsx`
- `src/renderer/ui/outliner/ReferenceSelector.tsx`
- `src/renderer/ui/outliner/SlashCommandMenu.tsx`

Purpose:

- Shared outliner listbox shell and option-row structure for trigger
  suggestions, field option pickers, and trailing option pickers.
- Removes duplicated popover item markup while preserving each caller's product
  behavior.

Structure:

- `PopoverListbox` wraps `MenuSurface` and defaults to `role="listbox"`.
- `PopoverListItem` wraps `MenuItem` and defaults to `role="option"`.
- Optional icon, label, meta, empty, and bullet-placeholder slots.
- The caller supplies surface class names, positioning style, active state, and
  item action handlers.

States:

- Active item exposes `aria-selected` and `data-selected`.
- Disabled items use `aria-disabled` when they must remain visible in the list.
- Empty state is compact and muted through `PopoverEmpty`.
- Hover and active visuals must not change row height or icon-slot width.

Accessibility:

- Trigger, tag, reference, slash, and field-option popovers need an accessible
  listbox label.
- Keyboard navigation, focus retention, Escape close, and focus restoration
  stay with the caller because each surface is anchored to different editor
  state.

Non-goals:

- PopoverListbox does not own filtering, positioning, active-index updates,
  field option creation, tag/reference creation, command execution, or
  close-on-select behavior.

## WorkspaceTab

Current sources:

- `src/renderer/ui/WorkspaceTab.tsx`
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
- `TopBar` owns the surrounding strip, create-tab action, and shell controls.

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

- `src/renderer/ui/WorkspacePanelSurface.tsx`
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
- `WorkspaceCanvas` still decides which product surface is rendered inside the
  shell.

States:

- Default: white panel, `--panel-radius`.
- Active: subtle neutral outline or inset shadow.
- Multiple panels: close control available.
- Single panel: close control hidden or absent.

Behavior:

- Every product panel must contain a real `NodePanel`.
- PanelSurface does not own outliner row typography or row rhythm.
- Closing the last panel is not allowed.
- PanelSurface does not own tab state, panel root navigation, or resize math.

Accessibility:

- Close button has accessible name.
- Active panel must be understandable through focus behavior, not color alone.

## ResizeHandle

Current sources:

- `src/renderer/ui/primitives/ResizeHandle.tsx`
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

- `src/renderer/ui/tags/AppliedTag.tsx`
- `src/renderer/ui/tags/TagBar.tsx`
- `src/renderer/ui/tags/tagColors.ts`

Purpose:

- Measured applied tag used inline after outliner row text and inside the
  dedicated title tag segment.

Structure:

- Root owns measured inline width and row height.
- Normal state contains hash marker and label.
- Hover/focus state swaps the hash/remove icon inside the same fixed leading
  slot and turns the label segment into a label-only pill.
- Remove target and label target are separate interactive controls.

Color rules:

- Use `600` for tag text/icons and `50` for tag backgrounds.
- Do not rely on color alone to communicate destructive or selected states.
- Remove target is muted gray by default and turns Rose only on precise
  hover/focus.

Layout rules:

- Normal state owns the measured width.
- Hover/focus state is constrained to the exact same inline box; icon visibility
  changes with opacity inside the fixed leading slot.
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

- `src/renderer/ui/outliner/NodeContextMenu.tsx`
- `src/renderer/ui/outliner/PopoverList.tsx`
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
- `src/renderer/ui/outliner/PopoverList.tsx`
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

- `src/renderer/ui/primitives/Dialog.tsx`
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
- `Dialog` owns the backdrop wrapper, semantic dialog surface, and title
  linkage. Header, body, footer content, and action behavior stay caller-owned.

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
- Current primitive wires the semantic surface, `aria-labelledby` or
  `aria-label`, Escape close hook, Tab focus trap, caller-provided initial
  focus, initial surface focus fallback, and focus restoration.

## FormField

Current sources:

- `src/renderer/ui/primitives/FormField.tsx`
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
- `FormField` owns only the visible label/control wrapper; control behavior and
  validation stay with the calling surface.

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

## SwitchControl

Current sources:

- `src/renderer/ui/primitives/SwitchControl.tsx`
- `src/renderer/ui/definition/DefinitionConfigPanel.tsx`

Purpose:

- Shared semantic wrapper for binary on/off controls.

Structure:

- Root is a `button`.
- Caller supplies visual children, such as track, thumb, and text.
- Caller supplies surface-specific class names.

States:

- Off.
- On.
- Disabled through native `disabled`.
- Focus-visible through the caller's surface class.

Behavior:

- Click toggles `checked` through `onCheckedChange`.
- Custom click handlers may prevent the default toggle when a surface needs
  additional validation.

Accessibility:

- Uses `role="switch"`.
- Uses `aria-checked`.
- Requires an accessible `label`.

Non-goals:

- SwitchControl does not own visual track/thumb styling, labels like `Yes/No`,
  persistence, or setting-specific validation.

## SelectControl

Current sources:

- `src/renderer/ui/primitives/SelectControl.tsx`
- `src/renderer/ui/definition/DefinitionConfigPanel.tsx`

Purpose:

- Shared wrapper for native select controls.

Structure:

- Root is a native `select`.
- Caller supplies options and surface-specific class names.
- Caller owns value, change behavior, and domain coercion.

States:

- Default.
- Focus-visible/focus.
- Disabled through native `disabled`.

Accessibility:

- Requires a `label` that maps to `aria-label`.
- Select semantics remain native.

Non-goals:

- SelectControl does not own custom menu rendering, filtering, async options,
  option creation, or popover positioning.

## TextInputControl

Current sources:

- `src/renderer/ui/primitives/TextInputControl.tsx`
- `src/renderer/ui/definition/DefinitionConfigControls.tsx`
- `src/renderer/ui/definition/DefinitionConfigPanel.tsx`

Purpose:

- Shared wrapper for native text inputs that need an accessible label.

Structure:

- Root is a native `input type="text"`.
- Caller supplies value, change behavior, placeholder, class names, and keyboard
  handling.

States:

- Default.
- Focus-visible/focus.
- Disabled through native `disabled`.
- Invalid through caller-owned attributes and classes.

Accessibility:

- Requires a `label` that maps to `aria-label`.
- Text input semantics remain native.

Non-goals:

- TextInputControl does not own draft state, commit-on-blur, Enter commit,
  Escape revert, validation, persistence, or password/search variants.

## NumberInputControl

Current sources:

- `src/renderer/ui/primitives/NumberInputControl.tsx`
- `src/renderer/ui/definition/DefinitionConfigControls.tsx`
- `src/renderer/ui/definition/DefinitionConfigPanel.tsx`

Purpose:

- Shared wrapper for native number inputs that need an accessible label.

Structure:

- Root is a native `input type="number"`.
- Caller supplies value parsing, invalid handling, class names, and keyboard
  behavior.

States:

- Default.
- Focus-visible/focus.
- Disabled through native `disabled`.
- Invalid through caller-owned attributes and classes.

Accessibility:

- Requires a `label` that maps to `aria-label`.
- Number input semantics remain native.

Non-goals:

- NumberInputControl does not own number parsing, empty-value semantics,
  min/max validation, commit timing, or persistence.

## DefinitionConfigControls

Current sources:

- `src/renderer/ui/definition/DefinitionConfigControls.tsx`
- `src/renderer/ui/definition/DefinitionConfigPanel.tsx`
- `src/renderer/styles/outliner.css`

Purpose:

- Definition-specific control family for tag and field configuration rows.

Structure:

- Field type select.
- Hide-field select.
- Tag select.
- Switch.
- Color input pair.
- Number input.

Rules:

- These controls are definition-scoped, not global primitives.
- They may compose global primitives such as `SelectControl`, `SwitchControl`,
  `TextInputControl`, and `NumberInputControl`.
- Draft state, commit timing, parsing, and Escape revert may live here when the
  behavior is specific to definition configuration.
- `DefinitionConfigPanel` owns mapping config items to controls and persistence
  patches; the controls own only local input interaction.

Accessibility:

- Every control exposes a label through native control labels or `aria-label`.
- Decorative inline glyphs are hidden from assistive technology.

## DefinitionConfigRow

Current sources:

- `src/renderer/ui/definition/DefinitionConfigRowShell.tsx`
- `src/renderer/ui/definition/DefinitionConfigControls.tsx`
- `src/renderer/ui/definition/DefinitionConfigPanel.tsx`
- `src/renderer/styles/outliner.css`

Purpose:

- Dense configuration row for tag and field definition settings.

Structure:

- Icon slot.
- Label slot.
- Control slot.
- Stable `data-config-key` hook for tests and targeted styling.

States:

- Default.
- Focus-within through the owned control.
- Disabled or unavailable through the owned control.

Rules:

- The shell owns only icon/label/control geometry.
- Controls remain local to `DefinitionConfigPanel` until each control family has
  a shared contract.
- Definition config rows may share visual rhythm with field value rows, but they
  are not editable outliner rows and should not inherit row selection behavior.

Accessibility:

- Decorative row icons are hidden from assistive technology.
- Each control must expose its own label or `aria-label`.

## OutlinerRow

Current sources:

- `src/renderer/ui/outliner/OutlinerItem.tsx`
- `src/renderer/ui/outliner/OutlinerRowShell.tsx`
- `src/renderer/ui/outliner/RowLeading.tsx`
- `src/renderer/ui/outliner/RowHost.tsx`
- `src/renderer/ui/outliner/useOutlinerRowInteraction.ts`
- `src/renderer/styles/outliner.css`

Purpose:

- Editable outliner row with leading affordance, rich text editor, metadata,
  tags, description, selection, drag, and child hierarchy.

Structure:

- `OutlinerRowShell` wrapper and inner `.row` surface.
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

- Row typography follows the outliner design contract and current product
  rhythm: `15px / 24px` for row editors, `13px / 18px` for descriptions.
- Row geometry is fixed to the current outliner rhythm: `26px` minimum row
  height, `42px` leading slot, `15px 4px 15px 8px` leading columns, and
  selection fill starting at `21px`.
- Panel placement may offset the top-level row wrapper left by the row bullet
  start offset so the bullet column aligns with the panel title/tag column
  while the chevron sits in the gutter.
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
- `OutlinerRowShell` owns only wrapper class structure; selection, context menu,
  drag/drop, expansion, and keyboard behavior stay with row interaction code.

Accessibility:

- Editing and selection behavior must remain keyboard-first.
- Drag affordances need pointer behavior now and keyboard alternative later.
- Context menu should be reachable through keyboard shortcuts.

## RowLeading

Current sources:

- `src/renderer/ui/outliner/RowLeading.tsx`
- `src/renderer/ui/outliner/RowMarker.tsx`
- `src/renderer/ui/outliner/NodeBulletDot.tsx`
- `src/renderer/ui/outliner/fieldTypePresentation.tsx`

Purpose:

- Stable leading control cluster for outliner hierarchy and node type.

Structure:

- Chevron button.
- Bullet/open button.
- `RowMarker` visual shape for type icon, reference marker, tag glyph, or conic
  tag color indicator.

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
- `src/renderer/ui/outliner/FieldEntryGrid.tsx`
- `src/renderer/ui/outliner/FieldValueRenderer.tsx`
- `src/renderer/ui/outliner/FieldValueRow.tsx`
- `src/renderer/ui/outliner/OptionsPicker.tsx`

Purpose:

- Inline field row with editable field name, value renderer, optional child
  preview, and optional description.

Structure:

- Row wrapper and `RowLeading` field variant.
- `FieldEntryGrid` name, value, and optional description slots.
- Value slot may render a typed value control or a child-count preview when
  expanded.

Rules:

- Field rows use a grid, not a card or standalone form.
- Value renderers must cover plain text, options, options-from-tag, date,
  number, password, formula, user, URL, email, checkbox, boolean, and color.
- Invalid value state must not change row height or text start.
- Expanded field rows with children show a preview/focus affordance instead of
  duplicating child content in the value cell.

## TrailingInput

Current sources:

- `src/renderer/ui/outliner/TrailingInput.tsx`
- `src/renderer/ui/outliner/TrailingInputLeading.tsx`
- `src/renderer/ui/outliner/RowMarker.tsx`

Purpose:

- Empty outliner row used to create the next child or sibling inside the
  current scope.

Structure:

- Row wrapper with the same leading width as normal rows.
- `TrailingInputLeading` renders a dimmed content marker through `RowMarker`.
- ProseMirror editor mount owns placeholder text and input behavior.
- Optional options popover for option-field values.

Rules:

- Placeholder remains `Type here or '/' for commands`.
- Empty marker uses muted leading color and must not change row text start.
- Creation, paste parsing, trigger handling, undo/redo, IME composition, and
  option selection remain owned by `TrailingInput`.

## NodeDescription

Current sources:

- `src/renderer/ui/outliner/NodeDescription.tsx`
- `src/renderer/ui/outliner/NodeDescriptionSurface.tsx`

Purpose:

- Muted metadata attached to an outliner row or panel title.

Structure:

- Read state renders a compact text button.
- Edit state renders a one-row textarea in the same rhythm.
- `NodeDescription` owns draft state, focus, IME-safe keyboard handling, and
  persistence.
- `NodeDescriptionSurface` owns only the read/edit visual elements and class
  names.

Rules:

- Description never becomes a card.
- Read and edit states must keep the same row flow and muted typography.
- Enter commits; Escape cancels without committing; IME composition must not be
  interrupted.

## OutlinerViewChrome

Current sources:

- `src/renderer/ui/outliner/OutlinerView.tsx`
- `src/renderer/ui/outliner/OutlinerViewChrome.tsx`

Purpose:

- Lightweight non-row chrome inside outliner views, such as grouped headings
  and hidden-field reveal actions.

Rules:

- Group headings stay compact, muted, and subordinate to rows.
- Hidden-field reveal uses a small inline action, not a settings card.
- Filtering, hidden-field expansion state, and row building stay in
  `OutlinerView` and row-model code.

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
- `src/renderer/ui/agent/AgentMessageFrame.tsx`
- `src/renderer/ui/agent/AgentBranchNavigator.tsx`

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
- `src/renderer/ui/agent/AgentProcessTimeline.tsx`
- `src/renderer/ui/agent/AgentThinkingBlock.tsx`
- `src/renderer/ui/agent/AgentToolCallBlock.tsx`
- `src/renderer/ui/agent/AgentToolCallDisclosure.tsx`

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
- `src/renderer/ui/agent/AgentComposerControls.tsx`
- `src/renderer/ui/agent/AgentComposerModelMenu.tsx`

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
- `AgentComposerControls` owns presentational controls for queued follow-up
  actions, attachment chips, attachment trigger, model button, and primary
  action slot.
- `AgentComposerModelMenu` owns the model/reasoning menu shell and item
  structure.
- `AgentComposer` owns textarea draft, send/queue/stop behavior, file reading,
  attachment state, menu open state, provider updates, and IME-safe keyboard
  handling.

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
- Thinking switch exposes `role="switch"` with a label.
- Thinking-level choices expose menu radio state.

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
