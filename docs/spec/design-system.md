# Design System

This document defines the visual and layout rules for Lin Outliner. Tana is a
reference for density, spacing, and surface hierarchy, but not for feature
scope. Lin keeps its own navigation model, command model, outliner behavior,
and agent model.

## Design Intent

Lin should feel like a dense desktop knowledge workspace:

- Quiet app chrome.
- Persistent cross-tab sidebar.
- Persistent cross-tab agent dock.
- Central workspace canvas with one or more tiled outliner panels.
- White panels on a pale gray app background.
- Outliner content remains the primary visual object.

The design should avoid marketing-page composition, decorative cards, and
large empty hero-like areas. Every surface should look useful and editable.

## Reference Boundary

Use Tana as a reference for:

- Overall density.
- Top chrome height and tab treatment.
- Sidebar weight and icon-driven navigation.
- White outliner panels on gray canvas.
- Small panel close controls.
- Right dock as a persistent side surface.
- Muted text and low-contrast controls.

Do not copy Tana as product behavior:

- Do not add Tana-specific entries such as `Inbox`, `AI chats`, pinned nodes, or
  workspace management unless Lin explicitly owns those features.
- Do not change Lin's outliner row model to match Tana's content model.
- Do not make the agent dock a Tana shortcuts/help panel.
- Do not use fake panels for screenshots. A panel that looks like an outliner
  must be backed by the real outliner UI.

## App Structure

```txt
App shell
  Top chrome
    Window/nav controls
    Workspace tab strip
    Global controls
  Body
    Sidebar dock
    Workspace canvas
      Outline panel 1
      Outline panel 2
      ...
    Agent dock
  Overlay layer
```

Ownership rules:

- Sidebar is cross-tab.
- Agent dock is cross-tab.
- A tab owns only the workspace canvas state.
- A canvas owns one or more outline panels.
- Panels are tiled siblings. They do not overlap.

## Layout Tokens

Use these as the default desktop tokens:

```css
--app-bg: #eeeeef;
--panel-bg: #ffffff;
--space-1: 2px;
--space-2: 4px;
--space-3: 6px;
--space-4: 8px;
--space-5: 10px;
--space-6: 12px;
--space-7: 14px;
--space-8: 16px;
--layout-gap: var(--space-4);
--chrome-control-height: 26px;
--chrome-height: calc(var(--layout-gap) + var(--chrome-control-height));
--traffic-light-x: 13px;
--traffic-light-y: 14px;
--sidebar-width: 196px;
--sidebar-collapsed-width: 0px;
--agent-width: 344px;
--agent-collapsed-width: 0px;
--shell-padding-x: var(--layout-gap);
--shell-padding-top: var(--layout-gap);
--shell-padding-bottom: var(--layout-gap);
--shell-gap: var(--layout-gap);
--panel-gap: var(--layout-gap);
--panel-radius: 8px;
--panel-content-x: 16px;
--panel-content-top: 10px;
--panel-content-bottom: 30px;
--panel-content-max: 720px;
--resize-pill-width: 4px;
--resize-pill-height: 32px;
```

Density rules:

- Use the `--space-*` scale before introducing a new pixel value.
- Shell outer insets, dock gaps, and panel-to-panel gaps use the same
  `--layout-gap` token by default.
- `--layout-gap` should stay in the `4px` to `8px` range unless a dock is
  intentionally separated. Desktop defaults to `8px`.
- Panel-to-panel spacing is structural, not decorative. It should be just wide
  enough to expose the resize target.
- For resize boundaries, the default geometry is `8px` gap with a `4px` visible
  pill centered inside it. This leaves `2px` of gap on each side of the pill.
- Panel resize affordances live in a real gap slot between panels. They should
  not be absolutely positioned from inside either neighboring panel.
- Avoid large empty padding at panel edges. Empty space should come from the
  document content, not from arbitrary wrappers.

Responsive behavior:

- When two panels fit, panels share available canvas width evenly.
- When three or more panels are open, panels share the available canvas width by
  panel ratio. The canvas should not introduce horizontal scrolling as the
  default behavior.
- The sidebar and agent dock may collapse independently.
- Collapsing a dock changes the shell grid, not the active tab state.

## Top Chrome

Top chrome is shell-level, not tab-owned.

Regions:

- Left: native window space, sidebar toggle, back, forward.
- Center: workspace tabs and new-tab affordance.
- Right: agent toggle and account/global affordance.

Visual rules:

- Control row height: `26px`.
- Top inset: `--layout-gap`, `8px` on desktop.
- Chrome height: `--layout-gap + --chrome-control-height`, `34px` on desktop.
- Background: same as app background.
- Controls are icon-first.
- Disabled history controls remain visible but muted.
- Sidebar toggle must collapse/expand the sidebar.
- Agent icon must collapse/expand the agent dock.
- Workspace tabs and top chrome controls share the same vertical center line.
- The `26px` tab/control row sits `8px` from the top edge.
- The visible gap from chrome bottom to panel top is `--layout-gap`.
- On macOS, native traffic-light controls are positioned through Tauri
  `trafficLightPosition`. Their visual height is smaller than the `26px`
  toolbar row, so the default `y` inset is `14px` to optically center the
  circles against the row rather than copying the `8px` row top inset.
- Empty chrome space uses `data-tauri-drag-region="deep"` so native window
  dragging and macOS double-click maximize behavior come from Tauri's drag
  region script.
- Interactive controls and tabs must remain native-clickable and must not start
  a window drag.

Tab rules:

- Tabs represent workspace canvas layouts, not agent conversations.
- Active tab uses a slightly darker gray fill than inactive tabs.
- Tab labels are compact: `13px`, semibold.
- Tabs should not visually dominate panels.
- Tabs can eventually support close/reorder, but the initial UI must not show a
  close affordance that does nothing.

## Sidebar Dock

The sidebar is persistent across tabs.

Lin's current primary entries:

- Today
- Search
- Supertags
- Library
- Recents

Visual rules:

- Width: `196px` by default and resizable by the user.
- Background: app gray, not a white card.
- Primary nav starts below the chrome with compact, non-decorative spacing.
- Primary entries use icons, not hash prefixes.
- Item height: `24px`.
- Item text: `14px`.
- Icon size: `16px`.
- Active item uses a subtle gray row highlight.
- Disabled entries use lower opacity but preserve layout.

Workspace section:

- Section title uses muted text.
- Workspace rows use the same density as primary nav.
- Workspace disclosure chevrons are muted and small.

Collapsed sidebar:

- Width becomes `0px`.
- Content is hidden.
- The top chrome sidebar icon remains the only reopen control.
- Collapsing does not reset selected tab, panels, or outliner selection.

## Workspace Canvas

The canvas is the active tab's content area.

Visual rules:

- Canvas background is app gray.
- Panels sit directly on the canvas with the same `--layout-gap` used by the
  shell outer inset.
- Panels are white surfaces with `8px` radius.
- Panels are not nested inside another visible card.
- Panels use the real outliner implementation.

Panel layout:

- One panel fills the canvas.
- Two panels share canvas width evenly.
- Three or more panels share width according to their persisted panel ratios.
- Panel order is left to right.
- Panel close button appears only when more than one panel is open.
- Resize handle slots sit between panels and use the same `--panel-gap` width.
- The visible resize pill is `2px` wide and `32px` tall by default.
- With the default `6px` gap, a centered `2px` pill leaves `2px` clearance from
  both neighboring panel edges.

Panel behavior:

- Every visible panel must be a real outliner panel.
- Every panel can navigate its own root.
- The active panel is the target for keyboard commands when focus is in the
  workspace canvas.
- Closing the active panel moves active focus to the nearest remaining panel.
- Closing the last panel is not allowed.

## Outliner Panel

All panels must use the same outliner typography and row system. Do not create
custom large-font preview panels.

Typography:

- Panel title: existing `NodePanel` title style.
- Row text: existing outliner row style.
- Placeholder text: existing outliner placeholder style.
- Metadata and descriptions: muted existing styles.

Spacing:

- Panel internal padding is `10px` top, `16px` left/right, and `30px` bottom on
  desktop.
- Breadcrumb-to-title spacing is `28px` by default.
- Panel header and row indentation are owned by `NodePanel`.
- Wrapper CSS may control panel surface size and scroll behavior, but should not
  override row font size or row rhythm.

Close control:

- Top-right inside panel.
- Small, muted, visible when multiple panels are open.
- Hover state may show subtle gray background.
- It must be clickable and actually close the panel.

## Agent Dock

The agent dock is persistent across tabs and independent from the workspace
canvas.

Initial scope:

- It may be a placeholder surface.
- It should reserve the final layout area.
- It should not pretend to be a functioning chat if chat is not implemented.

Visual rules:

- Width: `344px` by default and resizable by the user.
- Background: app gray.
- Header aligns with panel top region.
- Header title may be `# conversion` until the real agent model exists.
- Bottom input placeholder may be shown as disabled/inert.
- Center placeholder text should be clearly temporary.

Collapsed agent:

- Width becomes `0px`.
- Content is hidden.
- The top chrome agent icon remains the reopen control.
- Collapsing does not affect tabs, panels, or sidebar state.

## Typography Scale

Use a compact desktop scale:

```css
--font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-sidebar: 14px;
--font-tab: 13px;
--font-panel-title: existing NodePanel title token;
--font-row: existing outliner row token;
--font-muted: 13px;
--font-agent-header: 14px;
```

Rules:

- Do not scale font size with viewport width.
- Do not use oversized typography inside panels unless it is the real panel
  title style.
- The same node rendered in two panels must have the same row typography.

## Color Tokens

Recommended base palette:

```css
--text: #1a1a1a;
--muted: #77777c;
--muted-2: #999999;
--app-bg: #eeeeef;
--panel-bg: #ffffff;
--tab-bg: #d9d9dd;
--tab-active-bg: #d1d1d6;
--row-hover: rgba(0, 0, 0, 0.045);
--row-selected: rgba(160, 210, 249, 0.62);
--border-subtle: rgba(0, 0, 0, 0.06);
--agent-accent: #ff4f54;
```

Selection:

- Outliner selection should remain the existing Lin selection behavior unless
  deliberately changed.
- Active nav rows use neutral gray, not strong brand color.
- Agent placeholder/accent may use red only while it is clearly temporary.

## Interaction States

For every clickable shell control define:

- Default.
- Hover.
- Active/pressed.
- Disabled.
- Focus-visible.

Minimum required states:

- Sidebar item active.
- Sidebar item hover.
- Top icon hover.
- Top icon pressed for collapsed/expanded state.
- Panel close hover.
- Active panel indication.
- Disabled agent input placeholder.

Avoid invisible behavior. If a control exists and is enabled, it must perform a
real action.

## Implementation Rules

1. Prefer tokens over one-off pixel values.
2. Do not style fake preview panels as if they were real outliners.
3. Do not add reference-app features as a side effect of copying visual layout.
4. Keep shell state separate from document state.
5. Keep sidebar and agent visibility outside tab state.
6. Keep panel state inside the active workspace tab model.
7. Use real `NodePanel` for every outliner panel.
8. Do not override outliner row typography from the shell.
9. Use icons for primary sidebar entries.
10. Validate layout with screenshots at desktop widths before merging.

## Current Gaps To Resolve

The current implementation should converge toward this spec by:

- Moving repeated CSS values into design tokens.
- Adding a real tab state model.
- Moving panel state into tab state instead of temporary component state.
- Defining active panel styling.
- Defining collapsed dock keyboard shortcuts.
- Replacing agent placeholder with the real chat surface when agent work starts.
