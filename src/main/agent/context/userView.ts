import type {
  RendererUserViewHints,
  UserViewContextPayload,
  UserViewNodeSnapshot,
} from '../../../core/agent/protocol';
import { nodeIsDone, nodeShowsCheckbox } from '../../../core/configProjection';
import {
  formatNamedNodeReference,
  richTextToReferenceMarkup,
} from '../../../core/referenceMarkup';
import { formatTag } from '../../../core/textSyntax';
import { classifyNodeSource } from '../../../core/source';
import { sourceFieldValues } from '../../../core/sourceField';
import {
  type DocumentProjection,
  type NodeProjection,
} from '../../../core/types';
import { findViewDef } from '../../../core/viewConfig';

const MAX_TITLE_CHARS = 160;
const MAX_BREADCRUMB_NODES = 6;

function viewModeOf(nodes: ReadonlyMap<string, NodeProjection>, owner: NodeProjection) {
  const viewDef = findViewDef(nodes, owner);
  return viewDef?.type === 'viewDef' ? viewDef.viewMode ?? 'list' : 'list';
}

export function buildUserViewPayload(
  hints: RendererUserViewHints | undefined,
  projection: DocumentProjection | null,
): UserViewContextPayload | null {
  if (!hints) return null;
  const byId = new Map((projection?.nodes ?? []).map((node) => [node.id, node]));

  const panels = [...hints.panels]
    .sort((left, right) => left.order - right.order || compareStableText(left.panelId, right.panelId))
    .flatMap((panel) => {
    const target = viewTargetSnapshot(panel.target, panel.panelId, byId);
    if (!target) return [];
    const visibleOutline = panel.visibleNodes.flatMap((visible) => {
      const node = byId.get(visible.nodeId);
      if (!node) return [];
      const childCount = displayedChildCount(node, byId);
      return [{
        nodeId: node.id,
        title: outlineText(node, byId),
        depth: visible.depth,
        focused: hints.focusedNodeId === node.id,
        collapsed: childCount > 0 && !visible.expanded,
        childCount,
        includedChildCount: visible.expanded && visible.depth >= 5 && childCount > 0 ? 0 : null,
      }];
    });
    return [{
      panel: {
        panelId: panel.panelId,
        active: panel.active,
        focused: panel.focused,
        order: panel.order,
        target,
      },
      supplied: target.kind === 'node' && (visibleOutline.length > 0 || panel.visibleOutlineTruncated)
        ? {
            panelId: panel.panelId,
            sourceNodeId: target.nodeId,
            sourceTitle: target.title,
            outline: visibleOutline,
            visibleOutlineTruncated: panel.visibleOutlineTruncated,
          }
        : null,
    }];
    });
  const panelSnapshots = panels.map((entry) => entry.panel);
  return {
    schemaVersion: 1,
    kind: 'userView',
    activePanelId: validPanelId(hints.activePanelId, panelSnapshots),
    focusedPanelId: validPanelId(hints.focusedPanelId, panelSnapshots),
    focusSurface: hints.focusSurface,
    focusedNode: hints.focusedNodeId ? nodeSnapshot(hints.focusedNodeId, byId, hints.focusedPanelId, hints.focusSurface) : null,
    selectedNodes: unique(hints.selectedNodeIds)
      .flatMap((nodeId) => nodeSnapshot(nodeId, byId, hints.focusedPanelId, 'selection') ?? []),
    panels: panelSnapshots,
    suppliedOutline: panels.flatMap((entry) => entry.supplied ?? []),
    viewsComplete: hints.viewsComplete && panelSnapshots.length === hints.panels.length,
    selectionTruncated: hints.selectionTruncated,
  };
}

export function nodeSnapshot(
  nodeId: string,
  byId: ReadonlyMap<string, NodeProjection>,
  panelId: string | null = null,
  surface: string | null = null,
): UserViewNodeSnapshot | null {
  const node = byId.get(nodeId);
  return node ? { nodeId, title: resolvedNodeTitle(node, byId), panelId, surface } : null;
}

export function nodeBreadcrumb(
  node: NodeProjection,
  byId: ReadonlyMap<string, NodeProjection>,
): UserViewNodeSnapshot[] {
  const nodes: NodeProjection[] = [];
  const seen = new Set<string>();
  let current: NodeProjection | undefined = node;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    nodes.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return nodes.reverse().slice(-MAX_BREADCRUMB_NODES).map((entry) => ({
    nodeId: entry.id,
    title: resolvedNodeTitle(entry, byId),
    panelId: null,
    surface: null,
  }));
}

export function nodeTitle(node: NodeProjection): string {
  const text = (node.type === 'reference' && node.targetId
      ? formatNamedNodeReference(node.targetId, undefined, { unavailable: 'display' })
      : null)
    || richTextToReferenceMarkup(node.content)
    || 'Untitled';
  return compact(text, MAX_TITLE_CHARS);
}

export function outlineText(
  node: NodeProjection,
  byId: ReadonlyMap<string, NodeProjection>,
): string {
  if (node.type === 'fieldEntry') {
    const field = node.fieldDefId ? byId.get(node.fieldDefId) : undefined;
    return `${nodeTitle(field ?? node)}::`;
  }

  const parts: string[] = [];
  if (node.type === 'search') parts.push('%%search%%');
  const viewMode = viewModeOf(byId, node);
  if (viewMode !== 'list') parts.push(`%%view:${viewMode}%%`);
  if (nodeIsDone(node)) parts.push('[x]');
  else if (nodeShowsCheckbox(byId, node)) parts.push('[ ]');
  parts.push(referenceText(node, byId) ?? nodeTitle(node));
  if (node.description) parts.push(`- ${compact(node.description, MAX_TITLE_CHARS)}`);
  parts.push(...node.tags.flatMap((tagId) => {
    const tag = byId.get(tagId);
    if (!tag) return [];
    const title = nodeTitle(tag);
    return title === 'Untitled' ? [] : [formatTag(title)];
  }));
  return parts.join(' ').trim() || 'Untitled';
}

function referenceText(
  node: NodeProjection,
  byId: ReadonlyMap<string, NodeProjection>,
): string | null {
  if (node.type !== 'reference' || !node.targetId) return null;
  const target = byId.get(node.targetId);
  return formatNamedNodeReference(
    node.targetId,
    target ? resolvedNodeTitle(target, byId) : undefined,
    { unavailable: 'display' },
  );
}

export function resolvedNodeTitle(
  node: NodeProjection,
  byId: ReadonlyMap<string, NodeProjection>,
): string {
  let current = node;
  const seen = new Set<string>();
  while (current.type === 'reference' && current.targetId) {
    if (seen.has(current.id)) {
      return formatNamedNodeReference(current.targetId, undefined, { unavailable: 'display' });
    }
    seen.add(current.id);
    const target = byId.get(current.targetId);
    if (!target) {
      return formatNamedNodeReference(current.targetId, undefined, { unavailable: 'display' });
    }
    current = target;
  }
  const authoredTitle = nodeTitle(current);
  if (authoredTitle !== 'Untitled') return authoredTitle;
  return sourceFallbackTitle(current, byId) ?? authoredTitle;
}

function viewTargetSnapshot(
  target: RendererUserViewHints['panels'][number]['target'],
  panelId: string,
  byId: ReadonlyMap<string, NodeProjection>,
): UserViewContextPayload['panels'][number]['target'] | null {
  if (target.kind === 'node') {
    const root = byId.get(target.nodeId);
    return root ? {
      kind: 'node',
      nodeId: root.id,
      title: resolvedNodeTitle(root, byId),
      rootType: root.type ?? 'outline',
      childCount: displayedChildCount(root, byId),
      breadcrumb: nodeBreadcrumb(root, byId),
    } : null;
  }
  if (target.kind === 'thread-trajectory') {
    return {
      kind: target.kind,
      threadId: target.threadId,
      threadName: compact(target.threadName ?? `Thread ${target.threadId}`, MAX_TITLE_CHARS),
      turnId: target.turnId,
      selectedRecordId: target.selectedRecordId,
    };
  }
  const ownerNode = target.ownerNodeId
    ? nodeSnapshot(target.ownerNodeId, byId, panelId, 'view-owner')
    : null;
  if (target.kind === 'local-file') {
    return {
      kind: target.kind,
      path: target.path,
      entryKind: target.entryKind,
      label: compact(target.label ?? fileLabel(target.path), MAX_TITLE_CHARS),
      ownerNode,
    };
  }
  if (target.kind === 'asset') {
    return {
      kind: target.kind,
      assetId: target.assetId,
      label: compact(target.label ?? ownerNode?.title ?? 'Asset', MAX_TITLE_CHARS),
      ownerNode,
    };
  }
  if (target.kind === 'linked-file') {
    return {
      kind: target.kind,
      sourceValueId: target.sourceValueId,
      sourceText: target.sourceText,
      label: compact(target.label ?? fileLabel(target.sourceText), MAX_TITLE_CHARS),
      ownerNode,
    };
  }
  return {
    kind: target.kind,
    url: target.url,
    label: target.label ? compact(target.label, MAX_TITLE_CHARS) : null,
    ownerNode,
  };
}

function displayedChildCount(
  node: NodeProjection,
  byId: ReadonlyMap<string, NodeProjection>,
): number {
  let current: NodeProjection | undefined = node;
  const seen = new Set<string>();
  while (current?.type === 'reference') {
    if (seen.has(current.id) || !current.targetId) return 0;
    seen.add(current.id);
    current = byId.get(current.targetId);
  }
  if (!current) return 0;
  return current.children.length;
}

function sourceFallbackTitle(
  node: NodeProjection,
  byId: ReadonlyMap<string, NodeProjection>,
): string | null {
  for (const value of sourceFieldValues(byId, node.id)) {
    return compact(classifyNodeSource(value.sourceText).label, MAX_TITLE_CHARS);
  }
  return null;
}

function validPanelId(
  panelId: string | null,
  panels: UserViewContextPayload['panels'],
): string | null {
  return panelId && panels.some((panel) => panel.panelId === panelId) ? panelId : null;
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3).trimEnd()}...`;
}

function fileLabel(value: string): string {
  const normalized = value.replace(/[\\/]+$/u, '');
  return normalized.split(/[\\/]/u).at(-1) || value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
