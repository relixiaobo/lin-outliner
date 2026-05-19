# Patterns

This module defines product-level composition patterns. Foundations define
tokens. Components define small reusable UI pieces. Surfaces define persistent
product areas. Patterns define how those parts work together.

## Product Intent

Lin should feel like a dense desktop knowledge workspace:

- Quiet app chrome.
- Persistent cross-tab sidebar.
- Persistent cross-tab agent dock.
- Central workspace canvas with one or more tiled outliner panels.
- White outline panels on a pale gray app background.
- Outliner content remains the primary visual object.

Avoid marketing-page composition, decorative card stacks, large empty hero-like
areas, and ornamental color. Every surface should look useful, editable, and
native to a desktop app.

## Reference Boundary

Tana is a reference for density, spacing, and surface hierarchy, but not for
feature scope. Lin keeps its own navigation model, command model, outliner
behavior, and agent model.

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
- Do not use fake product panels for shipped UI. A panel that looks like an
  outliner in the application must be backed by the real outliner UI.

Sider-agent is a reference for mature side-panel agent interaction, not for
Lin's visual system. The detailed agent boundary lives in
[`agent.md`](./agent.md).

Use sider-agent as a reference for:

- Persistent side-panel agent structure.
- Turn-level rendering that groups assistant prose, thinking, and tool calls.
- Collapsible process/tool-call blocks with user-owned expand state.
- Composer behavior for streaming, steering, send/stop, IME, and bounded
  auto-resize.
- Viewport-aware floating menus for model and reasoning controls.
- Chat scroll behavior that respects the user's reading position.

Do not copy sider-agent as product behavior or visual style:

- Do not use its Chrome extension assumptions, browser/VM/skill tooling, or
  storage model unless Lin explicitly owns those capabilities.
- Do not use its warm paper palette, heavy paper shadow, global hidden
  scrollbars, or side-panel-only layout constraints.
- Do not let agent UI become visually heavier than the outliner workspace.

## App Shell Pattern

For the broader workspace state model, see [`../workspace-layout.md`](../workspace-layout.md).

Product implementation:

- `src/renderer/ui/App.tsx`
- `src/renderer/ui/TopBar.tsx`
- `src/renderer/ui/Sidebar.tsx`
- `src/renderer/ui/WorkspaceCanvas.tsx`
- `src/renderer/ui/AgentDock.tsx`
- `src/renderer/styles.css`

The app shell owns persistent outer surfaces. Workspace tabs own only the
central canvas.

```txt
App shell
  Top chrome
  Body grid
    Sidebar dock
    Workspace canvas
    Agent dock
```

CSS state classes:

```txt
.app-shell
.app-shell.sidebar-collapsed
.app-shell.agent-collapsed
.app-shell.sidebar-collapsed.agent-collapsed
```

Rules:

- Sidebar and agent docks collapse independently.
- Collapsing a dock changes the shell grid, not the active tab state.
- Sidebar and agent visibility stay outside workspace tab state.
- Panel state stays inside the active workspace tab model.

## Multi-Panel Canvas Pattern

- One panel fills the canvas. Its content column is either bounded and centered
  by `--panel-content-max`, or fills the panel when the panel is narrower than
  that content width.
- Two or more panels always share the available canvas width according to
  persisted ratios.
- Workspace canvas does not use horizontal scrolling as the normal layout mode.
  Panels may shrink below their preferred resize floor when the canvas is narrow;
  overflow belongs inside the owning panel content, not on the canvas.
- Panels are tiled left to right.
- Panel resize handle slots sit between panels and use `--resize-gap`.

## Responsive Shell Pattern

Lin is desktop-first, but the shell must degrade predictably.

- Above `1280px`: sidebar, canvas, and agent can all be visible.
- Between `960px` and `1279px`: keep the sidebar and canvas usable; the agent
  may start collapsed by default in new windows.
- Below `960px`: collapse the agent dock by default.
- Below `760px`: collapse the sidebar by default and show only the active panel.
- User choices override default collapse behavior for the current window unless
  the available width would make the active panel unusably narrow.

## Layout Specimens

[`index.html`](./index.html) should show layout as a state matrix, not as a
detailed product mockup. The required states are:

- Default desktop: sidebar + canvas + agent.
- Sidebar collapsed.
- Agent collapsed.
- Sidebar and agent both collapsed.

Layout specimens should show only shell structure, panel count, resize slots,
and collapsed/expanded states. Component details belong in
[`components.md`](./components.md).

## Tag Hover Pattern

The tag hover interaction is a product pattern because it coordinates layout,
color, hit targets, and accessibility.

- Normal state owns the measured width.
- Hover state is constrained to the same measured box.
- The hash marker and close icon share the same `12px` slot.
- The normal text start and hover text start both resolve to `26px`.
- A real `2px` physical gap separates the close icon from the label-only pill.

Detailed component rules live in [`components.md`](./components.md).
