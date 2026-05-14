# Workspace Layout

This document describes the planned app layout model for tabs, the workspace
canvas, outline panels, the sidebar, and the agent dock.

For visual tokens, density, typography, and interaction states, see
[`design-system.md`](./design-system.md).

## Core Model

The app shell owns the persistent outer surfaces. Tabs own only the central
workspace canvas.

```txt
App Shell
  -> Top chrome
     -> navigation controls
     -> tab strip
     -> global actions
  -> Sidebar dock
  -> Active tab content
     -> Workspace canvas
        -> tiled outline panels
  -> Agent dock
  -> Overlay layer
```

The important boundary is:

- Sidebar is cross-tab.
- Agent dock is cross-tab.
- Tab content is the central workspace canvas only.
- A tab may contain one or more outline panels.
- Outline panels are tiled side by side. They do not overlap or cover each
  other.

## Top Chrome

The top chrome is part of the app shell. It is above the workspace canvas and
is not owned by any workspace tab.

It has three regions:

```txt
Top chrome
  -> left window and navigation controls
  -> center tab strip
  -> right global actions
```

Left window and navigation controls:

- Platform window affordances when applicable.
- Sidebar toggle.
- Back and forward navigation.
- Future history or workspace navigation controls.

These controls are shell-level controls. They should not be stored inside a
workspace tab. Back and forward navigation may operate on the active tab's
panel history, but the controls themselves remain in the app shell.

Center tab strip:

- Shows workspace tabs.
- Indicates the active tab.
- Supports creating a new tab.
- May eventually support reordering, closing, and renaming tabs.

The tab strip switches only the central workspace canvas. It does not switch
the sidebar dock or the agent dock.

Right global actions:

- Agent entry or agent mode affordance.
- User/account/profile affordance.
- Future sync, notification, settings, or workspace-level actions.

These actions are also shell-level controls. They sit visually above the agent
dock, but they are not part of the agent transcript. If an action opens a menu,
confirmation, or account popover, it should render through the shared overlay
layer.

## Terms

App shell:

The outer application frame. It contains the tab strip, sidebar dock, active
workspace canvas, agent dock, and global overlays.

Workspace tab:

A saved central workspace layout. A tab contains the state needed to reconstruct
the canvas and its outline panels. It does not own the sidebar or agent dock.

Workspace canvas:

The central area selected by the active tab. It lays out one or more outline
panels on top of the app background.

Outline panel:

A document or outline view inside a workspace canvas. Panels are tiled in a
single row for the initial design. They may be resizable, but they do not
overlap.

Agent dock:

The cross-tab conversation surface on the right side. It can read and edit the
outliner through tools, using the active tab as default context.

Sidebar dock:

The cross-tab navigation surface on the left side. It exposes global entry
points such as Today, Search, Supertags, Library, Recents, and workspace roots.

## Visual Layering

There is a visual z-axis between broad surfaces, but not between outline panels.

```txt
Background layer
  -> app window background
  -> sidebar background
  -> agent dock background
  -> workspace canvas background

Raised content layer
  -> outline panels as white surfaces on the canvas

Overlay layer
  -> menus
  -> popovers
  -> command palette
  -> confirmations
  -> transient previews
```

Outline panels themselves are not free-floating windows. They are tiled
siblings. The implementation should not introduce panel overlap, arbitrary
panel `zIndex`, or freeform drag stacking for the initial layout.

## Tab Semantics

Top tabs represent central workspace canvas layouts. They do not represent
agent conversations and they do not include the sidebar state.

```ts
interface WorkspaceTab {
  id: string;
  title: string;
  activePanelId: string | null;
  panels: OutlinePanelState[];
}
```

Switching tabs changes:

- The set of outline panels in the central canvas.
- The active outline panel.
- Panel widths, panel order, scroll positions, and per-panel view state.

Switching tabs should not reset:

- Sidebar visibility or navigation state.
- Agent conversation state.
- Agent panel scroll/input state, unless a future product decision explicitly
  binds conversations to tabs.

## Panel Semantics

An outline panel is a view into document data. Multiple panels can show
different roots, or they can show different views into the same underlying
document graph.

```ts
interface OutlinePanelState {
  id: string;
  rootNodeId: NodeId;
  title?: string;
  width?: number;
  scrollTop?: number;
  focusedId?: NodeId | null;
  selectedId?: NodeId | null;
  selectedIds?: NodeId[];
  expanded?: NodeId[];
}
```

Panel order is array order. There is no `panelZOrder` in the initial model.

```txt
panels[0] -> leftmost panel
panels[1] -> next panel
panels[2] -> next panel
```

The active panel is the panel that receives outline keyboard commands when the
focus is in the workspace canvas.

## Tiled Layout

The first implementation should use a horizontal tiled layout.

Rules:

- Panels are laid out from left to right.
- Panels have minimum and maximum widths.
- The active canvas can scroll horizontally if panels exceed available width,
  or panels can resize proportionally. This should be chosen during
  implementation.
- Panel resize handles may be added between panels.
- Adding a panel appends it next to the current panel or at the end.
- Closing a panel removes it from the tab. If it was active, focus moves to the
  nearest remaining panel.

Possible sizing model:

```ts
interface PanelLayout {
  panelId: string;
  basisPx?: number;
  flex?: number;
  minWidthPx: number;
}
```

Avoid making every panel independent `position:absolute` unless the product
explicitly moves to freeform window management later.

## Sidebar Boundary

The sidebar is cross-tab. It should not be recreated when a tab changes.

Sidebar responsibilities:

- Global navigation entries.
- Workspace roots.
- Search and library entry points.
- Recents.
- Future global metadata surfaces.

The sidebar may open a node into the active tab's canvas. For example, clicking
Today can replace the active panel root or open Today in a new panel depending
on the current command mode.

## Agent Boundary

The agent dock is cross-tab. It is independent from the active tab, but its
default tools operate against the active tab context.

The agent can ask:

- Which tab is active?
- Which outline panels are open?
- Which panel is active?
- What is selected in the active panel?
- What nodes are visible in the active panel?

The agent can request:

- Open a node in the active panel.
- Open a node in a new panel.
- Apply a document edit through commands.
- Show a diff or approval overlay.

The agent should not:

- Store its transcript in a workspace tab.
- Directly mutate panel state without going through a tool or UI action.
- Force a tab switch unless the user or a tool explicitly requests it.

## Focus Model

The app should distinguish the focused surface from the active panel.

```ts
type FocusedSurface =
  | 'sidebar'
  | 'workspace'
  | 'agent'
  | 'overlay';

interface ShellFocusState {
  focusedSurface: FocusedSurface;
  activeTabId: string;
}
```

Workspace tabs then track their own active panel:

```ts
interface WorkspaceTab {
  id: string;
  activePanelId: string | null;
  panels: OutlinePanelState[];
}
```

Examples:

- Clicking an outline row sets `focusedSurface = 'workspace'` and updates the
  active panel.
- Typing in the agent input sets `focusedSurface = 'agent'` but does not clear
  the active panel.
- Opening the command palette sets `focusedSurface = 'overlay'` while retaining
  the previous surface for restore.

## Overlay Layer

Overlays should be global to the app shell, not nested deeply inside panels.
This avoids clipping and stacking conflicts.

Overlay examples:

- Command palette.
- Node context menu.
- Tag/reference trigger popovers.
- Agent tool approval.
- Agent diff preview.
- Global search.

An overlay may be anchored to a panel row or to the agent panel, but it should
render through a common overlay host.

```ts
interface OverlayState {
  kind: 'command_palette' | 'node_menu' | 'trigger' | 'agent_approval' | 'diff_preview';
  anchor?: OverlayAnchor;
}
```

## Suggested Shell State

```ts
interface AppShellState {
  activeTabId: string;
  tabs: WorkspaceTab[];
  sidebar: SidebarState;
  agent: AgentPanelState;
  focus: ShellFocusState;
}

interface SidebarState {
  widthPx: number;
  collapsed: boolean;
  expandedWorkspaceIds: string[];
}

interface AgentPanelState {
  widthPx: number;
  collapsed: boolean;
  activeConversationId: string | null;
}
```

This is UI state. Document content remains in the TypeScript-backed document model.

## Interaction Examples

Open node from sidebar:

```txt
User clicks Today in sidebar
  -> active tab remains the same
  -> active panel root changes to Today, or a new panel opens
  -> sidebar remains mounted
  -> agent remains mounted
```

Switch tab:

```txt
User clicks top tab
  -> activeTabId changes
  -> central canvas panels change
  -> sidebar unchanged
  -> agent unchanged
```

Agent edits current selection:

```txt
User asks agent to rewrite selected node
  -> agent reads activeTabId
  -> agent reads active panel selection
  -> agent proposes edit
  -> user approves if needed
  -> command applies document mutation
  -> projection updates
  -> active tab and panel remain mounted
```

Open new outline panel:

```txt
User opens a node in split view
  -> append OutlinePanelState to active tab.panels
  -> set activePanelId to the new panel
  -> layout recalculates tiled widths
```

## Implementation Notes

- Start with a simple `display: grid` or flex row for panels.
- Keep panel state normalized enough that adding and closing panels is cheap.
- Do not introduce arbitrary panel z-order until there is a concrete product
  need for overlapping windows.
- Keep agent state outside tab state from the beginning.
- Keep sidebar state outside tab state from the beginning.
- Add a shared overlay host early, even if it initially renders only the
  command palette and trigger popovers.
