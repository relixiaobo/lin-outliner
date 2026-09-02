import type {
  RendererUserViewHints,
  RendererUserViewPanelHint,
  RendererUserViewVisibleNodeHint,
} from '../../../core/agent/protocol';
import type { NodeId } from '../../api/types';
import { fieldSlotsForIndex, outlinerChildParentId, type DocumentIndex, type UiState } from '../../state/document';
import {
  buildOutlinerRows,
  flattenExpandedOutlinerRows,
  readViewConfig,
} from '../../state/outlinerRows';
import { buildSelectableRows } from '../../state/selectableRows';
import type { WorkspacePanelState } from '../workspaceLayoutTypes';

const MAX_VISIBLE_NODES = 80;
const MAX_VISIBLE_DEPTH = 5;
const MAX_SELECTED_NODES = 50;

export function buildRendererUserViewHints(input: {
  readonly activePanelId: string | null;
  readonly panels: readonly WorkspacePanelState[];
  readonly index: DocumentIndex;
  readonly ui: UiState;
  readonly threadName?: (threadId: string) => string | null;
}): RendererUserViewHints {
  let remainingVisibleNodes = MAX_VISIBLE_NODES;
  let viewsComplete = true;
  const panels: RendererUserViewPanelHint[] = [];
  for (let index = 0; index < input.panels.length; index += 1) {
    const panel = input.panels[index]!;
    const target = panelTarget(panel, input.index, input.threadName);
    if (!target) {
      viewsComplete = false;
      continue;
    }
    const rootNodeId = target.kind === 'node' ? target.nodeId : null;
    const visible = rootNodeId
      ? visibleNodeHints(rootNodeId, input.index, input.ui, remainingVisibleNodes)
      : { nodes: [], truncated: false };
    remainingVisibleNodes -= visible.nodes.length;
    panels.push({
      panelId: panel.id,
      order: index + 1,
      active: panel.id === input.activePanelId,
      focused: panel.id === input.ui.focusedPanelId,
      target,
      visibleNodes: visible.nodes,
      visibleOutlineTruncated: visible.truncated,
    });
  }
  const selected = selectedNodeIds(input.index, input.ui);
  const activeViewResolved = input.activePanelId === null
    || panels.some((panel) => panel.panelId === input.activePanelId);
  return {
    activePanelId: input.activePanelId,
    focusedPanelId: input.ui.focusedPanelId,
    focusSurface: input.ui.focusSurface,
    focusedNodeId: input.ui.focusedId,
    selectedNodeIds: selected.nodeIds,
    panels,
    viewsComplete: viewsComplete && activeViewResolved,
    selectionTruncated: selected.truncated,
  };
}

function panelTarget(
  panel: WorkspacePanelState,
  index: DocumentIndex,
  threadName: ((threadId: string) => string | null) | undefined,
): RendererUserViewPanelHint['target'] | null {
  if (panel.type !== 'workspace') return null;
  const view = panel.view;
  if (view.kind === 'outliner') {
    return index.byId.has(view.rootId) ? { kind: 'node', nodeId: view.rootId } : null;
  }
  if (view.kind === 'thread-trajectory') {
    return {
      kind: 'thread-trajectory',
      threadId: view.threadId,
      threadName: threadName?.(view.threadId) ?? null,
      turnId: view.turnId ?? null,
      selectedRecordId: view.selectedRecordId ?? null,
    };
  }
  const ownerNodeId = view.nodeId && index.byId.has(view.nodeId) ? view.nodeId : null;
  switch (view.target.kind) {
    case 'local-file':
      return {
        kind: 'local-file',
        path: view.target.path,
        entryKind: view.target.entryKind,
        label: view.target.label ?? null,
        ownerNodeId,
      };
    case 'asset':
      return {
        kind: 'asset',
        assetId: view.target.assetId,
        label: view.target.label ?? null,
        ownerNodeId,
      };
    case 'linked-file':
      return {
        kind: 'linked-file',
        sourceValueId: view.target.sourceValueId,
        sourceText: view.target.sourceText,
        label: view.target.label ?? null,
        ownerNodeId,
      };
    case 'url':
      return {
        kind: 'url',
        url: view.target.url,
        label: view.target.label ?? null,
        ownerNodeId,
      };
  }
}

function selectedNodeIds(
  index: DocumentIndex,
  ui: UiState,
): { readonly nodeIds: NodeId[]; readonly truncated: boolean } {
  if (ui.focusedId || ui.selectedIds.size === 0) return { nodeIds: [], truncated: false };
  const selectionRootId = ui.selectionRootId && index.byId.has(ui.selectionRootId)
    ? ui.selectionRootId
    : null;
  const visibleOrder = selectionRootId
    ? buildSelectableRows(selectionRootId, index.byId, {
        expanded: ui.expanded,
        expandedHiddenFields: ui.expandedHiddenFields,
      }).map((row) => row.id)
    : [];
  const visibleIds = new Set(visibleOrder);
  const ordered = [
    ...visibleOrder.filter((nodeId) => ui.selectedIds.has(nodeId)),
    ...[...index.byId.keys()].filter((nodeId) => (
      ui.selectedIds.has(nodeId) && !visibleIds.has(nodeId)
    )),
  ];
  return {
    nodeIds: ordered.slice(0, MAX_SELECTED_NODES),
    truncated: ordered.length > MAX_SELECTED_NODES,
  };
}

function visibleNodeHints(
  rootNodeId: NodeId,
  index: DocumentIndex,
  ui: UiState,
  limit: number,
): { readonly nodes: RendererUserViewVisibleNodeHint[]; readonly truncated: boolean } {
  const nodes: RendererUserViewVisibleNodeHint[] = [];
  let truncated = limit <= 0;
  const append = (
    nodeId: NodeId,
    depth: number,
    referencePath: readonly NodeId[],
    forceExpanded = false,
    suppressFieldEntries = false,
  ): boolean => {
    const node = index.byId.get(nodeId);
    if (!node) return true;
    if (nodes.length >= limit) {
      truncated = true;
      return false;
    }
    const expanded = forceExpanded || node.type === 'fieldEntry' || ui.expanded.has(nodeId);
    nodes.push({ nodeId, depth, expanded });
    const childParentId = outlinerChildParentId(nodeId, index.byId);
    if (!childParentId || referencePath.includes(childParentId)) return true;
    const displayedParent = index.byId.get(childParentId);
    const tableMode = readViewConfig(displayedParent, index.byId).viewMode === 'table';
    const children = visibleChildren(childParentId, index, ui, suppressFieldEntries);
    if (!expanded || children.length === 0) return true;
    if (depth >= MAX_VISIBLE_DEPTH) {
      truncated = true;
      return true;
    }
    const nextReferencePath = [...referencePath, childParentId];
    for (const childId of children) {
      const child = index.byId.get(childId);
      const childSuppressFieldEntries = child?.type === 'fieldEntry'
        ? false
        : tableMode;
      if (!append(
        childId,
        depth + 1,
        nextReferencePath,
        false,
        childSuppressFieldEntries,
      )) return false;
    }
    return true;
  };
  append(rootNodeId, 0, [], true);
  return { nodes, truncated };
}

function visibleChildren(
  parentId: NodeId,
  index: DocumentIndex,
  ui: UiState,
  suppressFieldEntries = false,
): NodeId[] {
  const node = index.byId.get(parentId);
  if (!node) return [];
  return flattenExpandedOutlinerRows(
    buildOutlinerRows(node, index.byId, {
      expandedHiddenFields: ui.expandedHiddenFields,
      suppressFieldEntries,
      fieldSlots: (nodeId) => fieldSlotsForIndex(index, nodeId),
    }),
    ui.expanded,
  ).flatMap((row) => {
    if (row.type === 'content') return [row.id];
    if (row.type === 'field' && row.slot.entryId) return [row.slot.entryId];
    return [];
  });
}
