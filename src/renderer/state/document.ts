import { useCallback, useState } from 'react';
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
import { nextRevisions, propagateDirty } from './renderRev';
import { measureRenderIndex } from '../ui/outliner/renderProbe';
import {
  resolveSelectableReferenceTargetId,
  selectableChildParentId,
} from './selectableRows';
import { buildOutlinerRows } from './outlinerRows';

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
}

// Collect a node and all its descendants from a byId snapshot. A delta removal
// carries the subtree root; descendants are derived here (mirroring the
// main-process text-search consumer) so the renderer prunes the whole subtree
// regardless of whether core enumerated descendants in the change set.
function collectSubtreeIds(byId: ReadonlyMap<NodeId, NodeProjection>, rootId: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const stack: NodeId[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    out.push(id);
    const node = byId.get(id);
    if (node) for (const childId of node.children) stack.push(childId);
  }
  return out;
}

// Fold a ProjectionUpdate into the previous state. Returns the next state, the
// unchanged `prev` (already-applied duplicate), or `null` to signal the caller
// must resync (a delta with no base, or a revision gap).
export function reduceProjection(
  prev: ProjectionState | null,
  update: ProjectionUpdate,
): ProjectionState | null {
  if (update.kind === 'full') {
    const byId = new Map(update.projection.nodes.map((node) => [node.id, node]));
    const affected = new Set<NodeId>(byId.keys());
    const renderRev = nextRevisions(prev?.index.renderRev ?? null, affected, byId.keys());
    return { index: { projection: update.projection, byId, renderRev }, revision: update.revision };
  }
  if (!prev) return null;
  if (update.revision <= prev.revision) return prev; // dual-channel duplicate — already applied
  if (update.revision !== prev.revision + 1) return null; // gap — resync

  const byId = new Map(prev.index.byId);
  const changed = new Set<NodeId>();
  for (const id of update.removedIds) {
    for (const descId of collectSubtreeIds(prev.index.byId, id)) {
      byId.delete(descId);
      changed.add(descId);
    }
  }
  for (const node of update.changedNodes) {
    byId.set(node.id, node);
    changed.add(node.id);
  }
  const projection: DocumentProjection = { ...prev.index.projection, todayId: update.todayId, nodes: [...byId.values()] };
  const affected = propagateDirty(changed, byId);
  const renderRev = nextRevisions(prev.index.renderRev, affected, byId.keys());
  return { index: { projection, byId, renderRev }, revision: update.revision };
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
export function useProjectionStore(resync: () => Promise<ProjectionSnapshot>): ProjectionStore {
  const [state, setState] = useState<ProjectionState | null>(null);
  const applyProjectionUpdate = useCallback((update: ProjectionUpdate) => {
    setState((prev) => {
      const next = measureRenderIndex(() => reduceProjection(prev, update));
      if (next === null) {
        void resync().then((snapshot) => setState((cur) => reduceProjection(
          cur,
          { kind: 'full', revision: snapshot.revision, projection: snapshot.projection },
        )));
        return prev;
      }
      return next;
    });
  }, [resync]);
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
    expanded: new Set<NodeId>(),
    expandedHiddenFields: new Set<string>(),
    editingDescriptionId: null,
    commandOpen: false,
    batchTagSelectorOpen: false,
    toolbarDropdownRequest: null,
  });
}

export function flattenVisibleRows(
  rootId: NodeId,
  byId: Map<NodeId, NodeProjection>,
  expanded: Set<NodeId>,
  expandedHiddenFields: Set<string> = new Set(),
): NodeId[] {
  const result: NodeId[] = [];
  const visit = (parentId: NodeId, referencePath: NodeId[]) => {
    const parent = byId.get(parentId);
    if (!parent) return;
    const rows = buildOutlinerRows(parent, byId, { expandedHiddenFields });
    for (const row of rows) {
      if (row.type !== 'field' && row.type !== 'content') continue;
      result.push(row.id);
      if (!expanded.has(row.id)) continue;
      const childParentId = outlinerChildParentId(row.id, byId);
      if (!childParentId || referencePath.includes(childParentId)) continue;
      visit(childParentId, [...referencePath, childParentId]);
    }
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
