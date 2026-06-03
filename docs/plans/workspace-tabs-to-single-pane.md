---
status: draft
priority: P1
owner: relixiaobo
created: 2026-06-03
updated: 2026-06-03
---

# Workspace Shell: Remove Tabs, Keep Split Panes

## Goal

Remove the multi-**tab** concept entirely (no sidebar "Tabs" list, no multiple
tabs) while **keeping the multi-pane split view**. Panes are elevated from
"inside a tab" to a single top-level workspace layout. Bundle two adjacent
node-context-menu cleanups that touch the same files, to avoid cross-PR
collisions on `Sidebar.tsx` and `NodeContextMenu.tsx`:

- **T1 — Remove tabs, keep split panes.** (PM decision #1)
- **T2 — Right-click "Open" → "Open in split pane".** Plain "Open" duplicates
  bullet-click; repoint it to open the node in a second pane. (PM decision #3)
- **T3 — Show all root nodes in the sidebar workspace tree.** Stop hiding
  Schema/Settings. (PM decision #4, sidebar part)
- **T4 — Remove the `Appearance` (icon/banner/appearance) item from the node
  context menu.** (PM decision #8)

The `isSystemId` core bug (missing `LIBRARY_ID`/`RECENTS_ID`, decision #4 bug
part) is a **separate fast-track** (different file/concern) — see `docs/TASKS.md`.

## Non-goals

- Keeping any tab affordance (no "merge tabs into one window list", no tab
  history). Tabs are gone.
- Redesigning the split-pane UX itself (resize, breadcrumbs, pane close stay as
  they are).
- Pinned-nodes work (decision #7) — separate plan
  `sidebar-pinned-nodes.md`, which **depends on this plan** (it builds on the
  post-refactor sidebar + the v2 layout shape).
- Changing the agent debug panel behavior beyond the tab→layout reparenting.

## Design

### T1 — Tabs → single workspace layout

Today every pane lives in `WorkspaceTabState.panels[]`; the app holds
`tabs[]` + `activeTabId`. The refactor flattens this to a single layout.

**Persisted shape (`workspaceLayoutTypes.ts` + `useWorkspaceTabs.ts` storage):**
bump the localStorage key `lin-outliner:workspace-layout:v1` → `:v2` and drop the
old data on load (pre-release, no prod data — see memory
`storage-format-no-backcompat-prerelease`). New shape:

```ts
interface WorkspaceLayout {
  activePanelId: string;
  panelSizes: Record<string, number>;
  panels: WorkspacePanelState[]; // OutlinePanelState | AgentDebugPanelState
}
```

Per-pane back/forward history (`pageBackStack`/`pageForwardStack`) is already
panel-scoped — it moves with each panel, untouched.

**`useWorkspaceTabs.ts` (rename optional, e.g. `useWorkspaceLayout`):**
- State: `tabs[]` + `activeTabId` → `panels[]` + `activePanelId` + `panelSizes`.
- **Delete** the tab-scoped exports: `initializeTabs`→`initializeLayout`,
  `tabs`, `activeTabId`, `activeTab`, `selectTab`, `createTab`, `closeTab`.
- **Keep** the pane-scoped exports, now operating on top-level state:
  `openPanel`, `closePanel`, `activatePanel`, `navigateRoot`,
  `navigatePanelRoot`, `navigatePanelBack/Forward`, `openAgentDebugPanel`.
- `resizePanelPair(tabId, …)` → drop the `tabId` param → `resizePanelPair(leftId,
  rightId, l, r)`.
- `loadPersistedTabs`/`persistTabs` → `loadPersistedLayout`/`persistLayout`.

**`App.tsx`:**
- Stop destructuring `activeTab`, `activeTabId`, `createTab`, `closeTab`,
  `selectTab`, `tabs`, `initializeTabs`.
- `navigateRoot`/`navigatePanelRoot` wrappers: the `newTab` branch currently
  calls `createTab(nodeId)`. **Decision needed (see open questions):** repoint to
  `openPanel(nodeId)` (Cmd/Ctrl+click → split into a new pane) OR drop the
  `newTab` branch (Cmd-click → in-place). Recommended: `openPanel` so Cmd-click
  keeps a "open elsewhere" meaning, now as a pane.
- `agentUserViewContext` / `buildAgentUserViewContext`: stop passing `activeTab`;
  pass `activePanelId` + `panels` directly.
- Delete the `sidebarTabs` transform and the Sidebar tab props.
- `WorkspaceCanvas`: pass `panels` / `activePanelId` / `panelSizes` instead of
  `activeTab`.

**`WorkspaceCanvas.tsx`:** logic is unchanged; only the data source flips from
`props.activeTab?.X` to `props.X`.

**`useResizableLayout.ts`:** input `activeTab` → `panels` + `panelSizes`; drop
`tab.id` from the `resizePanelPair` call.

**`Sidebar.tsx`:** delete the entire "Tabs" section (header, "+", tab pills,
close buttons) and the `SidebarTab`/`SidebarTabSegment` types + tab props.

**`newTab` call sites:** two direct sites in `App.tsx` (`navigateRoot` /
`navigatePanelRoot`) call `createTab`. The rest are passthroughs
(`OutlinerItem`, `RichTextEditor`, `NodePanel`, agent inline-ref,
`shared.ts:wantsNewTabFromClick`) that propagate `newTab` up — they keep working
once the two central wrappers are repointed. Consider renaming
`wantsNewTabFromClick` → `wantsNewPaneFromClick` for clarity.

### T2 — "Open" → "Open in split pane"

In `NodeContextMenu.tsx`, the "Open" item fires `onRoot(openId)` — identical to
bullet-click (`RowLeading.tsx`, `onDrillDown` → `onRoot`). Repoint the menu item
to open in a second pane via `openPanel(nodeId)` (already exists; `App.tsx`'s
`openNodeInSecondaryView` is the existing caller). Relabel to "Open in split
pane" (or "Open to the side"). Thread an `onOpenInSplit?: (id) => void` callback
into `NodeContextMenu` from `App.tsx` (cleaner than overloading `onRoot`).

### T3 — Show all root nodes in the sidebar tree

`Sidebar.tsx` hides Schema + Settings from the workspace tree via
`hiddenRootNodeIds = new Set([schemaId, settingsId])`. Remove that filter so the
tree shows all six sections (Daily notes, Library, Schema, Saved searches, Trash,
Settings). The center root outline already shows all six; the indented blank row
seen under Library is almost certainly that section's **trailing-draft editor**
(every expandable node has one), not a hidden node — confirm at runtime; if so,
no action.

### T4 — Remove the `Appearance` context-menu item

In `NodeContextMenu.tsx`, the `Appearance` item opens a submenu
(`setMode('appearance')`) for icon/banner/appearance. Remove the item and its
submenu branch. Note: this removes the only entry point for setting a node's
icon/banner — accepted per decision #8 (no relocation).

## Open questions

1. **`newTab` semantics after tabs:** Cmd/Ctrl+click a reference → open in a new
   split pane (`openPanel`), or open in-place (drop `newTab`)? (Recommend: new
   pane.)
2. **T3 duplication:** showing Schema in the tree duplicates the top-nav Schema;
   showing Settings duplicates the footer Settings button. Accept the
   duplication for now (decision #4 = "show all"), or de-dup nav/footer later?
3. **Split-pane entry discoverability:** with the "+ new tab" button gone, is
   there a "split pane" affordance in the canvas, or is split only reachable via
   the context menu + Cmd-click? (Out of scope to add a button unless wanted.)
4. **Pane cap:** persisted layout currently caps at `MAX_PERSISTED_PANELS` (4) —
   keep as-is.

## Files (scope)

`src/renderer/ui/useWorkspaceTabs.ts`, `App.tsx`, `WorkspaceCanvas.tsx`,
`useResizableLayout.ts`, `Sidebar.tsx`, `workspaceLayoutTypes.ts`,
`outliner/NodeContextMenu.tsx`, `shared.ts` (helper rename), agent
view-context builder. No `src/core/*` protocol surface.

## Checklist

- [ ] Flatten `useWorkspaceTabs` state + persisted v2 shape; drop v1 on load.
- [ ] Remove tab-scoped exports; keep/repoint pane-scoped ones.
- [ ] `resizePanelPair` drop `tabId`; update `useResizableLayout`.
- [ ] `App.tsx`: remove tab destructuring, repoint `newTab`, fix
      `agentUserViewContext`, pass panels to `WorkspaceCanvas`.
- [ ] `Sidebar.tsx`: delete Tabs section + types/props; remove `hiddenRootNodeIds`
      (T3).
- [ ] `NodeContextMenu.tsx`: "Open" → "Open in split pane" (T2); remove
      `Appearance` (T4).
- [ ] Verify split open / close / resize / per-pane back-forward still work.
- [ ] `bun run typecheck` + `test:renderer` + relevant e2e (workspace-layout).
- [ ] Light + dark visual gate (UI change).
