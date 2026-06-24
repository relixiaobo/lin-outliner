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

- The agent dock's header (channel hash glyph + conversation title) when open —
  every conversation is one of Neva's channels, so there is no per-conversation
  agent avatar (it would always be the same single agent), matching the channel
  list rows.
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
sidebar logic. Pinned nodes are renderer workspace chrome, not document state:
they are persisted in localStorage under
`lin-outliner:workspace-layout:v3:pinned`, sanitized against the live projection
on restore, and can be toggled from the outliner row context menu or from a
reduced sidebar row context menu. They preserve insertion order, are not
reorderable, and do not participate in core undo/redo. A pinned node remains
pinned while it is in Trash; the sidebar row stays visible with a line-through
label to show that the node has been deleted. Pinned ids are dropped only when
the node id no longer exists in the projection. The root outline renders all real
root children (Daily notes,
Library, Schema, Saved searches, Trash, Settings — none hidden). The current
workspace root itself is a clickable row with a compact avatar. Sidebar rows
share one content axis; primary-nav entries and the workspace-root avatar sit on
it with a 16px icon, but workspace-tree rows are text-only — a node's icon (its
own emoji, or the fixed fallback glyph for the system roots) renders in the
outliner, not in the tree, so the navigation list stays scannable. Tree chevrons
sit in the auxiliary gutter before that axis, so they never push the main content
inward. The content axis starts `20px` from the sidebar edge; rows extend to the
sidebar edge so the only visual gap to the canvas is the standard shell gap.
Chevrons use a compact `16px` hit area that starts `4px` from the sidebar edge.
Sidebar rows use a slightly roomier navigation rhythm than dense controls, with a
28px row height. Chevrons stay low-contrast. Primary sidebar entries use the
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

type PreviewTarget =
  | { kind: 'local-file'; path: string; entryKind: 'file' | 'directory'; label?: string }
  | { kind: 'asset'; assetId: string; label?: string }
  | { kind: 'agent-payload'; conversationId: string; runId?: string; payloadId: string; label?: string }
  | { kind: 'url'; url: string; label?: string };

type PanelView =
  | { kind: 'outliner'; rootId: NodeId; scrollTop?: number }
  | { kind: 'file-preview'; target: PreviewTarget; nodeId?: NodeId; presentation?: 'reader'; scrollTop?: number };

interface WorkspaceContentPanelState extends WorkspacePanelBase {
  type: 'workspace';
  view: PanelView;
  backStack: PanelView[]; // always seeded; never absent
  forwardStack: PanelView[];
}

interface AgentDebugPanelState extends WorkspacePanelBase {
  type: 'agent-debug';
  conversationId: string | null;
  runId: string | null;
}

type WorkspacePanelState = WorkspaceContentPanelState | AgentDebugPanelState;

interface WorkspaceLayout {
  activePanelId: string;
  panels: WorkspacePanelState[];
}
```

Outliner content is a panel view, not the panel's top-level discriminator:

```ts
{
  type: 'workspace',
  view: { kind: 'outliner', rootId: NodeId },
  backStack: [],
  forwardStack: [],
}
```

File preview uses the same workspace panel host and the same history stack:

```ts
{
  type: 'workspace',
  view: {
    kind: 'file-preview',
    target: { kind: 'local-file', path: '/tmp/example.md', entryKind: 'file' },
  },
  backStack: [{ kind: 'outliner', rootId: NodeId }],
  forwardStack: [],
}
```

The tile ratio (`size`) lives **on the panel**, not in a separate parallel map —
one array is the whole layout truth, so adding/closing a pane cannot desync a
side table. The layout is persisted to `localStorage`
(`lin-outliner:workspace-layout:v4`). It is UI state; document content remains in
the TypeScript-backed document model. Pre-release layout shape changes do not
ship migrations or legacy readers; old dev userData can be wiped.

The canvas is anchored by at least one outliner view (current or in a workspace
pane's view history) so startup can restore focus. A restored layout that
sanitizes down to only agent-debug panes has nothing to anchor, so it is treated
as corrupt and replaced by the default single pane rather than booting into a
rootless canvas.

The layout does **not** include:

- Sidebar visibility or navigation state.
- Pinned node ids. They are separate renderer-local sidebar state under
  `lin-outliner:workspace-layout:v3:pinned`, not part of the pane layout object
  and not part of the event-sourced document.
- Outliner row expansion state. Each root node page has renderer-local outline
  view state, stored separately from the pane layout.
- Agent conversation state, scroll, or input.
- Document operation undo/redo state. Per-pane view history is navigation
  history only and must not change document history.

**Default layout:** a single workspace pane on Today's outliner view. The user
opens additional panes on demand (see Interaction Examples). There is no
saved/named multi-pane layout feature — that capability went away with tabs and
is not replaced by pins (pins park individual nodes for quick access, a
different and smaller thing). The ephemeral pane layout is restored only within
the same local calendar day; on a later day, startup ignores stale pane views and
returns to the current Today node.
When a same-day layout restores multiple outliner views, startup replays outline
view state for every outliner root found in current views and view history. That
replay belongs to the separate outline view-state store and merges into the
shared renderer expansion set; it does not live in the pane layout record.

### Extensibility seam (preview, etc.)

`WorkspacePanelState` is an **extensible discriminated union** (`type`
discriminant over a shared `WorkspacePanelBase`). The reusable document-content
host is `type: 'workspace'`; its `view` decides whether `WorkspaceCanvas` renders
the outliner or the file preview. New non-document chrome panels, such as
`agent-debug`, are still added as union members.

Per-pane history is a **view-state stack** (`backStack: PanelView[]`,
`forwardStack: PanelView[]`). Opening a node in the current pane pushes the
previous view, whether that previous view was an outliner or a file preview.
Opening a file preview in the current pane does the same, so Back can return to
the originating node view. Each view may carry its last panel `scrollTop`.
Back/Forward restores that scroll position; when a restored outliner view has a
saved scroll position, navigation does not auto-focus the first body row because
that focus would pull the scroll container back to the top, but row selection is
preserved just like unscrolled outliner history. Programmatic scroll restore is
not echoed back into history while layout is still settling, so a browser-clamped
intermediate `scrollTop` cannot overwrite the saved position for the next
Back/Forward visit.

### File preview panel

A file that **is** an outliner node (an `attachment` or `image` node) behaves
like a normal outline row, but its presentation depends on the kind. A non-image
file is a lightweight name row: its **file-type icon is the bullet** (the `file`
RowMarker variant), the row content is the **read-only filename** (a caret can
land in it, but ordinary input never renames it), and the **chevron expands an
inline preview** below the row (the same preview widget the node page uses,
started collapsed/peek). Non-image row actions live in the preview surface, not
on a row-level `⋯`. An image renders the image itself inline as the row content;
a plain click selects the row rather than opening a different page, while its
top-right menu owns Maximize. The bullet drills into the node page; real child
nodes still render below the inline preview. See "File node" in
`ui-behavior.md`.

Opening a file node shows the same `file-preview` workspace view used by loose
sources, but with `nodeId` set. That `nodeId` is the lifecycle switch:

- Without `nodeId`, the view is a loose preview. The breadcrumb is sourced from
  the filesystem/source identity, the title is the read-only filename/source
  label, and no children outline is mounted.
- With `nodeId`, the view is an ingested file node. The breadcrumb is sourced
  from the outliner ancestry, the title remains the read-only filename, and the
  file node's children outline mounts below the preview hero.
- With `nodeId` plus `presentation: 'reader'`, the view is a file-only reader.
  It keeps the node binding so the asset target can persist and sanitize safely,
  but it does **not** render the file node page: no outliner ancestry breadcrumb,
  title hero, children outline, References section, Expand/Collapse primary, or
  inner preview resize handle. The header is a compact back control + filename +
  `⋯` file-action menu, and the body is the full reader content.

`file-preview` is a workspace-panel view, not an overlay and not part of the
agent dock. It is opened for outliner file nodes, outliner inline local-file refs,
agent meta-surface inline local-file refs, visible agent payload rows, and nested
links followed from inside a preview body (e.g. a directory-listing entry). Live
agent transcript file chips open the same `file-preview` view with
`presentation: 'reader'`, so the file-only reader appears in the center workspace
area by reusing the active/available workspace pane instead of adding a split pane
or previewing in the agent dock. A plain workspace preview click opens in the
active workspace pane when there is one; if the click originates in the agent dock,
the active workspace pane is used, then the first available workspace pane.
Cmd/Ctrl-click opens a split pane. When the 4-pane cap is already reached,
preview reuses the rightmost workspace pane and preserves that pane's view
history so Back can return to the previous outliner or preview view.

The unified view renders one frame in both lifecycle states: sticky breadcrumb,
read-only filename title, the `FilePreviewShell` preview, and optional children
outline. Non-image file sources use one bottom-center preview action bar (a
fixed-width primary button plus a separate circular `⋯` menu button), not a top
toolbar, and that action location is the same for every format. Previewable
sources use the primary to toggle between a collapsed peek and an expanded
full-scroll height, and the `⋯` menu carries
Open-in-split-pane / Show-in-Finder / Open-with-default-app / Copy (an ingested
asset) or Add-to-outline (a loose source). Non-previewable sources render a compact
metadata fallback card with the file kind and size on one line, modified date on
its own line, and no icon; the same action bar shows short `Open` as its primary and `⋯` for
secondary system actions, so unsupported formats do not teach a different control
location.
The same `FilePreviewShell` mounts both inline under an expanded file row
(started collapsed) and on the node page (started expanded). Changing a loose
preview into an ingested node mutates the same mounted view (`nodeId` is added);
it does not navigate to a different panel
kind or remount the preview body.

The renderer normalizes every entry point to `PreviewTarget` and asks main to
resolve it through the preload preview API:

- `preview_resolve_source` returns source metadata and never exposes raw payload
  filesystem paths to the renderer.
- `preview_read_text` is capped to bounded text reads.
- `preview_read_bytes` is capped to bounded binary reads for image/PDF previews.
- `preview_list_directory` lists trusted local-file directories with a capped
  result set.

Source authority stays source-specific:

- `local-file` targets are validated in main through the local-file reference
  policy before reads or external open.
- `asset` targets resolve by `assetId` inside the asset jail. Image rendering may
  use the existing `asset://` URL; open/reveal/copy stay on the existing asset
  commands. A standalone `asset` preview is only valid when the view is bound to a
  file node via `nodeId`; a persisted `file-preview` view whose target is an
  `asset` but has no `nodeId` is dropped on restore (pre-launch — no migration).
- `agent-payload` targets resolve only through the active replay state for the
  referenced conversation and payload id. Normal conversation payloads can be
  previewed; debug-only payloads are not exposed through the normal preview
  router. Renderer code never receives a payload file path.
- `url` targets are modeled but only render metadata/unsupported until the URL
  reader PR ships.

Renderers are directory listing, image, PDF (`pdf.js`; every page is stacked
vertically and scrolled to navigate — each page renders lazily as it nears the
scroll viewport and is fitted to the available width, with no page-nav or zoom
controls), text/source-code with Shiki, Markdown with `react-markdown` +
`remark-gfm`, CSV/TSV table, and fallback metadata. The PDF renderer reads bytes
only through the preview source API, uses a bundled same-origin worker, and falls
back to the metadata renderer if parsing or rendering fails. Markdown renderer output does
not enable raw HTML execution; arbitrary HTML files render as text or fallback.

**Add to outline.** A non-node preview carries an "add to outline" action that
saves the source into the document as a file node. It is offered for the kinds
that can be copied into the asset store: `local-file` (full-file ingest, gated to
the agent's trusted roots) and `agent-payload` (bounded byte read — it errors
rather than truncating past the cap, so an oversized payload reports not-added
instead of committing a partial file). `url` is not yet ingestable. Anything the
preview can resolve, it can ingest — the same security boundary backs both, so
no new command-surface or main-process gate is introduced. The renderer copies
the bytes into the asset store and creates an `image`/`attachment` node under
Today, then binds the same mounted `file-preview` view to the new node id; from
then on the source is an ingested node with outliner ancestry and a children
outline. The preview pane reaches App's document state through a single-handler
request bridge (`previewIngest`, mirroring `agentFileInsert`); the action
confirms only on a real insert.

## Panel Semantics

An outline view is a view into document data. Multiple panes can show different
roots, or different views into the same underlying document graph.

Pane order is array order. There is no `panelZOrder`.

```txt
panels[0] -> leftmost pane
panels[1] -> next pane
panels[2] -> next pane
```

The active pane is the pane that receives outline keyboard commands when focus is
in the workspace canvas.

Operations that act on "the active pane's outliner" — page-history Back/Forward
(`Cmd+[` / `Cmd+]`) and "open the active root in a pane" (`Cmd+M`) — key off the
active pane *only when it is an outliner*. When a debug pane is active they no-op
rather than reaching across to another pane. Untargeted navigation
(`navigateRoot` — sidebar plain click, command palette, "go to root") targets the
active outliner pane if there is one, else an existing outliner pane, else opens
one; it never replaces the whole canvas. Ambient UI that merely needs "the
outliner the user is looking at" (sidebar root highlight, drag-selection scope)
falls back to the first outliner pane when a debug pane holds the active slot.

## Tiled Layout

The canvas uses a horizontal tiled layout.

Rules:

- Panes are laid out from left to right.
- Panes have minimum and maximum widths.
- Panes resize proportionally according to their persisted `size` ratios, using
  the panel floor defined in [`design-system.md#foundations`](./design-system.md#foundations)
  whenever the current window and rail state can satisfy it.
- The workspace canvas never uses a horizontal scrollbar as a rescue path. It
  stays `overflow-x: hidden`; responsive guards keep the layout inside the
  canvas instead of exposing sideways scroll.
- The CSS pane min-width backstop is limited to single-pane canvases. Multi-pane
  capacity is enforced before adding panes because a hard per-pane CSS `min-width`
  would turn impossible narrow states into canvas-level horizontal overflow.
- Sidebar and agent rail widths keep a user preference separate from their
  rendered width. Drag, keyboard resize, and reset update the preference; rail
  reopen, pane-count changes, and window resize re-compute only the rendered
  width against the current pane floor. The agent rail gives up width first, then
  the sidebar, and neither rail shrinks below its own minimum.
- At the native 760px window floor, both rails at their minimums still cannot
  always leave a full 360px single-pane floor. In that impossible case the rails
  stay at their minimums and the pane degrades inside the available width rather
  than introducing canvas-level horizontal scroll.
- Pane resize handles sit between panes.
- Opening a pane appends it next to the current pane or at the end only when the
  resulting pane count can fit after rail re-clamping. The hard cap remains
  `MAX_PERSISTED_PANELS` (4). At the count cap, or when a root/file-preview split
  cannot fit at the current width, opening repurposes an existing workspace pane
  (rightmost first) rather than adding another pane. Agent-debug panes are added
  only when the resulting count fits; a too-narrow window reports the capacity
  failure and does not drop an existing workspace pane just to show debug chrome.
- Opening run details from an assistant reply opens an agent-debug pane keyed by
  that concrete `(conversationId, runId)`. If that same run pane already exists it
  is activated; a different reply/run is a different details target. The agent
  dock does not expose a standalone debug button; details are opened from a
  concrete assistant reply. The agent-debug pane uses the same sticky breadcrumb /
  close chrome as node and file panes so pane headers align across the workspace.
- Closing a pane removes it from the layout. If it was active, focus moves to the
  nearest remaining pane, and clears when that pane is an agent-debug pane (which
  carries no node to focus).

Avoid making every pane independent `position:absolute` — the product does not do
freeform window management.

## Responsive Constraints

Responsive behavior is conservative and local to the existing floating-rail /
padded-canvas model:

- The sidebar and agent dock width preferences are stateful and stay independent
  from responsive clamping. Window resize uses a requestAnimationFrame-coalesced
  reflow so resize ticks do not force redundant shell renders or ratchet a user's
  wider rail preference down permanently.
- The available pane width is computed from the canvas border-box width minus
  the open rails and their shell gaps, then compared with
  `paneCount × --outline-panel-min-width` plus inter-pane gaps.
- Deep outliner indentation is capped before it reaches CSS: outline rows,
  sidebar tree rows, and preview/backlink rows all clamp their visual depth to a shared
  `MAX_OUTLINE_INDENT_DEPTH` value. The underlying document depth and keyboard
  structure are unchanged.
- Tag bars wrap chips with row gaps. Plain-text row tags still live in the
  editor inline slot; non-plain rows and the page-title toolbar use the same wrap
  behavior to avoid horizontal spill.
- Breadcrumb segments stay in a single row, but middle/earlier segments carry
  tighter max-widths while the final current-context segment is allowed the
  largest share. This keeps narrow panes from reducing every segment to a bare
  ellipsis.

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

When the agent dock is reopened from its collapsed rail state, focus moves to the
agent composer editor when the normal composer is visible. If an approval or
user-question card is occupying the composer surface, the reopen token is
consumed without focus, and resolving that card must not reuse the old token to
steal focus. The dock stays mounted while collapsed, so this is a one-shot open
transition, not a remount side effect or a generic render-time focus steal.

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
  -> ensure the local-calendar date node exists for today
  -> active pane root changes to that date node (plain click), or
  -> a new pane opens on that date node (Alt/Option-click)
  -> sidebar remains mounted
  -> agent remains mounted
```

The in-app command palette uses the same ensure-first path for its Today item and
for "New node in Today"; it must not rely on a stale renderer `projection.todayId`
after a session crosses midnight.

Open node in a split pane:

```txt
User Cmd/Ctrl-clicks a reference, or picks "Open in split pane" from the
node context menu
  -> append a workspace panel with an outliner view to layout.panels (or, at the
     4-pane cap, replace the rightmost workspace pane's view)
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
