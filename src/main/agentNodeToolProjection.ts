import {
  DAILY_NOTES_ID,
  SCHEMA_ID,
  SEARCHES_ID,
  SETTINGS_ID,
  TAG_DAY_ID,
  TAG_WEEK_ID,
  TAG_YEAR_ID,
  TRASH_ID,
  WORKSPACE_ID,
  type DocumentProjection,
  type NodeProjection,
} from '../core/types';
import { formatNodeReferenceMarker } from '../core/nodeReferenceMarkup';
import type {
  NodeBacklink,
  NodeFieldRead,
  NodeRef,
  ProjectionIndex,
} from './agentNodeToolTypes';
import { unique } from './agentNodeToolUtils';

const SYSTEM_IDS = new Set([
  WORKSPACE_ID,
  DAILY_NOTES_ID,
  SCHEMA_ID,
  SEARCHES_ID,
  TRASH_ID,
  SETTINGS_ID,
  TAG_DAY_ID,
  TAG_WEEK_ID,
  TAG_YEAR_ID,
]);

export function isSystemNodeId(nodeId: string): boolean {
  return SYSTEM_IDS.has(nodeId);
}

export function fieldReads(index: ProjectionIndex, node: NodeProjection, includeDeleted: boolean): NodeFieldRead[] {
  return node.children
    .map((childId) => index.nodes.get(childId))
    .filter((child): child is NodeProjection => child !== undefined && child.type === 'fieldEntry' && (includeDeleted || !isInTrash(index, child.id)))
    .map((fieldEntry) => {
      const fieldDef = fieldEntry.fieldDefId ? index.nodes.get(fieldEntry.fieldDefId) : undefined;
      const values = fieldEntry.children
        .map((valueId) => index.nodes.get(valueId))
        .filter((value): value is NodeProjection => value !== undefined && (includeDeleted || !isInTrash(index, value.id)))
        .map((value) => ({
          text: referenceText(index, value) ?? value.content.text,
          valueNodeId: value.id,
          targetId: value.targetId,
        }));
      const options = fieldDef?.children
        .map((optionId) => index.nodes.get(optionId)?.content.text.trim())
        .filter((value): value is string => Boolean(value));
      return {
        name: fieldDef?.content.text || fieldEntry.content.text || 'Field',
        type: fieldDef?.fieldType ?? fieldEntry.fieldType ?? 'plain',
        values,
        fieldEntryId: fieldEntry.id,
        options: options && options.length ? options : undefined,
      };
    });
}

export function backlinks(index: ProjectionIndex, targetId: string, includeDeleted: boolean): NodeBacklink[] {
  const result: NodeBacklink[] = [];
  for (const node of index.projection.nodes) {
    if (!includeDeleted && isInTrash(index, node.id)) continue;
    if (node.type === 'reference' && node.targetId === targetId) {
      const parent = node.parentId ? index.nodes.get(node.parentId) : undefined;
      const source = parent && parent.type === 'fieldEntry' && parent.parentId ? index.nodes.get(parent.parentId) : parent;
      result.push({
        sourceNodeId: source?.id ?? node.id,
        sourceTitle: source ? nodeTitle(index, source) : nodeTitle(index, node),
        kind: parent?.type === 'fieldEntry' ? 'field' : 'tree',
        snippet: parent?.type === 'fieldEntry' ? fieldName(index, parent) : undefined,
      });
    }
    for (const inlineRef of node.content.inlineRefs) {
      if (inlineRef.targetNodeId === targetId) {
        result.push({
          sourceNodeId: node.id,
          sourceTitle: nodeTitle(index, node),
          kind: 'inline',
          snippet: snippetFor(node, [inlineRef.displayName ?? '']),
        });
      }
    }
  }
  return result;
}

export function normalChildIds(index: ProjectionIndex, nodeId: string, includeDeleted: boolean): string[] {
  const node = requiredNode(index, nodeId);
  return node.children.filter((childId) => {
    const child = index.nodes.get(childId);
    return Boolean(child)
      && child!.type !== 'fieldEntry'
      && !['queryCondition', 'viewDef', 'sortRule', 'filterRule', 'displayField'].includes(child!.type ?? '')
      && (includeDeleted || !isInTrash(index, childId));
  });
}

export function tagLabels(index: ProjectionIndex, node: NodeProjection): string[] {
  return node.tags.map((tagId) => tagLabel(index.nodes.get(tagId))).filter((tag): tag is string => Boolean(tag));
}

export function tagLabel(node: NodeProjection | undefined): string | null {
  if (!node) return null;
  const name = node.content.text.trim();
  if (!name) return null;
  return /^[\w-]+$/.test(name) ? `#${name}` : `#[[${name}]]`;
}

export function nodeTitle(index: ProjectionIndex, node: NodeProjection): string {
  if (node.type === 'reference' && node.targetId) {
    const target = index.nodes.get(node.targetId);
    if (target) return nodeTitle(index, target);
  }
  return node.content.text || '(untitled)';
}

export function nodeKind(node: NodeProjection): string {
  return node.type ?? 'node';
}

export function checkedState(node: NodeProjection): boolean | null | undefined {
  if (node.completedAt) return true;
  if (node.showCheckbox) return false;
  return undefined;
}

export function parentRef(index: ProjectionIndex, node: NodeProjection): NodeRef | null {
  if (!node.parentId) return null;
  const parent = index.nodes.get(node.parentId);
  return parent ? { nodeId: parent.id, title: nodeTitle(index, parent) } : null;
}

export function breadcrumb(index: ProjectionIndex, nodeId: string): NodeRef[] {
  const items: NodeRef[] = [];
  let current = index.nodes.get(nodeId);
  const visited = new Set<string>();
  while (current?.parentId && !visited.has(current.parentId)) {
    visited.add(current.parentId);
    const parent = index.nodes.get(current.parentId);
    if (!parent) break;
    items.push({ nodeId: parent.id, title: nodeTitle(index, parent) });
    current = parent;
  }
  return items.reverse();
}

export function referenceText(index: ProjectionIndex, node: NodeProjection): string | null {
  if (node.type !== 'reference' || !node.targetId) return null;
  const target = index.nodes.get(node.targetId);
  const display = target ? nodeTitle(index, target) : node.targetId;
  return formatNodeReferenceMarker(display, node.targetId);
}

export function fieldName(index: ProjectionIndex, fieldEntry: NodeProjection): string {
  const fieldDef = fieldEntry.fieldDefId ? index.nodes.get(fieldEntry.fieldDefId) : undefined;
  return fieldDef?.content.text || fieldEntry.content.text || 'Field';
}

export function snippetFor(node: NodeProjection, queryTerms: string[]): string {
  const haystack = [node.content.text, node.description ?? ''].join(' ').trim();
  if (!haystack) return '';
  const lower = haystack.toLowerCase();
  const term = queryTerms.map((value) => value.toLowerCase()).find((value) => value && lower.includes(value));
  if (!term) return haystack.slice(0, 160);
  const index = lower.indexOf(term);
  const start = Math.max(0, index - 60);
  const end = Math.min(haystack.length, index + term.length + 80);
  return `${start > 0 ? '...' : ''}${haystack.slice(start, end)}${end < haystack.length ? '...' : ''}`;
}

export function scoreTerm(index: ProjectionIndex, node: NodeProjection, term: string): number {
  const q = term.trim().toLowerCase();
  if (!q) return 0;
  let score = 0;
  const text = node.content.text.toLowerCase();
  if (text === q) score += 100;
  else if (text.startsWith(q)) score += 60;
  else if (text.includes(q)) score += 30;
  if (node.description?.toLowerCase().includes(q)) score += 15;
  for (const tag of tagLabels(index, node)) {
    if (tag.toLowerCase().includes(q)) score += 15;
  }
  for (const field of fieldReads(index, node, false)) {
    if (field.name.toLowerCase().includes(q)) score += 8;
    for (const value of field.values) {
      if (value.text.toLowerCase().includes(q)) score += 10;
    }
  }
  return score;
}

export function isSearchCandidate(index: ProjectionIndex, nodeId: string): boolean {
  const node = index.nodes.get(nodeId);
  if (!node) return false;
  return !isInTrash(index, nodeId)
    && !SYSTEM_IDS.has(nodeId)
    && (node.type === undefined || ['tagDef', 'fieldDef', 'search', 'codeBlock'].includes(node.type));
}

export function isInTrash(index: ProjectionIndex, nodeId: string): boolean {
  if (nodeId === TRASH_ID) return true;
  let current = index.nodes.get(nodeId)?.parentId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    if (current === TRASH_ID) return true;
    visited.add(current);
    current = index.nodes.get(current)?.parentId;
  }
  return false;
}

export function findTagByName(index: ProjectionIndex, tagName: string): NodeProjection | undefined {
  const normalized = tagName.trim().toLowerCase();
  return index.projection.nodes.find((node) => node.type === 'tagDef' && node.content.text.trim().toLowerCase() === normalized);
}

export function indexProjection(projection: DocumentProjection): ProjectionIndex {
  return {
    projection,
    nodes: new Map(projection.nodes.map((node) => [node.id, node])),
  };
}

export function projectionFingerprint(projection: DocumentProjection): string {
  return JSON.stringify(projection.nodes.map((node) => ({
    id: node.id,
    parentId: node.parentId,
    children: node.children,
    text: node.content.text,
    tags: node.tags,
    type: node.type,
    targetId: node.targetId,
    updatedAt: node.updatedAt,
  })));
}

export function changedNodeIds(before: DocumentProjection, after: DocumentProjection): string[] {
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
  const afterById = new Map(after.nodes.map((node) => [node.id, node]));
  const ids = unique([...beforeById.keys(), ...afterById.keys()]);
  return ids.filter((id) => JSON.stringify(beforeById.get(id)) !== JSON.stringify(afterById.get(id)));
}

export function requiredNode(index: ProjectionIndex, nodeId: string): NodeProjection {
  const node = index.nodes.get(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

export function revisionOf(node: NodeProjection): string {
  return `${node.id}:${node.updatedAt}`;
}
