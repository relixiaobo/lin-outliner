import type { NodeProjection } from '../core/types';
import {
  backlinks,
  breadcrumb,
  checkedState,
  fieldReads,
  nodeKind,
  nodeTitle,
  normalChildIds,
  parentRef,
  referenceText,
  requiredNode,
  revisionOf,
  tagLabels,
} from './agentNodeToolProjection';
import { searchQueryOutlineLines, searchViewModeOf } from './agentNodeToolSearch';
import type {
  ChildrenPage,
  NodeChildSummary,
  NodeReadItem,
  NormalizedReadParams,
  ProjectionIndex,
} from './agentNodeToolTypes';
import { asRecord, clampInteger, compactOutline } from './agentNodeToolUtils';

export function normalizeReadParams(rawParams: unknown): NormalizedReadParams {
  const input = asRecord(rawParams);
  const nodeId = typeof input.node_id === 'string' && input.node_id.trim() ? input.node_id.trim() : undefined;
  const nodeIds = Array.isArray(input.node_ids)
    ? input.node_ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim())
    : undefined;
  return {
    nodeId,
    nodeIds,
    depth: clampInteger(input.depth, 0, 3, 1),
    childOffset: clampInteger(input.child_offset, 0, Number.MAX_SAFE_INTEGER, 0),
    childLimit: clampInteger(input.child_limit, 0, 50, 20),
    includeDeleted: input.include_deleted === true,
    includeBacklinks: input.include_backlinks === true,
    error: nodeId && nodeIds ? 'Use either node_id or node_ids, not both.' : undefined,
  };
}

export function buildReadItem(index: ProjectionIndex, nodeId: string, params: NormalizedReadParams): NodeReadItem {
  const node = requiredNode(index, nodeId);
  return {
    nodeId,
    type: nodeKind(node),
    title: nodeTitle(index, node),
    description: node.description ?? null,
    tags: tagLabels(index, node),
    fields: fieldReads(index, node, params.includeDeleted),
    checked: checkedState(node),
    parent: parentRef(index, node),
    breadcrumb: breadcrumb(index, nodeId),
    children: buildChildrenPage(index, nodeId, params.depth, params.childOffset, params.childLimit, params.includeDeleted),
    backlinks: params.includeBacklinks ? backlinks(index, nodeId, params.includeDeleted) : undefined,
    revision: revisionOf(node),
    outline: serializeOutline(index, nodeId, params.depth, params.childOffset, params.childLimit, params.includeDeleted),
  };
}

function buildChildrenPage(
  index: ProjectionIndex,
  nodeId: string,
  depth: number,
  offset: number,
  limit: number,
  includeDeleted: boolean,
): ChildrenPage {
  const childIds = normalChildIds(index, nodeId, includeDeleted);
  const pageIds = depth > 0 ? childIds.slice(offset, offset + limit) : [];
  return {
    total: childIds.length,
    offset,
    limit,
    items: pageIds.map((childId) => childSummary(index, childId, depth - 1, limit, includeDeleted)),
  };
}

function childSummary(
  index: ProjectionIndex,
  nodeId: string,
  remainingDepth: number,
  childLimit: number,
  includeDeleted: boolean,
): NodeChildSummary {
  const node = requiredNode(index, nodeId);
  const children = normalChildIds(index, nodeId, includeDeleted);
  return {
    nodeId,
    title: nodeTitle(index, node),
    type: nodeKind(node),
    tags: tagLabels(index, node),
    checked: checkedState(node),
    hasChildren: children.length > 0,
    childCount: children.length,
    isReference: node.type === 'reference' || undefined,
    targetId: node.targetId,
    children: remainingDepth > 0 ? buildChildrenPage(index, nodeId, remainingDepth, 0, childLimit, includeDeleted) : undefined,
  };
}

export function serializeOutline(
  index: ProjectionIndex,
  nodeId: string,
  depth: number,
  childOffset: number,
  childLimit: number,
  includeDeleted: boolean,
): string {
  return serializeOutlineNode(index, nodeId, depth, 0, childOffset, childLimit, includeDeleted).join('\n');
}

export function serializeAnnotatedOutlines(
  index: ProjectionIndex,
  nodeIds: string[],
  depth: number,
  childOffset: number,
  childLimit: number,
  includeDeleted: boolean,
): string | undefined {
  return compactOutline(nodeIds.map((nodeId) =>
    serializeAnnotatedOutline(index, nodeId, depth, childOffset, childLimit, includeDeleted)));
}

export function serializeAnnotatedOutline(
  index: ProjectionIndex,
  nodeId: string,
  depth: number,
  childOffset: number,
  childLimit: number,
  includeDeleted: boolean,
): string {
  return serializeAnnotatedOutlineNode(index, nodeId, depth, 0, childOffset, childLimit, includeDeleted).join('\n');
}

function serializeAnnotatedOutlineNode(
  index: ProjectionIndex,
  nodeId: string,
  depth: number,
  level: number,
  childOffset: number,
  childLimit: number,
  includeDeleted: boolean,
): string[] {
  const node = requiredNode(index, nodeId);
  const indent = '  '.repeat(level);
  const lines = [`${indent}- ${nodeMarker(nodeId)}${outlineNodeText(index, node)}`];
  for (const field of fieldReads(index, node, includeDeleted)) {
    const fieldIndent = '  '.repeat(level + 1);
    lines.push(`${fieldIndent}- ${nodeMarker(field.fieldEntryId)}${field.name}::`);
    for (const value of field.values) {
      const marker = value.valueNodeId ? nodeMarker(value.valueNodeId) : '';
      lines.push(`${fieldIndent}  - ${marker}${value.text}`);
    }
  }
  if (node.type === 'search') {
    lines.push(...searchQueryOutlineLines(index, node, level + 1));
    return lines;
  }
  if (depth <= 0) return lines;
  const childIds = normalChildIds(index, nodeId, includeDeleted).slice(childOffset, childOffset + childLimit);
  for (const childId of childIds) {
    lines.push(...serializeAnnotatedOutlineNode(index, childId, depth - 1, level + 1, 0, childLimit, includeDeleted));
  }
  return lines;
}

function nodeMarker(nodeId: string): string {
  return `%%node:${nodeId}%% `;
}

function serializeOutlineNode(
  index: ProjectionIndex,
  nodeId: string,
  depth: number,
  level: number,
  childOffset: number,
  childLimit: number,
  includeDeleted: boolean,
): string[] {
  const node = requiredNode(index, nodeId);
  const indent = '  '.repeat(level);
  const lines = [`${indent}- ${outlineNodeText(index, node)}`];
  for (const field of fieldReads(index, node, includeDeleted)) {
    const fieldIndent = '  '.repeat(level + 1);
    if (field.values.length === 0) {
      lines.push(`${fieldIndent}- ${field.name}::`);
    } else if (field.values.length === 1) {
      lines.push(`${fieldIndent}- ${field.name}:: ${field.values[0]!.text}`);
    } else {
      lines.push(`${fieldIndent}- ${field.name}::`);
      for (const value of field.values) lines.push(`${fieldIndent}  - ${value.text}`);
    }
  }
  if (node.type === 'search') {
    lines.push(...searchQueryOutlineLines(index, node, level + 1));
    return lines;
  }
  if (depth <= 0) return lines;
  const childIds = normalChildIds(index, nodeId, includeDeleted).slice(childOffset, childOffset + childLimit);
  for (const childId of childIds) {
    lines.push(...serializeOutlineNode(index, childId, depth - 1, level + 1, 0, childLimit, includeDeleted));
  }
  return lines;
}

function outlineNodeText(index: ProjectionIndex, node: NodeProjection): string {
  const parts: string[] = [];
  if (node.type === 'search') parts.push('%%search%%');
  const viewMode = node.type === 'search' ? searchViewModeOf(index, node) : node.viewMode;
  if (viewMode) parts.push(`%%view:${viewMode}%%`);
  if (node.completedAt) parts.push('[x]');
  else if (node.showCheckbox) parts.push('[ ]');
  parts.push((referenceText(index, node) ?? node.content.text) || '(untitled)');
  if (node.description) parts.push(`- ${node.description}`);
  parts.push(...tagLabels(index, node));
  return parts.join(' ').trim();
}

export function pageHasMore(page: ChildrenPage): boolean {
  return page.offset + page.items.length < page.total;
}
