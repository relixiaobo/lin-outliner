---
status: done
priority: P1
owner: relixiaobo
created: 2026-06-03
updated: 2026-06-03
shipped: PR #85
---

# Workspace Shell: Remove Tabs, Keep Split Panes

> Incorporates the cc-proposed D5/D6/D7 revision, PM-ratified 2026-06-03:
> normalize `size` onto the panel (kill the parallel `panelSizes` map), make the
> pane the single canvas primitive (required renames), and **honestly record the
> dropped saved-layouts capability** (pins is NOT its successor). Plus the A6
> spec rewrite, the full four-spec e2e list, and the `openRootInPanel`
> correctness fix (the earlier draft misnamed it `openNodeInSecondaryView`,
> which does not exist).

## Goal

Remove the multi-**tab** concept entirely (no sidebar "Tabs" list, no multiple
tabs) while **keeping the multi-pane split view**. Panes are elevated from
"inside a tab" to a single top-level workspace layout, and are made the **one
canvas primitive**. Bundle two adjacent node-context-menu cleanups that touch
the same files, to avoid cross-PR collisions on `Sidebar.tsx` and
`NodeContextMenu.tsx`:

- **T1 — Remove tabs, keep split panes.** (PM decision #1)
- **T2 — Right-click "Open" → "Open in split pane".** Plain "Open" duplicates
  bullet-click; repoint it to open the node in a second pane. (PM decision #3)
- **T3 — Show all root nodes in the sidebar workspace tree.** Stop hiding
  Schema/Settings. (PM decision #4, sidebar part)
- **T4 — Remove the `Appearance` (icon/banner/appearance) item from the node
  context menu.** (PM decision #8)

The `isSystemId` core bug (missing `LIBRARY_ID`/`RECENTS_ID`, decision #4 bug
part) shipped separately (commit `0c8ea7b`) — out of scope here.

## Non-goals

- Keeping any tab affordance (no "merge tabs into one window list", no tab
  history). Tabs are gone.
- Redesigning the split-pane UX itself (resize, breadcrumbs, pane close stay as
  they are).
- Pinned-nodes work (decision #7) — separate plan `sidebar-pinned-nodes.md`,
  which **depends on this plan** (it builds on the post-refactor sidebar + the
  v2 layout shape). Pins are quick-access shortcuts for frequently-used nodes —
  **not** a replacement for tabs' saved layouts (see D7).
- Changing the agent debug panel behavior beyond the tab→layout reparenting.
- A recursive split-tree / freeform window model. A single horizontal row of
  tiled panes is the elegant minimum for the product's actual need
  (side-by-side reference); 2D grids and z-ordered windows stay rejected (spec
  "Tiled Layout").

## Why this shape (design rationale)

Tabs and panes were two different containers for "hold multiple roots". The
default layout never used multiple tabs meaningfully, and the agent view-context
is **already** pane-centric (`AgentUserViewContext` exposes `activePanelId` /
`focusedPanelId` / `nodePanels`, never a `tabId` — `src/core/agentTypes.ts:92`).
So the tab layer is an unused nesting level. Removing it is a *deletion*
refactor: the end state has strictly fewer concepts, and the whole
`updateActiveTab` "map over tabs, find the active one" wrapper (used by ~8
callbacks) disappears.

This revision additionally makes the destination model itself clean rather than
just "one level shallower":

- **D5** normalizes the data (size lives on the panel, one array, no parallel
  map to keep in sync).
- **D6** commits to a single uniform canvas primitive — consistent with the
  project's "everything is a node / one unifying concept" aesthetic — and
  renames everything so the code stops saying "tab" when it means "pane".
- **D7** records honestly that the one capability tabs uniquely provided
  (named/saved layouts) is being dropped — unused in practice — rather than
  pretending another feature replaces it.

## Design

### T1 — Tabs → single workspace layout

Today every pane lives in `WorkspaceTabState.panels[]`; the app holds `tabs[]` +
`activeTabId`. The refactor flattens this to a single layout.

#### D5 — Persisted shape: `size` on the panel, no `panelSizes` map

`workspaceLayoutTypes.ts` — put the tile ratio on each panel (both variants
tile, so it belongs on the shared base) and drop the separate `panelSizes`
record:

```ts
interface WorkspacePanelBase {
  id: string;
  size: number; // tile flex ratio; was WorkspaceTabState.panelSizes[id]
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

`WorkspaceTabState` is deleted. Per-pane back/forward history is already
panel-scoped and moves with each panel, untouched.

Net effect: one array is the whole truth. `closePanel` no longer maintains a
parallel `delete panelSizes[id]`; `WorkspaceCanvas` reads `panel.size ?? 1`
instead of `activeTab.panelSizes[panel.id]`; `useResizableLayout` maps over
`panels` and writes `.size` on the two resized panels. The size↔panel sync
class of bug is gone by construction.

**Persistence:** bump the localStorage key
`lin-outliner:workspace-layout:v1` → `:v2`, `version: 2`, and **drop v1 on
load** (pre-release, no prod data — memory `storage-format-no-backcompat-prerelease`).
`sanitizeTab` → `sanitizeLayout`: same per-panel validation as today, but read
`size` off each panel (clamp to a finite `> 0`, default `1`) instead of from a
`panelSizes` map. `MAX_PERSISTED_TABS` is deleted; `MAX_PERSISTED_PANELS` (4)
stays.

**Default layout (changed):** `defaultTabs` → `defaultLayout` seeds **a single
outliner pane on `initial.todayId`** (was two panes — today + library, at
`useWorkspaceTabs.ts:37-38`). The user opens split on demand (PM decision below).

#### D6 — Pane is the single canvas primitive; names tell the truth

After T1 the canvas has exactly one container concept: the pane. Commit to it
and make the identifiers stop lying about "tab". These renames are **required**,
not optional (a hook called `useWorkspaceTabs` that holds no tabs is a defect of
clarity):

- File + hook: `useWorkspaceTabs.ts` → `useWorkspaceLayout.ts`,
  `useWorkspaceTabs` → `useWorkspaceLayout`.
- `shared.ts`: `wantsNewTabFromClick` → `wantsNewPaneFromClick`.
- `NavigateRootOptions.newTab` → `newPane`, and every passthrough site
  (`App.tsx`, `NodePanel.tsx:635`, `OutlinerItem.tsx:1600`,
  `AgentInlineReferenceText.tsx`, `RichTextEditor.tsx:433`).
- `loadPersistedTabs`/`persistTabs` → `loadPersistedLayout`/`persistLayout`;
  `initializeTabs` → `initializeLayout`; `defaultTabs` → `defaultLayout`.

Keep the renames as a separate commit within the PR so the behavioral diff stays
reviewable. The agent-debug panel staying in `panels[]` is then a *feature of the
model* (everything in the canvas is a pane), not a union-type smell.

#### Hook state + exports (`useWorkspaceLayout.ts`)

- State: `tabs[]` + `activeTabId` → `panels[]` + `activePanelId`.
- **Delete** the tab-scoped exports: `tabs`, `activeTabId`, `activeTab`,
  `selectTab`, `createTab`, `closeTab` (+ the `updateActiveTab` internal
  wrapper — every callback now edits the single layout directly).
- **Keep / repoint** the pane-scoped exports, now operating on top-level state:
  `openPanel`, `closePanel`, `activatePanel`, `navigateRoot`,
  `navigatePanelRoot`, `navigatePanelBack/Forward`, `openAgentDebugPanel`.
- `resizePanelPair(tabId, …)` → drop the `tabId` param →
  `resizePanelPair(leftId, rightId, l, r)`, writing `.size` on each panel.

#### `App.tsx`

- Stop destructuring `activeTab`, `activeTabId`, `createTab`, `closeTab`,
  `selectTab`, `tabs`, `initializeTabs`.
- **`newPane` (ex-`newTab`) branch in BOTH `navigateRoot` and
  `navigatePanelRoot`** (App.tsx:193-211 today): repoint `createTab(nodeId)` →
  `openPanel(nodeId)`. **Behavior:** Cmd/Ctrl+click a reference opens the node in
  a **new split pane** appended to the current layout. When already at
  `MAX_PERSISTED_PANELS` (4), `openPanel` *replaces the rightmost pane's root*
  rather than opening a fifth (existing `openPanel` behavior,
  `useWorkspaceTabs.ts:350-359`) — previously Cmd-click always got its own fresh
  tab, so this is a deliberate, accepted behavior change.
- `agentUserViewContext` / `buildAgentUserViewContext`
  (`src/renderer/ui/agent/userViewContext.ts`): stop passing `activeTab`; pass
  `activePanelId` + `panels` directly (the builder already only reads
  `activeTab.panels` / `activeTab.activePanelId`).
- Delete the `sidebarTabs` transform and the Sidebar tab props.
- `WorkspaceCanvas`: pass `panels` / `activePanelId` instead of `activeTab`.

#### `WorkspaceCanvas.tsx`

Logic unchanged; data source flips from `props.activeTab?.X` to `props.X`, and
`props.activeTab?.panelSizes[panel.id] ?? 1` → `panel.size ?? 1`.

#### `useResizableLayout.ts`

Input `activeTab` → `panels`; drop `tab.id` from the `resizePanelPair` call;
read ratios from `panel.size` (was `tab.panelSizes[id]`).

#### `Sidebar.tsx`

Delete the entire "Tabs" section (header, "+", tab pills, close buttons) and the
`SidebarTab`/`SidebarTabSegment` types + tab props (`activeTabId`, `onCloseTab`,
`onCreateTab`, `onSelectTab`, `tabs`).

### T2 — "Open" → "Open in split pane"

In `NodeContextMenu.tsx`, the "Open" item fires `onRoot(props.openId)` —
identical to bullet-click (`RowLeading.tsx`, `onDrillDown` → `onRoot`). Repoint
it to open in a second pane via `openPanel(nodeId)`.

The existing app-level caller is **`openRootInPanel`** (`App.tsx:233`, exposed to
the sidebar as `onOpenPanel`, e.g. sidebar Alt+click `Sidebar.tsx:117/157/268`).
**Threading.** `NodeContextMenu` is rendered at **three** sites
(`NodePanel.tsx`, `OutlinerItem.tsx`, `OutlinerFieldRow.tsx`), each fed `onRoot`
down the chain App → WorkspaceCanvas → NodePanel → OutlinerItem/FieldRow → menu.
Two options, pick at build:

- **(a)** Thread a new `onOpenInSplit?: (id) => void` the same 4-deep path
  (explicit, mirrors `onRoot`).
- **(b, preferred)** Reuse the existing `onOpenPanel` wiring already used by the
  sidebar instead of inventing a parallel callback — fewer new props if it can
  be threaded to the panels cleanly.

Relabel the menu item to **"Open in split pane"**.

### T3 — Show all root nodes in the sidebar tree

`Sidebar.tsx:71` hides Schema + Settings via
`hiddenRootNodeIds = new Set([schemaId, settingsId])`. Remove that filter so the
tree shows all root sections. **Resolve at build (not "probably"):** the
indented blank row reported under Library — confirm whether it is that section's
trailing-draft editor (every expandable node has one) vs. a real hidden node. If
it is the draft editor, no action; if a real node leaks in, fix the child filter
(`sidebarChildren`). Do not ship T3 on an unverified guess.

### T4 — Remove the `Appearance` context-menu item

In `NodeContextMenu.tsx`, remove the `Appearance` `MenuItem`
(`setMode('appearance')`) and its submenu branch (`renderAppearanceMode`, the
`icon`/`banner` prompt modes, and the `mode`-union members
`'appearance' | 'icon' | 'banner'`). Note: this removes the only entry point for
setting a node's icon/banner — accepted per decision #8 (no relocation).

### D7 — Saved layouts go away (accepted); pins is NOT a successor

Removing tabs deletes the one capability panes cannot replicate: **named, saved,
switchable layouts** (the spec literally defines a tab as "a saved central
workspace layout"; >4 roots could be parked across tabs). In practice the app
never used multiple tabs meaningfully, so this is an **accepted deletion**, not a
deferral.

Do not pretend another feature replaces it: **pins (`sidebar-pinned-nodes.md`)
is NOT a successor.** Pinning parks individual frequently-used *nodes* in the
sidebar for persistent quick access — a different, smaller capability than saving
a multi-pane *layout*. If a real saved-layouts feature is ever wanted, it is
separate and out of scope here.

## Forward-compat: local-file preview seam (advisory)

A later feature (not in this plan, not started) previews a `local-file`
`ReferenceTarget` (`src/core/types.ts`) inside a pane: a plain click replaces the
current pane's view with the file preview and "back" returns to the node view;
Cmd/Ctrl+click opens the preview in a new split pane. It touches the same pane
files this refactor reshapes, so the PM asked us to keep the seam open. Decisions
(this refactor's contract with that future work):

- **[adopted — the load-bearing, irreversible one] `WorkspacePanelState` stays an
  extensible discriminated union.** The flatten keeps `OutlinePanelState |
  AgentDebugPanelState` over a shared `WorkspacePanelBase { id; size }`,
  discriminated by `type` (it was NOT collapsed to outliner-only). Adding preview
  is then localized: a `FilePreviewPanelState extends WorkspacePanelBase { type:
  'file-preview'; path: string; entryKind: 'file' | 'directory' }` member + one
  `WorkspaceCanvas` render branch + one `sanitizePanel` branch. Cmd/Ctrl+click →
  a new preview pane is fully accommodated by this shape today. This is the
  expensive, hard-to-reverse dependency, and it is satisfied.

- **[deferred, documented] per-pane history stays a root stack (`NodeId[]`), not a
  generalized `PaneView[]` view-state stack.** Preview-*in-current-pane* (plain
  click + back-to-node) is the only part that needs a non-node history entry. The
  target shape is:

  ```ts
  type PaneView =
    | { kind: 'outliner'; rootId: NodeId }
    | { kind: 'file-preview'; path: string; entryKind: 'file' | 'directory' }; // later
  ```

  Doing it *properly* means promoting a navigable pane's **current view** (not
  just its history) to `PaneView`, so the pane's content flips between outliner
  and preview as you go back/forward — a real scope/risk increase across
  `navigateOutlinerPanel`, `navigatePanelBack/Forward`, `sanitizePanel`,
  `NodePanel` breadcrumb, and `useWorkspaceKeyboard`. The half-measure (typing the
  arrays as a union without moving the current view) buys the feature nothing.
  Per the PM's latitude, deferred to keep this refactor healthy and fully tested.
  No persistence cost to deferring — pre-launch, the `:v2` shape can be cut over
  again freely when preview lands.

- **[deferred, nice-to-have] generic "open in current pane / open in split pane"
  over view kind.** Today's entry points (`navigatePanelRoot`, `openPanel`) are
  `NodeId`-typed; preview will add view-typed siblings on the same union. Noted,
  not built — designing it blind (without the preview consumer) risks the wrong
  shape.

Net: the irreversible dependency (extensible pane union) is in place; the
cheap-to-add-later parts (history generalization, generic open) are documented
seams, not silent gaps.

## Spec sync (A6 — same change)

`docs/spec/workspace-layout.md` is built on the tab model and **must be
rewritten in this PR**. Concretely:

- Remove / rewrite the tab-centric sections: "Tab Semantics", "Switch tab"
  interaction, the `interface WorkspaceTab`, and `AppShellState { activeTabId,
  tabs[] }` / `ShellFocusState.activeTabId`.
- Recenter the Core Model on a single workspace layout owning the canvas; "Tab
  content is the central workspace canvas" → "the workspace layout is the
  central canvas".
- Keep and lightly update the still-true sections: Panel Semantics, Tiled
  Layout, Sidebar/Agent/Overlay boundaries, Focus Model (drop `activeTabId`),
  Visual Layering. Record the D5 `size`-on-panel shape, the D6 "pane is the
  single canvas primitive" rule, and the default single-pane (today) layout.

## Decisions (PM-ratified 2026-06-03)

- **Cmd/Ctrl+click a reference → open in a new split pane** (`openPanel`); at the
  4-pane cap it replaces the rightmost pane root (documented above).
- **Default layout = a single pane on `today`** (was today + library). The user
  opens split on demand.
- **No visible "split" affordance.** Split is reachable only via Cmd/Ctrl+click a
  reference, sidebar Alt+click, and right-click "Open in split pane" — accepted
  as the entry points (no canvas split button).
- **T3 duplication accepted for now:** showing Schema/Settings in the tree
  duplicates the top-nav Schema + footer Settings button — fine for now.
- **D5/D6/D7 adopted:** normalize `size` onto the panel; make the pane the single
  named primitive (required renames); drop saved layouts honestly (pins is not
  its successor).
- **Pane cap:** keep `MAX_PERSISTED_PANELS` (4).

## Open questions

- None blocking. Implementation-level only: T2 wiring (a) vs (b); the Library
  blank-row runtime check (T3).

## Files (scope)

- `src/renderer/ui/useWorkspaceTabs.ts` → renamed `useWorkspaceLayout.ts`
- `src/renderer/ui/workspaceLayoutTypes.ts` (D5 shape)
- `src/renderer/ui/App.tsx`
- `src/renderer/ui/WorkspaceCanvas.tsx`
- `src/renderer/ui/useResizableLayout.ts`
- `src/renderer/ui/Sidebar.tsx`
- `src/renderer/ui/outliner/NodeContextMenu.tsx`
- `src/renderer/ui/shared.ts` (`wantsNewPaneFromClick`, `newPane`)
- `src/renderer/ui/agent/userViewContext.ts` (view-context builder)
- passthrough rename sites: `NodePanel.tsx`, `OutlinerItem.tsx`,
  `OutlinerFieldRow.tsx`, `AgentInlineReferenceText.tsx`, `RichTextEditor.tsx`
- **`docs/spec/workspace-layout.md`** (A6 rewrite)
- e2e (see Checklist)

No `src/core/*` protocol surface (verified: `AgentUserViewContext` is already
pane-centric; nothing in `src/core`/`src/main` references tabs).

## Checklist

- [x] `workspaceLayoutTypes.ts`: D5 shape — `size` on `WorkspacePanelBase`,
      delete `WorkspaceTabState` + `panelSizes`.
- [x] Rename hook/file → `useWorkspaceLayout`; flatten state to `panels[]` +
      `activePanelId`; v2 persist + drop v1; `sanitizeLayout` reads `panel.size`.
- [x] `defaultLayout` seeds a **single** pane on `today` (not today + library).
- [x] Remove tab-scoped exports + `updateActiveTab`; keep/repoint pane-scoped
      ones; `resizePanelPair` drops `tabId`, writes `.size`.
- [x] D6 renames: `wantsNewPaneFromClick`, `NavigateRootOptions.newPane`, all
      passthrough sites (`NodePanel`, `OutlinerItem`, `AgentInlineReferenceText`,
      `RichTextEditor`); delete `MAX_PERSISTED_TABS`.
- [x] `App.tsx`: remove tab destructuring; repoint `newPane` branch in
      `navigateRoot` AND `navigatePanelRoot` to `openPanel`; fix
      `agentUserViewContext`; pass `panels`/`activePanelId` to `WorkspaceCanvas`.
- [x] `WorkspaceCanvas.tsx` / `useResizableLayout.ts`: read `panel.size`.
- [x] `Sidebar.tsx`: delete Tabs section + types/props; remove `hiddenRootNodeIds`
      (T3). Library blank-row: verified at runtime — it is the section's
      trailing-draft editor, no real hidden node, no action needed. Dead
      `.sidebar-tab*` CSS removed from `sidebar.css`.
- [x] `NodeContextMenu.tsx`: "Open" → "Open in split pane" via the existing
      `onRoot(id, { newPane: true })` plumbing — chose wiring (b)-style reuse
      (no new prop drilled); remove `Appearance` item + submenu + `icon`/`banner`
      `mode` members (T4).
- [x] **Spec:** rewrite `docs/spec/workspace-layout.md` (A6).
- [x] **E2E (all tab-coupled specs):**
      - `workspace-layout.spec.ts` — split/single-pane tests reworked to open a
        pane via Cmd+M; tab-switcher test rewritten as pane persistence + close;
        default-layout expectation now single pane; T3 root-outline flipped to
        expect Schema/Settings shown.
      - `outliner-navigation-title.spec.ts` — debug-pane test rewritten in pane
        terms; "New tab" removed.
      - `agent-composer.spec.ts` / `outliner-selection-keyboard.spec.ts` —
        inline-ref tests rewritten (plain click = same pane, Cmd+click = new pane).
      - `native-dialogs.spec.ts` — removed the Set-icon test (feature deleted by
        T4); `outliner-triggers.spec.ts` — narrow-viewport test no longer closes a
        2nd pane (default is single now).
- [x] Verify split open / close / resize / per-pane back-forward still work
      (e2e + renderer).
- [x] `bun run typecheck` (clean) + `test:renderer` (268/0).
- [ ] Light + dark visual gate (UI change) — for the main-agent gate.

## Status notes (for the gate)

- **Pre-existing failures, NOT from this change** (verified identical on
  `origin/main` by stashing): `test:core` has 2 failing `file_glob`/`file_grep`
  agent-tool tests; the e2e suite has several pre-existing failures unrelated to
  panes — day-title humanization (`2026-05-13` → `Wed, May 13`, date-environment
  dependent), panel-resize cursor reading `auto` in headless, a sidebar
  alignment metric, and a `e2eNodeInlineRef is not defined` fixture error in
  `outliner-selection-keyboard`. This change adds **zero** new failures and
  fixes one (the debug-pane page-history test).
- **Net diff ≈ −990 lines** — a deletion refactor (one `WorkspaceLayout` replaces
  `tabs[] + activeTabId + activeTab`; `updateActiveTab` and the parallel
  `panelSizes` map are gone).
