# Workspace Layout

This document describes the app layout model: the workspace layout, the
workspace canvas, outline panels, the sidebar, and the agent dock.

For visual tokens, density, typography, and interaction states, see the
single-file design-system contract:
[`design-system.md`](./design-system.md).

There is **no tab concept.** Earlier iterations nested panels inside switchable
workspace tabs; that layer was removed (it was never used in practice). The
canvas now has exactly one container primitive — the **pane**.

## Core Model

The app shell owns the persistent outer surfaces. A single workspace layout owns
the central canvas.

```txt
App Shell
  -> Window chrome (top strip)
     -> left: traffic lights + sidebar toggle
     -> center: per-pane breadcrumb headers
     -> right: agent dock header + agent toggle
  -> Sidebar rail (left)  -> navigation
  -> Workspace layout
     -> Workspace canvas
        -> tiled outline panels
  -> Agent rail (right)
  -> Overlay layer
```

The important boundaries:

- Sidebar is independent of the canvas layout.
- Agent dock is independent of the canvas layout.
- The workspace layout is the central workspace canvas only.
- The layout contains one or more panes.
- Panes are tiled side by side. They do not overlap or cover each other.

## Window Chrome (Top Strip)

The window chrome is a single thin strip at the window top, at traffic-light
height. It is the window's title-bar drag region and is part of the app shell.
There is **no global tab strip and no top-bar back/forward**; page-history
navigation is keyboard-driven. The full visual contract is in
[`design-system.md`](./design-system.md) → Shell; this section covers only the
ownership model.

The strip holds three regions on one shared centreline:

```txt
Window chrome (top strip)
  -> left corner   -> traffic lights + sidebar toggle
  -> center        -> per-pane breadcrumb headers
  -> right corner  -> agent dock header + agent toggle
```

Left corner — window controls:

- Platform window affordances (macOS traffic lights when applicable).
- Sidebar toggle.

These are fixed window-chrome controls anchored to the window's top-left. They
do not move when the sidebar collapses (only the rail slides away).

Center — per-pane breadcrumb headers:

- Each open pane contributes its own breadcrumb header (`avatar / path /
  current`) with a `×` close at its right; the last remaining pane shows no `×`.
- The breadcrumb is the pane's header and its drag region. A per-pane back
  control lives in the breadcrumb row; global page-history back/forward are on
  `Cmd+[` / `Cmd+]` with no chrome buttons.

Right corner — agent chrome:

- The agent dock's header (`✦` brand mark + conversation title) when open.
- The agent toggle, pinned to the top-right corner as a fixed window-chrome
  control.

The sidebar and agent toggles are symmetric: fixed, neutral, and signalling
open/collapsed by glyph state in place, never by a selected background or a
moving position. Menus, confirmations, and account/settings popovers opened from
chrome render through the shared overlay layer, not inline in the strip.

## Terms

App shell:

The outer application frame. It contains the window chrome (top strip), the
sidebar rail, the workspace canvas, the agent rail, and global overlays.

Workspace layout:

The persisted state of the central canvas: the set of panes, their order and
sizes, and which pane is active. It does not own the sidebar or agent dock.

Workspace canvas:

The central area. It lays out one or more panes on top of the app background.

Pane (outline panel):

A document or outline view inside the canvas — the single canvas primitive.
Panes are tiled in a single row. They may be resizable, but they do not overlap.
A pane is one of two variants: an outliner pane (a node root) or an agent-debug
pane (a session inspector). Both tile identically.

Agent dock:

The conversation surface on the right side. It can read and edit the outliner
through tools, using the active pane as default context.

Sidebar dock:

The navigation surface on the left side. It exposes global entry points such as
Today, Library, Recents, and Schema, followed by pinned nodes and the current
workspace root outline. Recents is a saved search node rather than bespoke
sidebar logic; the root outline renders all real root children (Daily notes,
Library, Schema, Saved searches, Trash, Settings — none hidden). The current
workspace root itself is a clickable row with a compact avatar. Sidebar rows
share one content axis for text and icons; tree chevrons sit in the auxiliary
gutter before that axis, so they never push the main content inward. The content
axis starts `20px` from the sidebar edge; rows extend to the sidebar edge so the
only visual gap to the canvas is the standard shell gap. Chevrons use a compact
`16px` hit area that starts `4px` from the sidebar edge. Sidebar rows use a
slightly roomier navigation rhythm than dense controls, with a 28px row height
and 16px icon slots. Chevrons stay low-contrast. Primary sidebar entries use the
shared neutral control hover fill; the workspace root outline stays
background-free on hover and only deepens the row text/icon color.

## Visual Layering

There is a visual z-axis between broad surfaces, but not between outline panes.

```txt
Background layer
  -> app window background
  -> sidebar background
  -> agent dock background
  -> workspace canvas background

Raised content layer
  -> outline panes as white surfaces on the canvas

Overlay layer
  -> menus
  -> popovers
  -> command palette
  -> confirmations
  -> transient previews
```

Panes are not free-floating windows. They are tiled siblings. The implementation
does not introduce pane overlap, arbitrary pane `zIndex`, or freeform drag
stacking.

## Layout Semantics

The workspace layout owns the canvas. Its persisted shape:

```ts
interface WorkspacePanelBase {
  id: string;
  size: number; // tile flex ratio
}

interface OutlinePanelState extends WorkspacePanelBase {
  type: 'outliner';
  rootId: NodeId;
  pageBackStack?: NodeId[];
  pageForwardStack?: NodeId[];
}

interface AgentDebugPanelState extends WorkspacePanelBase {
  type: 'agent-debug';
  sessionId: string | null;
}

type WorkspacePanelState = OutlinePanelState | AgentDebugPanelState;

interface WorkspaceLayout {
  activePanelId: string;
  panels: WorkspacePanelState[];
}
```

The tile ratio (`size`) lives **on the panel**, not in a separate parallel map —
one array is the whole layout truth, so adding/closing a pane cannot desync a
side table. The layout is persisted to `localStorage`
(`lin-outliner:workspace-layout:v2`). It is UI state; document content remains in
the TypeScript-backed document model.

The layout does **not** include:

- Sidebar visibility or navigation state.
- Agent conversation state, scroll, or input.
- Document operation undo/redo state. Per-pane page history is navigation history
  only and must not change document history.

**Default layout:** a single outliner pane on Today. The user opens additional
panes on demand (see Interaction Examples). There is no saved/named multi-pane
layout feature — that capability went away with tabs and is not replaced by pins
(pins park individual nodes for quick access, a different and smaller thing).

### Extensibility seam (preview, etc.)

`WorkspacePanelState` is an **extensible discriminated union** (`type`
discriminant over a shared `WorkspacePanelBase`). New pane kinds are added as a
union member + a `WorkspaceCanvas` render branch + a `sanitizePanel` branch,
without reshaping existing panes. The planned consumer is a `file-preview` pane
for `local-file` references (Cmd/Ctrl+click on such a reference → new preview
pane).

Per-pane history is currently **outliner-only** (`pageBackStack: NodeId[]` —
a stack of roots). Previewing a file *in the current pane* (plain click, with
"back" returning to the node view) needs a history entry that is not a node;
when that feature lands, generalize the root stack into a **view-state stack** so
a pane's current view and its history are both a `PaneView`:

```ts
type PaneView =
  | { kind: 'outliner'; rootId: NodeId }
  | { kind: 'file-preview'; path: string; entryKind: 'file' | 'directory' };
```

This is a deliberate, documented seam — not yet built: today history is
`NodeId[]` and a pane's current view is its `type` + `rootId`.

## Panel Semantics

An outline pane is a view into document data. Multiple panes can show different
roots, or different views into the same underlying document graph.

Pane order is array order. There is no `panelZOrder`.

```txt
panels[0] -> leftmost pane
panels[1] -> next pane
panels[2] -> next pane
```

The active pane is the pane that receives outline keyboard commands when focus is
in the workspace canvas.

## Tiled Layout

The canvas uses a horizontal tiled layout.

Rules:

- Panes are laid out from left to right.
- Panes have minimum and maximum widths.
- Panes resize proportionally according to their persisted `size` ratios while
  every pane can satisfy the minimum width defined in
  [`design-system.md#foundations`](./design-system.md#foundations).
- If pane minimum widths exceed the available canvas width, horizontal scrolling
  is allowed inside the workspace canvas. Do not shrink panes below the minimum
  just to avoid scrolling.
- Pane resize handles sit between panes.
- Opening a pane appends it next to the current pane or at the end, capped at
  `MAX_PERSISTED_PANELS` (4). At the cap, opening replaces the rightmost pane's
  root rather than adding a fifth pane.
- Closing a pane removes it from the layout. If it was active, focus moves to the
  nearest remaining pane.

Avoid making every pane independent `position:absolute` — the product does not do
freeform window management.

## Sidebar Boundary

The sidebar is independent of the canvas layout. It is not recreated when the
layout changes.

Sidebar responsibilities:

- Global navigation entries.
- Workspace roots (all root sections shown; none hidden).
- Search and library entry points.
- Recents.
- Future global metadata surfaces (e.g. pinned nodes).

The sidebar opens a node into the canvas. A plain click replaces the active
pane's root; Alt/Option-click opens the node in a new pane.

## Agent Boundary

The agent dock is independent of the canvas layout, but its default tools operate
against the active-pane context.

The agent can ask:

- Which pane is active?
- Which panes are open?
- What is selected in the active pane?
- What nodes are visible in the active pane?

The agent can request:

- Open a node in the active pane.
- Open a node in a new pane.
- Apply a document edit through commands.
- Show a diff or approval overlay.

The agent should not:

- Store its transcript in the workspace layout.
- Directly mutate pane state without going through a tool or UI action.

The agent's view context is pane-centric (`activePanelId`, `focusedPanelId`,
`nodePanels`); it carries no tab concept.

## Focus Model

The app distinguishes the focused surface from the active pane.

```ts
type FocusedSurface =
  | 'sidebar'
  | 'workspace'
  | 'agent'
  | 'overlay';

interface ShellFocusState {
  focusedSurface: FocusedSurface;
  activePanelId: string | null;
}
```

Examples:

- Clicking an outline row sets `focusedSurface = 'workspace'` and updates the
  active pane.
- Typing in the agent input sets `focusedSurface = 'agent'` but does not clear
  the active pane.
- Opening the command palette sets `focusedSurface = 'overlay'` while retaining
  the previous surface for restore.

## Overlay Layer

Overlays are global to the app shell, not nested deeply inside panes. This avoids
clipping and stacking conflicts.

Overlay examples:

- Command palette.
- Node context menu.
- Tag/reference trigger popovers.
- Agent tool approval.
- Agent diff preview.
- Global search.

An overlay may be anchored to a pane row or to the agent panel, but it renders
through a common overlay host.

```ts
interface OverlayState {
  kind: 'command_palette' | 'node_menu' | 'trigger' | 'agent_approval' | 'diff_preview';
  anchor?: OverlayAnchor;
}
```

## Suggested Shell State

```ts
interface AppShellState {
  layout: WorkspaceLayout;
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

This is UI state. Document content remains in the TypeScript-backed document
model.

## Interaction Examples

Open node from sidebar:

```txt
User clicks Today in sidebar
  -> active pane root changes to Today (plain click), or
  -> a new pane opens on Today (Alt/Option-click)
  -> sidebar remains mounted
  -> agent remains mounted
```

Open node in a split pane:

```txt
User Cmd/Ctrl-clicks a reference, or picks "Open in split pane" from the
node context menu
  -> append an OutlinePanelState to layout.panels (or, at the 4-pane cap,
     replace the rightmost pane's root)
  -> set activePanelId to that pane
  -> layout recalculates tiled widths from each pane's size
```

Close a pane:

```txt
User clicks the breadcrumb × on a pane (shown only when >1 pane)
  -> remove the pane from layout.panels
  -> if it was active, focus moves to the nearest remaining pane
```

Agent edits current selection:

```txt
User asks agent to rewrite selected node
  -> agent reads activePanelId
  -> agent reads active-pane selection
  -> agent proposes edit
  -> user approves if needed
  -> command applies document mutation
  -> projection updates
```

## Implementation Notes

- Panes lay out as a flex row; each pane's flex basis derives from its `size`.
- Keep pane state normalized enough that adding and closing panes is cheap (the
  `size`-on-panel shape means there is no parallel size map to maintain).
- Do not introduce arbitrary pane z-order; there is no overlapping-windows need.
- Keep agent state and sidebar state outside the layout.
- Route all overlays through the shared overlay host.
