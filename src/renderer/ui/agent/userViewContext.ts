import type {
  AgentUserViewContext,
  AgentUserViewNodeContext,
  AgentUserViewOutlineNodeContext,
  AgentUserViewPanelContext,
} from '../../../core/agentTypes';
import { formatNodeReferenceMarker, richTextToReferenceMarkup } from '../../../core/referenceMarkup';
import { formatTag } from '../../../core/textSyntax';
import { nodeIsDone, nodeShowsCheckbox } from '../../../core/configProjection';
import type { NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex, UiState } from '../../state/document';
import { buildOutlinerRows, readViewConfig } from '../../state/outlinerRows';
import { buildPanelBreadcrumb } from '../panelBreadcrumb';
import { fileNodeTitle, isFileNode } from '../preview/fileNode';
import type { WorkspacePanelState } from '../workspaceLayoutTypes';

const MAX_BREADCRUMB_CONTEXT_NODES = 6;
const MAX_CONTEXT_TITLE_LENGTH = 160;
const MAX_VISIBLE_OUTLINE_NODES = 80;
const MAX_VISIBLE_OUTLINE_DEPTH = 5;

// The outline root a conversation is anchored to: the active panel root, else the
// first panel root, else today.
function currentRootId(context: AgentUserViewContext, index: DocumentIndex): NodeId | null {
  return context.nodePanels.find((panel) => panel.active)?.rootNodeId
    ?? context.nodePanels[0]?.rootNodeId
    ?? index.projection.todayId
    ?? null;
}

// The node a conversation is "about" (what the composer tells the agent the user is
// looking at): the focused node, else the current root.
export function composerCurrentNodeId(context: AgentUserViewContext, index: DocumentIndex): NodeId | null {
  return context.focusedNode?.nodeId ?? currentRootId(context, index);
}

// Where an ingested file lands. Mirrors the paste/drop convention: a sibling right
// after the focused row (under its parent), so the file never gets buried as a child
// of a media/code leaf that doesn't render children. With nothing focused, append
// into the current outline root (always a container). Returns null only when there
// is no resolvable root at all.
export function insertionTargetFor(
  context: AgentUserViewContext,
  index: DocumentIndex,
): { parentId: NodeId; index: number | null } | null {
  const focusedId = context.focusedNode?.nodeId;
  if (focusedId) {
    const node = index.byId.get(focusedId);
    // When the focused node is itself a panel root (the user is on the zoomed-in
    // title), append into it — a sibling would escape the visible subtree. Same for a
    // parentless node. Otherwise insert right after the focused row.
    const focusedIsRoot = context.nodePanels.some((panel) => panel.rootNodeId === focusedId);
    if (!focusedIsRoot && node?.parentId) {
      const siblings = index.byId.get(node.parentId)?.children ?? [];
      const position = siblings.indexOf(focusedId);
      return { parentId: node.parentId, index: position >= 0 ? position + 1 : null };
    }
    if (node) return { parentId: focusedId, index: null };
  }
  const root = currentRootId(context, index);
  return root ? { parentId: root, index: null } : null;
}

export function buildAgentUserViewContext(input: {
  activePanelId: string | null;
  panels: WorkspacePanelState[];
  index: DocumentIndex;
  ui: UiState;
}): AgentUserViewContext {
  return {
    activePanelId: input.activePanelId,
    focusedPanelId: input.ui.focusedPanelId,
    focusSurface: input.ui.focusSurface,
    focusedNode: input.ui.focusedId
      ? buildNodeContext(input.ui.focusedId, input.index, {
          panelId: input.ui.focusedPanelId,
          surface: input.ui.focusSurface,
        })
      : null,
    nodePanels: buildPanelContexts(input.activePanelId, input.panels, input.index, input.ui),
  };
}

function buildPanelContexts(
  activePanelId: string | null,
  panels: WorkspacePanelState[],
  index: DocumentIndex,
  ui: UiState,
): AgentUserViewPanelContext[] {
  if (panels.length === 0) return [];
  return panels.flatMap((panel, panelIndex) => {
    const rootId = panelContextRootId(panel);
    if (!rootId) return [];
    const rootNode = index.byId.get(rootId);
    const visibleOutline = buildVisibleOutline(rootId, index, ui);
    return [{
      panelId: panel.id,
      rootNodeId: rootId,
      rootTitle: titleForNode(rootNode),
      rootType: rootNode?.type ?? 'outline',
      active: panel.id === activePanelId,
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

function panelContextRootId(panel: WorkspacePanelState): NodeId | null {
  if (panel.type !== 'workspace') return null;
  if (panel.view.kind === 'outliner') return panel.view.rootId;
  return panel.view.nodeId ?? null;
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
      return formatTag(tag);
    })
    .filter((tag): tag is string => Boolean(tag));
}

function titleForNode(node: NodeProjection | undefined): string {
  if (!node) return 'Untitled';
  if (isFileNode(node)) return compactContextText(fileNodeTitle(node) || 'Untitled', MAX_CONTEXT_TITLE_LENGTH);
  const text = node.type === 'reference' && node.targetId
    ? `@${node.targetId}`
    : richTextToReferenceMarkup(node.content) || 'Untitled';
  return compactContextText(text, MAX_CONTEXT_TITLE_LENGTH);
}

function compactContextText(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength).trim()}...`;
}
