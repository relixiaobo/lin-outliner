# Lin Design System

This file is the single source of truth for Lin Outliner's product UI system.
It is optimized for agents and implementers reading source context. Product
code remains the authority for real behavior; reference snippets live inline
here when they help avoid ambiguity.

## Product Intent

Lin should feel like a dense desktop knowledge workspace:

- Quiet neutral chrome.
- Persistent cross-tab sidebar.
- Persistent cross-tab agent dock.
- Central workspace canvas with one or more tiled outliner panels.
- White outliner panels on deck gray.
- Outliner content remains the primary visual object.

Avoid marketing-page composition, decorative cards, ornamental color, hidden
scrollbars, and fake product panels. A panel that looks editable in product UI
must be backed by real product state.

## Reference Boundary

Tana and nodex are references for density, spacing, surface hierarchy, and
specific outliner interactions. Lin keeps its own navigation model, command
model, document model, outliner behavior, and agent model.

Use references for:

- Overall density and text rhythm.
- White workspace surfaces on gray deck.
- Muted controls and low elevation.
- Node/reference/field interaction parity where Lin owns the same behavior.

Do not copy reference-product scope, navigation entries, fake panels, warm
paper palettes, or feature concepts Lin does not own.

## Source Map

| Area | Product Sources | Contract |
| --- | --- | --- |
| Shell and tabs | `App.tsx`, `TopBar.tsx`, `WorkspaceTab.tsx`, `useWorkspaceTabs.ts` | Top chrome, tabs, shell layout, and collapse controls. |
| Workspace canvas | `WorkspaceCanvas.tsx`, `WorkspacePanelSurface.tsx`, `ResizeHandle.tsx`, `useResizableLayout.ts` | Real tiled panels, resize slots, ratio fill, local overflow. |
| Outliner panel | `NodePanel.tsx`, `OutlinerView.tsx`, `OutlinerItem.tsx`, `styles/outliner.css` | Title, breadcrumb, tags, rows, fields, references, triggers. |
| Outliner rows | `OutlinerRowShell.tsx`, `RowLeading.tsx`, `RowMarker.tsx`, `RowHost.tsx`, `useOutlinerRowInteraction.ts` | Row geometry, selection, leading markers, chevron behavior. |
| Fields and definitions | `DefinitionConfigPanel.tsx`, `DefinitionConfigControls.tsx`, `DefinitionConfigRowShell.tsx`, `FieldEntryGrid.tsx`, `OutlinerFieldRow.tsx`, `FieldValueOutliner.tsx` | Field rows, field values, and definition configuration. |
| Tags | `AppliedTag.tsx`, `TagBar.tsx`, `tagColors.ts`, `TagSelector.tsx`, `BatchTagSelector.tsx` | Applied tag rendering, tag menus, and batch tag surfaces. |
| Editor and commands | `RichTextEditor.tsx`, `FloatingEditorToolbar.tsx`, `CommandPalette.tsx`, `editorRegistry.ts` | Rich text editing, command palette, toolbar, and trigger overlays. |
| Menus and overlays | `MenuSurface.tsx`, `MenuItem.tsx`, `AnchoredOverlay.tsx`, `Dialog.tsx`, `PopoverList.tsx`, `NodeContextMenu.tsx`, `TriggerPopover.tsx`, `ReferenceSelector.tsx`, `SlashCommandMenu.tsx` | Overlay semantics, positioning, elevation, dismissal, and item rows. |
| Agent dock | `AgentDock.tsx`, `AgentChatPanel.tsx`, `AgentDebugPanel.tsx` | Persistent dock, chat scroll, debug surface, settings entry. |
| Agent messages | `AgentMessageRow.tsx`, `AgentMessageFrame.tsx`, `AgentBranchNavigator.tsx`, `AgentProcessBlock.tsx`, `AgentProcessTimeline.tsx`, `AgentThinkingBlock.tsx`, `AgentToolCallBlock.tsx`, `AgentToolCallDisclosure.tsx` | Messages, process disclosure, thinking, tool calls, status slots. |
| Agent composer | `AgentComposer.tsx`, `AgentComposerControls.tsx`, `AgentComposerModelMenu.tsx` | Textarea, attachments, model menu, reasoning switch, send/stop slot. |
| Agent settings | `AgentSettingsDialog.tsx` | Provider configuration, key actions, model controls, shared form primitives. |
| Primitives | `ButtonControl.tsx`, `CheckboxControl.tsx`, `CheckboxMark.tsx`, `IconButton.tsx`, `SwitchControl.tsx`, `SwitchMark.tsx`, `SelectControl.tsx`, `TextInputControl.tsx`, `NumberInputControl.tsx` | Thin semantic or visual primitives. Behavior remains caller-owned unless the primitive explicitly owns native control semantics. |

## Foundations

Use these default desktop tokens before adding component-specific values:

```css
:root {
  --font-family-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-family-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  --font-scale: 100%;
  --font-ui-2xs: 0.625rem; /* 10px */
  --line-ui-2xs-tight: 0.8125rem; /* 13px */
  --line-ui-2xs: 0.875rem; /* 14px */
  --font-ui-xs: 0.6875rem; /* 11px */
  --line-ui-xs: 0.9375rem; /* 15px */
  --line-ui-xs-relaxed: 1rem; /* 16px */
  --font-meta: 0.75rem; /* 12px */
  --line-meta-tight: 1.0625rem; /* 17px */
  --line-meta: 1.125rem; /* 18px */
  --font-ui-sm: 0.8125rem; /* 13px */
  --line-ui-sm-tight: 1.1875rem; /* 19px */
  --line-ui-sm: 1.25rem; /* 20px */
  --font-ui-md: 0.875rem; /* 14px */
  --line-ui-md: 1.375rem; /* 22px */
  --font-content: 1rem; /* 16px */
  --line-content: 1.625rem; /* 26px */
  --content-control-height: var(--line-content);
  --font-description: var(--font-ui-sm);
  --line-description: 1.125rem; /* 18px */
  --font-heading-sm: 0.875rem; /* 14px */
  --line-heading-sm: 1.375rem; /* 22px */
  --font-heading-md: 1rem; /* 16px */
  --line-heading-md: 1.5rem; /* 24px */
  --font-heading-lg: 1.125rem; /* 18px */
  --line-heading-lg: 1.625rem; /* 26px */
  --font-heading-xl: 1.25rem; /* 20px */
  --line-heading-xl: 1.75rem; /* 28px */
  --font-heading-2xl: 1.5rem; /* 24px */
  --line-heading-2xl: 2rem; /* 32px */
  --font-panel-title: 1.625rem; /* 26px */
  --line-panel-title: 2.25rem; /* 36px */
  font-size: var(--font-scale);

  --deck-bg: #f4f4f5; /* Zinc-100 */
  --app-bg: var(--deck-bg);
  --panel-bg: #ffffff;
  --surface-soft: #fafafa; /* Zinc-50 */
  --text-main: #09090b; /* Zinc-950 */
  --text-sub: #52525b; /* Zinc-600 */
  --text-muted: #a1a1aa; /* Zinc-400 */
  --text-strong: #1f1f22;
  --text-body: #29292d;
  --text-soft: #66666b;
  --text-faint: #8b8b91;
  --text-disabled: #c4c4c8;
  --row-hover: #f4f4f5; /* Zinc-100 */
  --row-selected: #f4f4f5; /* Zinc-100 */
  --border-subtle: #e4e4e7; /* Zinc-200 */
  --border-muted: #d4d4d8; /* Zinc-300 */
  --border-emphasis: rgba(9, 9, 11, 0.18);
  --border-strong: #9d9da3;
  --control-hover: rgba(0, 0, 0, 0.055);
  --control-active: rgba(0, 0, 0, 0.08);
  --focus-border: rgba(9, 9, 11, 0.52);
  --focus-ring: rgba(9, 9, 11, 0.24);
  --focus-ring-shadow: 0 0 0 2px var(--focus-ring);
  --accent-brand: #f43f5e;
  --accent-danger: #e11d48;
  --semantic-success: #4cb27b;
  --semantic-success-strong: #3f865d;
  --semantic-danger-muted: #9a3f34;
  --semantic-warning: #e9b43d;
  --semantic-info: #3288d0;
  --surface-user-bubble: #dedfe2;
  --surface-inverse: #2e2e32;
  --surface-inverse-strong: #1f1f23;
  --surface-disabled: #d6d6da;
  --overlay-bg: var(--panel-bg);
  --overlay-active-bg: var(--row-selected);
  --overlay-shadow-level-1: 0 8px 20px -12px rgba(0, 0, 0, 0.22), 0 2px 8px -4px rgba(0, 0, 0, 0.10);
  --overlay-shadow-level-2: 0 18px 48px -20px rgba(0, 0, 0, 0.24), 0 6px 18px -10px rgba(0, 0, 0, 0.14);
  --outline-faint: inset 0 0 0 1px rgba(0, 0, 0, 0.035);
  --outline-subtle: inset 0 0 0 1px rgba(0, 0, 0, 0.055);
  --outline-muted: inset 0 0 0 1px rgba(9, 9, 11, 0.12);
  --outline-emphasis: inset 0 0 0 1px var(--border-emphasis);
  --outline-focus: inset 0 0 0 1px var(--focus-border);
  --outline-primary: inset 0 0 0 1px color-mix(in srgb, var(--accent-brand) 26%, transparent);
  --outline-primary-strong: inset 0 0 0 1px color-mix(in srgb, var(--accent-brand) 58%, var(--border-subtle));
  --underline-focus-shadow: inset 0 -1px 0 rgba(26, 26, 26, 0.18);
  --tag-focus-shadow: 0 0 0 2px color-mix(in srgb, var(--tag-text, currentColor) 22%, transparent);
  --shadow-thumb: 0 1px 2px rgba(0, 0, 0, 0.14);
  --shadow-thumb-strong: 0 1px 2px rgba(0, 0, 0, 0.18);

  --space-hairline: 1px;
  --space-1: 2px;
  --space-2: 4px;
  --space-3: 6px;
  --space-4: 8px;
  --space-5: 10px;
  --space-6: 12px;
  --space-7: 14px;
  --space-8: 16px;
  --space-micro: var(--space-2);
  --space-sm: var(--space-4);
  --space-md: var(--space-8);
  --space-lg: 24px;
  --space-xl: 32px;
  --layout-gap: var(--space-sm);

  --control-size-xs: 20px;
  --control-size-sm: 22px;
  --control-size-md: 24px;
  --control-size-lg: 26px;
  --control-size-xl: 28px;
  --control-size-2xl: 30px;
  --control-size-3xl: 32px;
  --icon-size-xs: 12px;
  --icon-size-sm: 14px;
  --icon-size-md: 16px;
  --icon-size-lg: 18px;
  --checkbox-mark-size: var(--icon-size-md);
  --checkbox-mark-radius: var(--radius-xs);
  --switch-mark-width: var(--control-size-2xl);
  --switch-mark-height: var(--icon-size-lg);
  --switch-mark-thumb-size: var(--icon-size-sm);
  --switch-mark-inset: var(--space-1);

  --radius-2xs: 2px;
  --radius-xs: 3px;
  --radius-control-xs: 5px;
  --radius-sm: 6px;
  --radius-control-md: 7px;
  --radius-md: 8px;
  --radius-control-lg: 9px;
  --radius-overlay-sm: 10px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-pill: 999px;
  --workspace-surface-radius: var(--radius-xl);
  --panel-radius: var(--workspace-surface-radius);
  --agent-composer-radius: var(--workspace-surface-radius);
  --agent-composer-corner-inset: var(--space-3);
  --agent-composer-corner-radius: calc(var(--agent-composer-radius) - var(--agent-composer-corner-inset));

  --motion-fast: 120ms ease;
  --motion-layout: 160ms ease;
  --z-base: 0;
  --z-raised: 10;
  --z-resize: 30;
  --z-popover: 100;
  --z-agent-menu: 120;
  --z-editor-toolbar: 140;
  --z-modal: 200;
  --z-toast: 300;

  --row-edge: 6px;
  --row-leading-width: 42px;
  --row-leading-height: var(--line-content);
  --row-chevron-width: 15px;
  --row-chevron-gap: var(--space-2);
  --row-bullet-width: 15px;
  --row-content-gap: var(--space-4);
  --row-selection-start: 21px;
}
```

### Token Rules

- Product CSS keeps raw hex colors inside token declarations only.
- Component CSS may use `rgba()` or `color-mix()` for alpha states, but the base
  color should come from a token whenever the value is semantic.
- Primary text parity matters: outliner row text, field values, agent assistant
  prose, user bubbles, and the agent composer use
  `--font-content / --line-content`.
- Do not scale font size with viewport width.
- `--workspace-surface-radius` is the canonical outer radius for workspace
  structural surfaces. `--panel-radius` and `--agent-composer-radius` both map
  to it.
- Nested corner controls derive their radius from the parent:
  `parent radius - inset`.
- Overlay shadow tokens are pure drop shadows. Floating menus, popovers,
  tooltips, and dialogs do not use a real outer border.
- Focus uses neutral focus tokens, not brand color, unless the state is an
  error or destructive action.
- Product CSS references elevation, outline, size, spacing, and motion tokens
  instead of writing one-off system values.

### Color

- Deck and canvas background: `--deck-bg`.
- `--app-bg` is a compatibility alias for `--deck-bg`.
- Panel background: `--panel-bg`.
- Soft utility surfaces: `--surface-soft`.
- Active navigation rows use neutral gray, not brand color.
- Rose is sparse brand/status color, not the everyday active state.
- Warning uses Mustard, success uses Sage, info uses Sapphire.

User-defined tag palette:

| Name | Text | Background |
| --- | --- | --- |
| Red | `#e11d48` | `#fff1f2` |
| Orange | `#ea580c` | `#fff7ed` |
| Yellow | `#ca8a04` | `#fefce8` |
| Green | `#059669` | `#ecfdf5` |
| Blue | `#2563eb` | `#eff6ff` |
| Purple | `#9333ea` | `#faf5ff` |
| Pink | `#db2777` | `#fdf2f8` |
| Gray | `#475569` | `#f8fafc` |

## Components

Components are thin contracts. They should define structure, state, semantics,
and non-goals; product behavior stays with the owning surface.

| Component | Sources | Contract |
| --- | --- | --- |
| `CheckboxMark` | `CheckboxMark.tsx` | Decorative `16px` checkbox mark with `3px` radius. Unchecked is outlined; checked is success-filled. Does not own row behavior or persistence. |
| `CheckboxControl` | `CheckboxControl.tsx`, `AgentSettingsDialog.tsx` | Labeled native checkbox wrapper for settings/forms. Keeps native checkbox semantics and `CheckboxMark` visual together. |
| `SwitchControl` / `SwitchMark` | `SwitchControl.tsx`, `SwitchMark.tsx`, `DefinitionConfigControls.tsx`, `AgentComposerModelMenu.tsx`, `TypedFieldValueControl.tsx` | Semantic switch wrapper plus shared `30px x 18px` track and `14px` thumb. Does not own labels or persistence. |
| `IconButton` | `IconButton.tsx` | Icon-first button with explicit accessible label and tokenized icon size. Visual variant stays caller-owned. |
| `MenuSurface` | `MenuSurface.tsx`, `PopoverList.tsx`, `NodeContextMenu.tsx`, `AgentComposerModelMenu.tsx` | Shared menu/popover wrapper. Caller owns role, positioning, keyboard navigation, filtering, and execution. Edge separation comes from pure overlay shadow, not border. |
| `MenuItem` | `MenuItem.tsx`, command/menu rows | Stable row contract for icon, label, metadata, active, disabled, selected, and danger states. |
| `AnchoredOverlay` | `AnchoredOverlay.tsx` | Viewport-aware anchored positioning and outside dismissal wiring. Does not own menu contents or commands. |
| `PopoverListbox` | `PopoverList.tsx`, trigger/option/tag/reference/slash popovers | Listbox shell and option item structure. Active index and filtering remain caller-owned. |
| `Dialog` | `Dialog.tsx`, `AgentSettingsDialog.tsx`, `CommandPalette.tsx` | Modal shell with label linkage, Escape handling, focus trap, initial focus, and focus restoration. |
| `ButtonControl` | `ButtonControl.tsx` | Native button wrapper with default `type="button"` and ref forwarding. Visual variants stay class-owned. |
| `SelectControl` | `SelectControl.tsx` | Native select wrapper. Options and value coercion stay caller-owned. |
| `TextInputControl` | `TextInputControl.tsx` | Native input wrapper. Draft, validation, and commit behavior stay caller-owned. |
| `NumberInputControl` | `NumberInputControl.tsx` | Native number input wrapper. Parsing and empty-value semantics stay caller-owned. |
| `PanelSurface` | `WorkspacePanelSurface.tsx` | White workspace panel using `--panel-radius`. Active panel may use subtle inset outline. |
| `ResizeHandle` | `ResizeHandle.tsx` | Shared resize button structure. Pointer behavior stays in `useResizableLayout`. |
| `AppliedTag` | `AppliedTag.tsx` | Fixed measured tag pill using tag palette background/text colors. Hover/focus must not shift row width. |

## Surfaces

### Shell

- Top chrome, sidebar dock, workspace canvas, and agent dock use `--deck-bg`.
- Shell gaps and insets use `--layout-gap`.
- Sidebar default width is `196px`; range is `152px` to `280px`.
- Agent dock default width is `344px`; range is `280px` to `520px`.
- Top chrome controls are icon-first and compact.
- macOS traffic-light controls share the top chrome control centerline and use
  the shared chrome geometry constants; do not tune BrowserWindow and CSS
  positions independently.
- Workspace tabs represent canvas layouts. Each tab may show multiple panel
  segments; node panels use the node icon when present and otherwise a bullet,
  while agent debug panels use the debug icon and the agent session title. Tabs
  use a fixed width, and bullets, emoji icons, and svg icons occupy the same
  `16px` icon slot so titles do not crowd or shift. Tab text uses the compact
  UI scale (`13px / 20px`), and close affordances use the shared `20px` control
  size instead of local magic numbers.

### Workspace And Panels

- Canvas background is deck gray.
- Panels are real outliner panels, not cards inside cards.
- Panels are white surfaces with `--panel-radius`.
- Panel content owns local overflow; the canvas should not become a normal
  horizontal scrolling surface.
- Active panel indication is subtle and neutral.
- Closing the active panel moves active focus to the nearest remaining panel;
  closing the last panel is not allowed.
- Top chrome sidebar toggle uses distinct expand/collapse icons. It must not
  use a selected background to indicate that the sidebar is currently open.
- Top chrome Back/Forward disabled states use `--text-disabled`.
- Workspace tabs stay quiet at rest: no heavy active pill treatment; active
  panel segments use stronger text, and hover/focus supplies the interaction
  surface.
  Every workspace tab still keeps a very light background block so canvas-level
  tab boundaries remain visible without competing with panel content.

### Outliner

- Panel title editor: `26px / 36px`, weight `600`.
- Breadcrumb: `13px / 20px`, muted secondary color.
- Breadcrumb back control: `24px` hit target with a `14px` icon. Disabled
  navigation controls use `--text-disabled`.
- Breadcrumb leading alignment reuses the outliner row grid: the back control
  is centered on the chevron column, the root icon is centered on the bullet
  column, and breadcrumb text starts on the row content column.
- Collapsed breadcrumb levels use an `18px` circular More icon button. It must
  expand or reveal the hidden levels; it is not a passive glyph.
- Panel breadcrumb is sticky at the top of the panel scroll container.
- Breadcrumb belongs to the panel edge, not the centered reading column. On
  wide panels it stays near the panel's left inset while the content column
  remains centered; on narrow panels both naturally align.
- Current page title docks into the sticky breadcrumb after the large title
  scrolls under it.
- Breadcrumb back and top chrome Back/Forward use outliner page history only.
  They do not undo or redo document operations.
- Row editor: `16px / 26px`.
- Description: `13px / 18px`.
- Description editing follows the row text model: `Ctrl+I` toggles between row
  text and description, and the editing surface stays borderless with no
  underline or boxed focus treatment.
- Row minimum height: `26px`.
- Row radius: `5px`.
- Row padding: `1px 6px`.
- Leading cluster width: `42px`.
- Leading cluster columns: `15px 4px 15px 8px`.
- Selection fill starts at `21px`.
- Parent chevron is a hover/focus affordance for the current row only.
- Empty trailing hints follow the nodex idle-hint rule: only the focused
  trailing editor reveals `Type here or '/' for commands`, after a short delay.
- Blank content-row placeholders are suppressed while focus or typed input is
  pending so newly created nodes do not flash placeholder text.
- Normal rows, reference rows, tag definition rows, field definition rows, field
  entry rows, completed rows, selected rows, and expanded/collapsed parent rows
  keep the same text-start grid.
- `>` in an empty row converts that row into a field row in place. Trailing
  field creation appends a field row at the trailing position.
- Field name `Enter` creates a sibling node. It does not jump into the field
  value child.
- Field values may contain nested field rows, matching normal outliner child
  behavior.

### References

- Reference nodes and inline references follow nodex interaction semantics.
- Mixed selections containing reference links and normal nodes use the normal
  batch block operation model. Deleting a reference node deletes the reference
  link itself.
- Reference selection visuals follow the shared row selection axis and neutral
  color system.
- Inline reference atoms stay in text flow and must not break cursor,
  split/merge, paste, or IME behavior.
- Inline references render as text links: normal text weight, no chip surface,
  first-supertag text color when available, otherwise semantic info color.
  Reference nodes remain block rows with the neutral dashed reference marker.

### Fields And Definition Configuration

- Field entries are ordinary outliner rows in document order.
- Field row layout uses `FieldEntryGrid` for name/value/description slots.
- Field row separators reveal on hover or focus instead of being permanently
  heavy.
- Field type glyphs use normal row icon sizing; checkbox field type glyphs do
  not use `CheckboxMark`.
- Checkbox field values use `CheckboxMark`.
- Boolean field values use `SwitchMark`.
- Date field values use an anchored popover, level 1 overlay shadow, no real
  outer border, shared calendar day states, and `SwitchMark` for range/time
  toggles. Summary rows stay compact and neutral; they should not read as
  stacked cards. Calendar grids use fixed square day cells with matching row
  and column gaps; do not stretch days through `1fr` columns.
- Definition configuration rows are dense configuration controls, not editable
  outliner rows. They may visually rhyme with field rows but must not inherit
  row selection behavior.

### Menus, Popovers, And Dialogs

- Menus and popovers use level 1 overlay shadow.
- Dialogs and command palette use level 2 overlay shadow.
- Overlay shadows are pure drop shadows. Do not add a real outer border to
  floating surfaces.
- Search/input headers stay visually attached to their surface.
- Escape closes overlays. Non-modal popovers close on outside pointer down.
- Focus-visible remains visible inside overlays.
- Modal dialogs trap focus and restore focus on close.
- Popovers should render through a shell-level overlay host when clipping or
  stacking conflicts are possible.

### Agent

- Agent dock is persistent across workspace tabs and subordinate to the
  outliner workspace.
- Header titles use the plain conversation title without a prefix. The title
  trigger has no hover background; it darkens text and reveals its chevron only
  on hover, focus, or open state.
- Agent UI uses Lin foundations: neutral text, deck gray background, white
  surfaces, sparse semantic color, low elevation, and compact controls.
- Assistant prose, user bubbles, and composer input use
  `--font-content / --line-content`.
- Process summaries, thinking rows, and tool summaries use
  `--font-meta / --line-meta`.
- Process and tool-call disclosures use one measured disclosure/status slot so
  labels do not jump across hover, focus, loading, or expansion.
- Composer bottom aligns to the workspace panel bottom edge.
- Composer outer radius maps to the shared workspace surface radius.
- Composer toolbar remains visually unified with the textarea; no internal
  divider.
- Model picker and reasoning picker are MenuSurface overlays. Thinking switch
  uses `SwitchMark`.
- Settings uses `Dialog`, form controls, `CheckboxControl`, and `CheckboxMark`.
- Runtime approval/tool preview types exist, but no renderer approval overlay is
  shipped. Do not render fake approval controls before product behavior exists.

## Patterns

### App Shell

Desktop layout is chrome + persistent docks + canvas. The first viewport should
be the working surface, not a marketing or tutorial layout.

### Multi-Panel Canvas

Panels tile by ratio and fill available width. Resizing preserves adjacent
panel total size. Single-panel mode can center bounded content but must fill
when narrow.

### Tag Hover

Tag hover/focus swaps or reveals affordances within a measured pill. It must not
move row text, change row height, or reflow neighboring tags.

### Native Desktop Feel

Desktop controls should feel dense, quiet, and predictable. Use icons where a
common symbol exists; use text buttons only for clear commands. Avoid decorative
nested cards.

## Implementation Rules

1. Product behavior remains authoritative.
2. Update this file before or with UI changes that alter system contracts.
3. Use tokens before adding one-off values.
4. Add abstractions only when they remove real duplication or clarify ownership.
5. Keep component primitives thin. They should not absorb product behavior by
   accident.
6. Do not style fake preview panels as if they were shipped UI.
7. Keep reference snippets tokenized and source-backed. They may simplify
   examples but should not invent a second visual language.
8. When changing frontend behavior or visuals, run focused e2e coverage and
   update screenshots or specimens when useful.

## Validation

Expected checks for design-system changes:

- `bun run typecheck`
- Focused Playwright tests for touched surfaces.
- `tests/e2e/typography-tokens.spec.ts` for token discipline.
- `git diff --check`

Use screenshot review for shell, panel, outliner, overlay, and agent changes
when visual judgment is central to the request.
