---
status: done
priority: P2
owner: relixiaobo
created: 2026-06-03
updated: 2026-06-11
---

# Sidebar Pinned Nodes

## Goal

Implement the currently-stubbed sidebar "Pinned" section (PM decision #7). Pin a
node so it appears in the sidebar Pinned list; pinning is reachable from the
right-click context menu on **both** outliner node rows **and** sidebar node
rows; pins persist across restarts. The "Drag to pin nodes" empty state today
does nothing (`pinnedNodeIds` is hardcoded `[]`, the drop target has no handlers,
there is no data model or command).

> **Dependency:** this plan builds on
> `workspace-tabs-to-single-pane.md` (Plan A). Pins are stored in the renderer
> workspace-layout state, which Plan A rewrites to the current single-layout shape,
> and the Pinned UI lives next to the sidebar tree / context menu that Plan A
> also edits. **Sequence Pin after Plan A merges** and rebase, to avoid
> collisions on `Sidebar.tsx` + `NodeContextMenu.tsx` + `useWorkspaceTabs`.

## Non-goals

- Putting pins in the core document. Pins are per-workspace UI chrome, like the
  pane layout — they do **not** belong in the event-sourced document. (See Design
  + Open questions.)
- Cross-window pin sync (each window shows its own pins for now).
- Pinned-node reordering / nesting beyond reusing the existing tree row render.

## Design

### Storage — renderer layout state (recommended)

Mirror how the workspace layout persists (the `useWorkspaceTabs` /
post-Plan-A `useWorkspaceLayout` localStorage pattern). Add a `pinnedNodeIds:
NodeId[]` either to the v3 layout object or a sibling key
(`lin-outliner:workspace-layout:v3:pinned`). On load, **validate against the live
projection** and drop ids that no longer exist (same sanitization as panes).

Rationale: pins are transient per-workspace UI state, exactly like tabs/pane
layout and page history, which already live in renderer localStorage to stay out
of the document. Putting a `pinned` flag in `core/types.ts` + a `toggle_pin`
command would drag this into the protocol surface, event log, undo stack, and
cross-window sync for no benefit. **PM-ratified: store pins in renderer layout
state (not the core document).** No `src/core/*` change.

### State hook

New `useWorkspacePinnedNodes()` (or fold into the layout hook): `{ pinnedNodeIds,
pinNode, unpinNode, togglePin }`, persisted on change, loaded + validated on
init. Wire at the App root and pass `pinnedNodeIds` + `onTogglePin` down.

### Sidebar rendering

The Pinned section already calls the same `renderWorkspaceTree(nodeId)` used for
the root tree — only the data source is the hardcoded `[]`. Replace it with the
prop. Empty state copy: if drag-to-pin is not shipped in v1, change "Drag to pin
nodes" → "Right-click a node to pin it".

### Context-menu integration

- **Outliner rows:** add a "Pin"/"Unpin" item to `NodeContextMenu.tsx` that
  calls `onTogglePin(targetId)` (a renderer callback, **not** an `api.run`
  command, since pins aren't core state). Label toggles on current pinned status.
- **Sidebar rows:** the sidebar tree rows currently have no `onContextMenu`. Add
  a right-click handler that opens the same `NodeContextMenu` at the cursor with
  the sidebar node as target + the `onTogglePin` callback. Decide whether the
  sidebar menu shows the full node menu or a reduced one (Pin/Open/…); a reduced
  menu may be cleaner for the sidebar.

### Drag-to-pin (optional v1)

The drag source already sets `OUTLINER_NODE_DRAG_MIME`
(`useOutlinerRowInteraction`). To honor the original "Drag to pin nodes"
affordance, add `onDragOver` (preventDefault + `dropEffect`) + `onDrop` (read the
MIME, `pinNode(id)`) to the Pinned section. Trade-off: drag-to-pin is
discoverable but adds ambiguity (add vs reorder) and risks confusion with the
outliner's move-drag. Recommend shipping **context-menu pin first**; add
drag-to-pin only if wanted (see open questions).

## Decisions (PM-ratified 2026-06-03)

- **Storage:** renderer layout state (not the core document). No protocol-surface
  change.

## Shipped implementation (2026-06-11)

Pins ship as renderer-local workspace chrome under
`lin-outliner:workspace-layout:v3:pinned`. The pinned id list is hydrated from
localStorage, sanitized against the live projection, deduped, and persisted after
hydration so restore cannot overwrite stored pins with the initial empty state.

Users can toggle pins from:

- the outliner row context menu (`Pin` / `Unpin`);
- the sidebar tree row context menu, using a reduced menu (`Open`, `Open in split
  pane`, `Pin` / `Unpin`).

The pinned section renders the same workspace tree rows as the root outline,
preserving insertion order. Stale ids are dropped on restore. Drag-to-pin and
manual reordering remain intentionally unshipped.

## Resolved questions

1. **Sidebar context menu scope:** reduced menu (`Open`, `Open in split pane`,
   `Pin` / `Unpin`).
2. **Drag-to-pin:** not shipped; empty state points to the context-menu path.
3. **Pin ordering:** insertion order only.

## Files (scope)

`src/renderer/ui/useWorkspacePinnedNodes.ts` (new) or the post-Plan-A layout
hook; `Sidebar.tsx` (pinned list data + sidebar right-click); `App.tsx` (wire
state + callback); `outliner/NodeContextMenu.tsx` (Pin/Unpin item). No
`src/core/*` change under the recommended (renderer-state) design.

## Checklist

- [x] Rebase on merged Plan A (v2 layout shape, post-refactor sidebar/menu).
- [x] `useWorkspacePinnedNodes` hook + persistence + load-time validation.
- [x] Sidebar Pinned list from real state; empty-state copy.
- [x] `NodeContextMenu` Pin/Unpin item (outliner rows).
- [x] Sidebar row right-click → context menu with Pin/Unpin.
- [x] Drag-to-pin explicitly left unshipped; empty state points to context menu.
- [x] Persist across restart; dead-id sanitization verified.
- [x] `bun run typecheck`, `bun run test:renderer`, and
      `bun run test:e2e -- tests/e2e/workspace-layout.spec.ts`.
