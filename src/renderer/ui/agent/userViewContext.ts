import type {
  RendererUserViewHints,
  RendererUserViewPanelHint,
  RendererUserViewVisibleNodeHint,
} from '../../../core/agent/protocol';
import type { NodeId } from '../../api/types';
import { outlinerChildParentId, type DocumentIndex, type UiState } from '../../state/document';
import { buildOutlinerRows, flattenExpandedOutlinerRows } from '../../state/outlinerRows';
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
}): RendererUserViewHints {
  let remainingVisibleNodes = MAX_VISIBLE_NODES;
  let truncated = false;
  const panels: RendererUserViewPanelHint[] = [];
  for (let index = 0; index < input.panels.length; index += 1) {
    const panel = input.panels[index]!;
    const rootNodeId = panelRootNodeId(panel);
    if (!rootNodeId || !input.index.byId.has(rootNodeId)) continue;
    const visible = visibleNodeHints(rootNodeId, input.index, input.ui, remainingVisibleNodes);
    remainingVisibleNodes -= visible.nodes.length;
    truncated ||= visible.truncated;
    panels.push({
      panelId: panel.id,
      rootNodeId,
      order: index + 1,
      active: panel.id === input.activePanelId,
      focused: panel.id === input.ui.focusedPanelId,
      visibleNodes: visible.nodes,
      visibleOutlineTruncated: visible.truncated,
    });
  }
  const selected = selectedNodeIds(input.index, input.ui);
  truncated ||= selected.truncated;
  return {
    activePanelId: input.activePanelId,
    focusedPanelId: input.ui.focusedPanelId,
    focusSurface: input.ui.focusSurface,
    focusedNodeId: input.ui.focusedId,
    selectedNodeIds: selected.nodeIds,
    panels,
    truncated,
  };
}

function panelRootNodeId(panel: WorkspacePanelState): NodeId | null {
  if (panel.type !== 'workspace') return null;
  if (panel.view.kind === 'outliner') return panel.view.rootId;
  if (panel.view.kind === 'file-preview') return panel.view.nodeId ?? null;
  return null;
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
    const children = visibleChildren(childParentId, index, ui);
    if (!expanded || children.length === 0) return true;
    if (depth >= MAX_VISIBLE_DEPTH) {
      truncated = true;
      return true;
    }
    const nextReferencePath = [...referencePath, childParentId];
    for (const childId of children) {
      if (!append(childId, depth + 1, nextReferencePath)) return false;
    }
    return true;
  };
  append(rootNodeId, 0, [], true);
  return { nodes, truncated };
}

function visibleChildren(parentId: NodeId, index: DocumentIndex, ui: UiState): NodeId[] {
  const node = index.byId.get(parentId);
  if (!node) return [];
  return flattenExpandedOutlinerRows(
    buildOutlinerRows(node, index.byId, { expandedHiddenFields: ui.expandedHiddenFields }),
    ui.expanded,
  ).flatMap((row) => row.type === 'field' || row.type === 'content' ? [row.id] : []);
}
