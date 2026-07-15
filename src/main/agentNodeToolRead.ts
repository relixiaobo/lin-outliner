import type { NodeProjection } from '../core/types';
import { nodeIsDone, nodeShowsCheckbox, projectFieldConfig, projectTagConfig } from '../core/configProjection';
import {
  backlinks,
  breadcrumb,
  checkedState,
  fieldReads,
  nodeKind,
  nodeTitle,
  normalChildIds,
  nodeContentText,
  parentRef,
  referenceText,
  requiredNode,
  revisionOf,
  tagLabels,
} from './agentNodeToolProjection';
import { searchQueryOutlineLines, searchViewModeOf } from './agentNodeToolSearch';
import { escapeSemanticText } from '../core/semanticIngest/inlineScanner';
import type {
  ChildrenPage,
  NodeChildSummary,
  NodeReadItem,
  NodeDefinitionRead,
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
    checked: checkedState(index, node),
    parent: parentRef(index, node),
    breadcrumb: breadcrumb(index, nodeId),
    children: buildChildrenPage(index, nodeId, params.depth, params.childOffset, params.childLimit, params.includeDeleted),
    backlinks: params.includeBacklinks ? backlinks(index, nodeId, params.includeDeleted) : undefined,
    definition: definitionRead(index, node),
    revision: editableOutlineRevision(index, nodeId),
    outline: serializeOutline(index, nodeId, params.depth, params.childOffset, params.childLimit, params.includeDeleted),
  };
}

function definitionRead(index: ProjectionIndex, node: NodeProjection): NodeDefinitionRead | undefined {
  if (node.type === 'fieldDef') {
    return {
      kind: 'field',
      config: projectFieldConfig(index.nodes, node),
      editableWith: 'node_edit operation "configure_definition" with node_id and definition_patch.',
    };
  }
  if (node.type === 'tagDef') {
    return {
      kind: 'tag',
      config: projectTagConfig(index.nodes, node),
      editableWith: 'node_edit operation "configure_definition" with node_id and definition_patch.',
    };
  }
  return undefined;
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
    checked: checkedState(index, node),
    hasChildren: children.length > 0,
    childCount: children.length,
    isReference: node.type === 'reference' || undefined,
    targetId: node.type === 'reference' ? node.targetId : undefined,
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

export function serializeEditableNodeOutline(index: ProjectionIndex, nodeId: string): string {
  return serializeAnnotatedOutline(index, nodeId, 0, 0, 500, false);
}

export function editableOutlineRevision(index: ProjectionIndex, nodeId: string): string {
  const node = requiredNode(index, nodeId);
  return `${revisionOf(node)}:${stableTextHash(serializeEditableNodeOutline(index, nodeId))}`;
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
  if (node.type === 'codeBlock') {
    const lines = serializeCodeBlockOutlineNode(node, indent, nodeMarker(nodeId));
    if (depth <= 0) return lines;
    const childIds = normalChildIds(index, nodeId, includeDeleted).slice(childOffset, childOffset + childLimit);
    for (const childId of childIds) {
      lines.push(...serializeAnnotatedOutlineNode(index, childId, depth - 1, level + 1, 0, childLimit, includeDeleted));
    }
    return lines;
  }
  const lines = [`${indent}- ${nodeMarker(nodeId)}${outlineNodeText(index, node)}`];
  for (const field of fieldReads(index, node, includeDeleted)) {
    const fieldIndent = '  '.repeat(level + 1);
    lines.push(`${fieldIndent}- ${nodeMarker(field.fieldEntryId)}${escapeSemanticText(field.name)}::`);
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

function stableTextHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
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
  if (node.type === 'codeBlock') {
    const lines = serializeCodeBlockOutlineNode(node, indent);
    if (depth <= 0) return lines;
    const childIds = normalChildIds(index, nodeId, includeDeleted).slice(childOffset, childOffset + childLimit);
    for (const childId of childIds) {
      lines.push(...serializeOutlineNode(index, childId, depth - 1, level + 1, 0, childLimit, includeDeleted));
    }
    return lines;
  }
  const lines = [`${indent}- ${outlineNodeText(index, node)}`];
  for (const field of fieldReads(index, node, includeDeleted)) {
    const fieldIndent = '  '.repeat(level + 1);
    if (field.values.length === 0) {
      lines.push(`${fieldIndent}- ${escapeSemanticText(field.name)}::`);
    } else if (field.values.length === 1) {
      lines.push(`${fieldIndent}- ${escapeSemanticText(field.name)}:: ${field.values[0]!.text}`);
    } else {
      lines.push(`${fieldIndent}- ${escapeSemanticText(field.name)}::`);
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
  const viewMode = node.type === 'search'
    ? searchViewModeOf(index, node)
    : node.type === 'viewDef' ? node.viewMode : undefined;
  if (viewMode) parts.push(`%%view:${viewMode}%%`);
  if (nodeIsDone(node)) parts.push('[x]');
  else if (nodeShowsCheckbox(index.nodes, node)) parts.push('[ ]');
  parts.push((referenceText(index, node) ?? nodeContentText(node)) || '(untitled)');
  if (node.description) parts.push(`- ${escapeSemanticText(node.description)}`);
  parts.push(...tagLabels(index, node));
  return parts.join(' ').trim();
}

function serializeCodeBlockOutlineNode(node: NodeProjection, indent: string, marker = ''): string[] {
  const language = node.type === 'codeBlock' ? node.codeLanguage ?? '' : '';
  const body = node.content.text.replace(/\r\n?/gu, '\n').split('\n');
  const fence = codeFenceFor(body);
  const lines = [`${indent}- ${marker}${fence}${language}`];
  for (const line of body) lines.push(`${indent}${line}`);
  lines.push(`${indent}${fence}`);
  return lines;
}

function codeFenceFor(lines: readonly string[]): string {
  const backtickLength = longestLeadingFenceRun(lines, '`');
  const tildeLength = longestLeadingFenceRun(lines, '~');
  const char = backtickLength <= tildeLength ? '`' : '~';
  const length = Math.max(3, (char === '`' ? backtickLength : tildeLength) + 1);
  return char.repeat(length);
}

function longestLeadingFenceRun(lines: readonly string[], char: '`' | '~'): number {
  let longest = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    let count = 0;
    while (trimmed[count] === char) count += 1;
    if (count >= 3) longest = Math.max(longest, count);
  }
  return longest;
}

export function pageHasMore(page: ChildrenPage): boolean {
  return page.offset + page.items.length < page.total;
}
