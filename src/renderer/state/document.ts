import { useCallback, useRef, useState } from 'react';
import type {
  DocumentProjection,
  FocusPlacement,
  FocusSurface as CoreFocusSurface,
  InlineRefCursorBias as CoreInlineRefCursorBias,
  NodeId,
  NodeProjection,
  ProjectionSnapshot,
  ProjectionUpdate,
} from '../api/types';
import {
  buildReverseEdges,
  nextRevisions,
  patchReverseEdges,
  propagateDirty,
  type ReverseEdges,
} from './renderRev';
import { measureRenderIndex } from '../ui/outliner/renderProbe';
import {
  resolveSelectableReferenceTargetId,
  selectableChildParentId,
} from './selectableRows';
import {
  buildOutlinerRows,
  readViewConfig,
  visibleAuthoredTableFieldIds,
  type OutlinerRowItem,
} from './outlinerRows';

export interface DocumentIndex {
  projection: DocumentProjection;
  byId: Map<NodeId, NodeProjection>;
  // Per-node data revision, used by OutlinerItem's React.memo to skip rows whose
  // data did not change. Optional because `buildIndex` (tests, non-outliner
  // callers) does not track it; the live app always supplies it through the
  // projection store. UI state (focus/selection/…) is compared per-row in the
  // memo from the `ui` prop, not carried here.
  renderRev?: ReadonlyMap<NodeId, number>;
}

export type FocusSurface = CoreFocusSurface;
export type CursorPlacement = FocusPlacement;
export type InlineRefCursorBias = CoreInlineRefCursorBias;
export type SelectionSource = 'global' | 'ref-click';

export function buildIndex(projection: DocumentProjection): DocumentIndex {
  return {
    projection,
    byId: new Map(projection.nodes.map((node) => [node.id, node])),
  };
}

// --- Projection store -------------------------------------------------------
// The renderer holds its index and folds `ProjectionUpdate`s into it, instead of
// rebuilding from a fresh full projection each edit. A `delta` carries only the
// changed/removed nodes, so the renderer never re-`JSON.stringify`s the whole
// document to rediscover the change set (core already told us). Unchanged node
// OBJECTS keep their reference across edits — the stable-identity foundation the
// P3 memo cleanups build on. See docs/plans/incremental-projection.md.

interface ProjectionState {
  index: DocumentIndex & { renderRev: Map<NodeId, number> };
  revision: number;
  // The reverse-edge index, carried across edits and patched per delta. Internal
  // to the store (not exposed on DocumentIndex); a new state owns a freshly
  // copy-on-write-patched one, so `prev`'s is never mutated.
  reverseEdges: ReverseEdges;
}

// Fold a ProjectionUpdate into the previous state. Returns the next state, the
// unchanged `prev` (already-applied duplicate / identical reseed), or `null` to
// signal the caller must resync (a delta with no base, or a revision gap).
export function reduceProjection(
  prev: ProjectionState | null,
  update: ProjectionUpdate,
): ProjectionState | null {
  if (update.kind === 'full') {
    // A reseed at a revision we already hold (or older) is an identical no-op —
    // refresh snapshots can return the current snapshot without mutating. Return
    // `prev` so we don't bump every node's renderRev and force a full-tree memo
    // invalidation for a pure refresh. (Core bumps the revision on every change,
    // so equal revision ⇒ identical content.)
    if (prev && update.revision <= prev.revision) return prev;
    const byId = new Map(update.projection.nodes.map((node) => [node.id, node]));
    const affected = new Set<NodeId>(byId.keys());
    const renderRev = nextRevisions(prev?.index.renderRev ?? null, affected, byId.keys());
    return {
      index: { projection: update.projection, byId, renderRev },
      revision: update.revision,
      reverseEdges: buildReverseEdges(byId),
    };
  }
  if (!prev) return null;
  if (update.revision <= prev.revision) return prev; // dual-channel duplicate — already applied
  if (update.revision !== prev.revision + 1) return null; // gap — resync

  const byId = new Map(prev.index.byId);
  const changed = new Set<NodeId>();
  // Delete EXACTLY the removed ids — no stale-subtree walk. Core enumerates every
  // genuinely-removed node in the change set (`loro.deleteNode` touches the whole
  // subtree, asserted by `verifyCaches`), so `removedIds` is complete. Walking the
  // *previous* tree to prune descendants would wrongly drop a child that a single
  // revision moved OUT of the removed node before deleting it (e.g.
  // `merge_node_into` re-parents grandchildren, then removes the emptied node):
  // those survivors arrive in `changedNodes`, not `removedIds`.
  for (const id of update.removedIds) {
    byId.delete(id);
    changed.add(id);
  }
  for (const node of update.changedNodes) {
    byId.set(node.id, node);
    changed.add(node.id);
  }
  // `nodes` follows Map insertion order (newly-created nodes append at the end),
  // whereas a full projection from core is id-sorted. `projection.nodes` order is
  // NOT a stable contract — the tree is defined by each node's `children`, and
  // display lists that iterate it sort/filter for themselves.
  const projection: DocumentProjection = { ...prev.index.projection, todayId: update.todayId, nodes: [...byId.values()] };
  const reverseEdges = patchReverseEdges(prev.reverseEdges, prev.index.byId, update.changedNodes, update.removedIds);
  const affected = propagateDirty(changed, byId, reverseEdges);
  const renderRev = nextRevisions(prev.index.renderRev, affected, byId.keys());
  return { index: { projection, byId, renderRev }, revision: update.revision, reverseEdges };
}

// Find a node by id within a ProjectionUpdate: the changed set for a `delta`, the
// full node list for a `full`. Interaction handlers use this to read the
// just-created/edited node straight out of a command result (a freshly created or
// mutated node is always present in its own delta's changed set).
export function nodeFromProjectionUpdate(
  update: ProjectionUpdate,
  id: NodeId | undefined,
): NodeProjection | undefined {
  if (!id) return undefined;
  return update.kind === 'full'
    ? update.projection.nodes.find((node) => node.id === id)
    : update.changedNodes.find((node) => node.id === id);
}

export interface ProjectionStore {
  index: DocumentIndex | null;
  applyProjectionUpdate: (update: ProjectionUpdate) => void;
}

// Holds the projection-derived index across edits and folds in ProjectionUpdates.
// If a delta can't apply (no base or a revision gap), it pulls a full snapshot via
// `resync` and reseeds — the safety valve; in steady state (one ordered channel,
// init seeds full) it never fires.
//
// `stateRef` mirrors `state` and is the authoritative `prev` for the reducer, so
// the reduce stays a pure function call OUTSIDE the setState updater (no resync
// side effect inside an updater that StrictMode double-invokes) and back-to-back
// applies in one tick chain correctly before React commits. A single in-flight
// guard collapses duplicate resync requests.
export function useProjectionStore(resync: () => Promise<ProjectionSnapshot>): ProjectionStore {
  const [state, setState] = useState<ProjectionState | null>(null);
  const stateRef = useRef<ProjectionState | null>(null);
  const resyncInFlight = useRef(false);

  const commit = useCallback((next: ProjectionState | null) => {
    if (next !== null && next !== stateRef.current) {
      stateRef.current = next;
      setState(next);
    }
  }, []);

  const applyProjectionUpdate = useCallback((update: ProjectionUpdate) => {
    const next = measureRenderIndex(() => reduceProjection(stateRef.current, update));
    if (next !== null) {
      commit(next);
      return;
    }
    if (resyncInFlight.current) return;
    resyncInFlight.current = true;
    void resync()
      .then((snapshot) => commit(reduceProjection(
        stateRef.current,
        { kind: 'full', revision: snapshot.revision, projection: snapshot.projection },
      )))
      .finally(() => { resyncInFlight.current = false; });
  }, [commit, resync]);

  return { index: state?.index ?? null, applyProjectionUpdate };
}

export interface UiState {
  focusedId: NodeId | null;
  focusedParentId: NodeId | null;
  focusedPanelId: string | null;
  focusSurface: FocusSurface | null;
  selectedId: NodeId | null;
  selectedIds: Set<NodeId>;
  selectionAnchorId: NodeId | null;
  selectionRootId: NodeId | null;
  selectionSource: SelectionSource | null;
  focusRequest: FocusRequest | null;
  pendingInputChar: PendingInputChar | null;
  pendingReferenceConversion: PendingReferenceConversion | null;
  pendingReferenceTypeAhead: PendingReferenceTypeAhead | null;
  trailingDraftPlacement: TrailingDraftPlacement | null;
  expanded: Set<NodeId>;
  expandedHiddenFields: Set<string>;
  editingDescriptionId: NodeId | null;
  commandOpen: boolean;
  batchTagSelectorOpen: boolean;
  toolbarDropdownRequest: ToolbarDropdownRequest | null;
}

export interface FocusTarget {
  nodeId: NodeId;
  parentId: NodeId | null;
  panelId: string | null;
  surface: FocusSurface;
}

export interface FocusRequest {
  target: FocusTarget;
  placement: CursorPlacement;
}

export interface PendingInputChar {
  target: FocusTarget;
  char: string;
}

export interface PendingReferenceConversion {
  nodeId: NodeId;
  parentId: NodeId;
  targetId: NodeId;
}

export interface PendingReferenceTypeAhead {
  nodeId: NodeId;
  parentId: NodeId;
  targetId: NodeId;
}

export interface TrailingDraftPlacement {
  parentId: NodeId;
  afterId: NodeId | null;
  panelId: string | null;
}

export type ToolbarDropdownSection = 'sort' | 'filter' | 'group' | 'display';

export interface ToolbarDropdownRequest {
  nodeId: NodeId;
  section: ToolbarDropdownSection;
  nonce: number;
}

export function useUiState() {
  return useState<UiState>({
    focusedId: null,
    focusedParentId: null,
    focusedPanelId: null,
    focusSurface: null,
    selectedId: null,
    selectedIds: new Set<NodeId>(),
    selectionAnchorId: null,
    selectionRootId: null,
    selectionSource: null,
    focusRequest: null,
    pendingInputChar: null,
    pendingReferenceConversion: null,
    pendingReferenceTypeAhead: null,
    trailingDraftPlacement: null,
    expanded: new Set<NodeId>(),
    expandedHiddenFields: new Set<string>(),
    editingDescriptionId: null,
    commandOpen: false,
    batchTagSelectorOpen: false,
    toolbarDropdownRequest: null,
  });
}

export function isRowExpanded(
  nodeId: NodeId,
  _byId: Map<NodeId, NodeProjection>,
  expanded: Set<NodeId>,
): boolean {
  return expanded.has(nodeId);
}

export function flattenVisibleRows(
  rootId: NodeId,
  byId: Map<NodeId, NodeProjection>,
  expanded: Set<NodeId>,
  expandedHiddenFields: Set<string> = new Set(),
): NodeId[] {
  const result: NodeId[] = [];
  const visit = (
    parentId: NodeId,
    referencePath: NodeId[],
    suppressedFieldDefIds?: ReadonlySet<string>,
  ) => {
    const parent = byId.get(parentId);
    if (!parent) return;
    const view = readViewConfig(parent, byId);
    const tableFieldDefIds = view.viewMode === 'table'
      ? visibleAuthoredTableFieldIds(view)
      : undefined;
    const rows = buildOutlinerRows(parent, byId, {
      expandedHiddenFields,
      suppressedFieldDefIds,
    });
    const visitRows = (currentRows: OutlinerRowItem[]) => {
      for (const row of currentRows) {
        if (row.type === 'filteredOut') {
          if (expanded.has(row.id)) visitRows(row.rows);
          continue;
        }
        if (row.type !== 'field' && row.type !== 'content') continue;
        result.push(row.id);
        if (!isRowExpanded(row.id, byId, expanded)) continue;
        const childParentId = outlinerChildParentId(row.id, byId);
        if (!childParentId || referencePath.includes(childParentId)) continue;
        visit(
          childParentId,
          [...referencePath, childParentId],
          row.type === 'content' ? tableFieldDefIds : undefined,
        );
      }
    }
    visitRows(rows);
  };
  visit(rootId, [rootId]);
  return result;
}

export function outlinerChildParentId(
  rowId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): NodeId | null {
  return selectableChildParentId(rowId, byId);
}

export function resolveReferenceTargetId(
  targetId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): NodeId | null {
  return resolveSelectableReferenceTargetId(targetId, byId);
}
