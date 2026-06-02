import type {
  AgentUserViewContext,
  AgentUserViewNodeContext,
  AgentUserViewOutlineNodeContext,
  AgentUserViewPanelContext,
} from '../../../core/agentTypes';
import { formatNodeReferenceMarker } from '../../../core/referenceMarkup';
import { nodeIsDone, nodeShowsCheckbox } from '../../../core/configProjection';
import type { NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex, UiState } from '../../state/document';
import { buildOutlinerRows, readViewConfig } from '../../state/outlinerRows';
import { buildPanelBreadcrumb } from '../panelBreadcrumb';
import type { WorkspaceTabState } from '../workspaceLayoutTypes';

const MAX_BREADCRUMB_CONTEXT_NODES = 6;
const MAX_CONTEXT_TITLE_LENGTH = 160;
const MAX_VISIBLE_OUTLINE_NODES = 80;
const MAX_VISIBLE_OUTLINE_DEPTH = 5;

export function buildAgentUserViewContext(input: {
  activeTab: WorkspaceTabState | null;
  index: DocumentIndex;
  ui: UiState;
}): AgentUserViewContext {
  const activePanelId = input.activeTab?.activePanelId ?? null;

  return {
    activePanelId,
    focusedPanelId: input.ui.focusedPanelId,
    focusSurface: input.ui.focusSurface,
    focusedNode: input.ui.focusedId
      ? buildNodeContext(input.ui.focusedId, input.index, {
          panelId: input.ui.focusedPanelId,
          surface: input.ui.focusSurface,
        })
      : null,
    nodePanels: buildPanelContexts(input.activeTab, input.index, input.ui),
  };
}

function buildPanelContexts(
  activeTab: WorkspaceTabState | null,
  index: DocumentIndex,
  ui: UiState,
): AgentUserViewPanelContext[] {
  if (!activeTab) return [];
  return activeTab.panels.flatMap((panel, panelIndex) => {
    if (panel.type !== 'outliner') return [];
    const rootNode = index.byId.get(panel.rootId);
    const visibleOutline = buildVisibleOutline(panel.rootId, index, ui);
    return [{
      panelId: panel.id,
      rootNodeId: panel.rootId,
      rootTitle: titleForNode(rootNode),
      rootType: rootNode?.type ?? 'outline',
      active: panel.id === activeTab.activePanelId,
      focused: panel.id === ui.focusedPanelId,
      order: panelIndex + 1,
      childCount: rootNode?.children.length ?? 0,
      breadcrumb: buildPanelBreadcrumb(rootNode, index).nodes
        .slice(-MAX_BREADCRUMB_CONTEXT_NODES)
        .map((node) => buildNodeContext(node.id, index))
        .filter((node): node is AgentUserViewNodeContext => Boolean(node)),
      visibleOutline: visibleOutline.nodes,
      visibleOutlineTruncated: visibleOutline.truncated,
    }];
  });
}

function buildNodeContext(
  nodeId: NodeId,
  index: DocumentIndex,
  options: { panelId?: string | null; surface?: string | null } = {},
): AgentUserViewNodeContext | null {
  const node = index.byId.get(nodeId);
  if (!node) return null;
  return {
    nodeId,
    title: titleForNode(node),
    panelId: options.panelId,
    surface: options.surface,
  };
}

function buildVisibleOutline(
  rootId: NodeId,
  index: DocumentIndex,
  ui: UiState,
): { nodes: AgentUserViewOutlineNodeContext[]; truncated: boolean } {
  const nodes: AgentUserViewOutlineNodeContext[] = [];
  let truncated = false;

  const append = (nodeId: NodeId, depth: number, forceExpanded = false): boolean => {
    const node = index.byId.get(nodeId);
    if (!node) return true;
    if (nodes.length >= MAX_VISIBLE_OUTLINE_NODES) {
      truncated = true;
      return false;
    }

    const childRows = visibleNodeRows(node, index, ui);
    const hasChildren = childRows.length > 0;
    const expanded = forceExpanded || node.type === 'fieldEntry' || ui.expanded.has(nodeId);
    const depthLimited = expanded && hasChildren && depth >= MAX_VISIBLE_OUTLINE_DEPTH;

    nodes.push({
      nodeId,
      title: outlineTextForNode(node, index),
      depth,
      ...(ui.focusedId === nodeId ? { focused: true } : {}),
      ...(hasChildren && !expanded ? { collapsed: true, childCount: childRows.length } : {}),
      ...(depthLimited ? { partial: { included: 0, total: childRows.length } } : {}),
    });

    if (!expanded || !hasChildren || depthLimited) return true;
    for (const row of childRows) {
      if (!append(row.id, depth + 1)) return false;
    }
    return true;
  };

  append(rootId, 0, true);
  return { nodes, truncated };
}

function visibleNodeRows(node: NodeProjection, index: DocumentIndex, ui: UiState): Array<{ id: NodeId }> {
  return buildOutlinerRows(node, index.byId, { expandedHiddenFields: ui.expandedHiddenFields })
    .filter((row): row is { id: NodeId; type: 'field' | 'content' } => row.type === 'field' || row.type === 'content')
    .map((row) => ({ id: row.id }));
}

function outlineTextForNode(node: NodeProjection, index: DocumentIndex): string {
  if (node.type === 'fieldEntry') {
    const field = node.fieldDefId ? index.byId.get(node.fieldDefId) : undefined;
    return `${titleForNode(field ?? node)}::`;
  }

  const parts: string[] = [];
  if (node.type === 'search') parts.push('%%search%%');
  const viewMode = node.type === 'search'
    ? readViewConfig(node, index.byId).viewMode
    : node.type === 'viewDef' ? node.viewMode : undefined;
  if (viewMode) parts.push(`%%view:${viewMode}%%`);
  if (nodeIsDone(node)) parts.push('[x]');
  else if (nodeShowsCheckbox(index.byId, node)) parts.push('[ ]');
  parts.push(referenceText(node, index) ?? titleForNode(node));
  if (node.description) parts.push(`- ${compactContextText(node.description, MAX_CONTEXT_TITLE_LENGTH)}`);
  parts.push(...tagLabels(node, index));
  return parts.join(' ').trim() || 'Untitled';
}

function referenceText(node: NodeProjection, index: DocumentIndex): string | null {
  if (node.type !== 'reference' || !node.targetId) return null;
  const target = index.byId.get(node.targetId);
  const display = target ? titleForNode(target) : node.targetId;
  return formatNodeReferenceMarker(display, node.targetId);
}

function tagLabels(node: NodeProjection, index: DocumentIndex): string[] {
  return node.tags
    .map((tagId) => {
      const tag = titleForNode(index.byId.get(tagId));
      if (!tag || tag === 'Untitled') return null;
      return /^[\w-]+$/.test(tag) ? `#${tag}` : `#[[${tag}]]`;
    })
    .filter((tag): tag is string => Boolean(tag));
}

function titleForNode(node: NodeProjection | undefined): string {
  if (!node) return 'Untitled';
  const text = node.type === 'reference' && node.targetId
    ? `@${node.targetId}`
    : node.content.text || 'Untitled';
  return compactContextText(text, MAX_CONTEXT_TITLE_LENGTH);
}

function compactContextText(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength).trim()}...`;
}
