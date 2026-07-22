import {
  DAILY_NOTES_ID,
  SCHEMA_ID,
  SEARCHES_ID,
  TAG_DAY_ID,
  TAG_WEEK_ID,
  TAG_YEAR_ID,
  TRASH_ID,
  WORKSPACE_ID,
  type DocumentProjection,
  type NodeProjection,
} from '../../../core/types';
import { formatNodeReferenceMarker } from '../../../core/referenceMarkup';
import { richTextToMarkdownReferenceMarkup } from '../../../core/markdownRichText';
import { formatTag } from '../../../core/textSyntax';
import { projectFieldConfig, nodeIsDone, nodeShowsCheckbox } from '../../../core/configProjection';
import { isInternalConfigNode } from '../../../core/configSchema';
import { referencesForTarget, type ReferenceSource } from '../../../core/references';
import { systemFieldLabel } from '../../../core/systemFields';
import type {
  NodeBacklink,
  NodeFieldRead,
  NodeRef,
  OutlinerToolHost,
  ProjectionIndex,
} from './agentNodeToolTypes';
import { unique } from './agentNodeToolUtils';

const SYSTEM_IDS = new Set([
  WORKSPACE_ID,
  DAILY_NOTES_ID,
  SCHEMA_ID,
  SEARCHES_ID,
  TRASH_ID,
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
    .filter((child): child is Extract<NodeProjection, { type: 'fieldEntry' }> => child !== undefined && child.type === 'fieldEntry' && (includeDeleted || !isInTrash(index, child.id)))
    .map((fieldEntry) => {
      const fieldDef = fieldEntry.fieldDefId ? index.nodes.get(fieldEntry.fieldDefId) : undefined;
      const values = fieldEntry.children
        .map((valueId) => index.nodes.get(valueId))
        .filter((value): value is NodeProjection => value !== undefined && (includeDeleted || !isInTrash(index, value.id)))
        .map((value) => ({
          text: referenceText(index, value) ?? nodeContentText(value),
          valueNodeId: value.id,
          targetId: value.type === 'reference' ? value.targetId : undefined,
        }));
      const options = fieldDef?.children
        .map((optionId) => index.nodes.get(optionId))
        .filter((option): option is NodeProjection => Boolean(option) && !isInternalConfigNode(option!))
        .map((option) => option.content.text.trim())
        .filter((value): value is string => Boolean(value));
      return {
        name: fieldName(index, fieldEntry),
        type: fieldDef?.type === 'fieldDef' ? projectFieldConfig(index.nodes, fieldDef).fieldType : 'plain',
        values,
        fieldEntryId: fieldEntry.id,
        options: options && options.length ? options : undefined,
      };
    });
}

export function backlinks(index: ProjectionIndex, targetId: string, includeDeleted: boolean): NodeBacklink[] {
  return referencesForTarget(index.nodes, targetId, {
    isDeleted: includeDeleted ? undefined : (nodeId) => isInTrash(index, nodeId),
  }).filter(isLinkedReferenceSource).map((source) => {
    const sourceNode = index.nodes.get(source.sourceNodeId);
    const fieldEntry = source.fieldEntryId ? index.nodes.get(source.fieldEntryId) : undefined;
    return {
      sourceNodeId: source.sourceNodeId,
      sourceTitle: sourceNode ? nodeTitle(index, sourceNode) : source.sourceNodeId,
      kind: source.kind,
      snippet: source.kind === 'field' && fieldEntry
        ? fieldName(index, fieldEntry)
        : source.kind === 'inline' && sourceNode
          ? snippetFor(sourceNode, [source.inlineDisplayName ?? ''])
          : undefined,
    };
  });
}

function isLinkedReferenceSource(source: ReferenceSource): source is ReferenceSource & { kind: 'tree' | 'inline' | 'field' } {
  return source.kind !== 'unlinked';
}

export function normalChildIds(index: ProjectionIndex, nodeId: string, includeDeleted: boolean): string[] {
  const node = requiredNode(index, nodeId);
  return node.children.filter((childId) => {
    const child = index.nodes.get(childId);
    return Boolean(child)
      && child!.type !== 'fieldEntry'
      && !['queryCondition', 'viewDef', 'sortRule', 'filterRule', 'displayField', 'defConfig', 'systemOption'].includes(child!.type ?? '')
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
  return formatTag(name);
}

export function nodeTitle(index: ProjectionIndex, node: NodeProjection): string {
  if (node.type === 'reference' && node.targetId) {
    const target = index.nodes.get(node.targetId);
    if (target) return nodeTitle(index, target);
  }
  return nodeContentText(node) || '(untitled)';
}

export function nodeKind(node: NodeProjection): string {
  return node.type ?? 'node';
}

export function checkedState(index: ProjectionIndex, node: NodeProjection): boolean | null | undefined {
  if (nodeIsDone(node)) return true;
  if (nodeShowsCheckbox(index.nodes, node)) return false;
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
  const fieldDefId = fieldEntry.type === 'fieldEntry' ? fieldEntry.fieldDefId : undefined;
  const systemLabel = fieldDefId ? systemFieldLabel(fieldDefId) : null;
  if (systemLabel) return systemLabel;
  const fieldDef = fieldDefId ? index.nodes.get(fieldDefId) : undefined;
  return fieldDef?.content.text || fieldEntry.content.text || 'Field';
}

export function snippetFor(node: NodeProjection, queryTerms: string[]): string {
  const haystack = [nodeContentText(node), node.description ?? ''].join(' ').trim();
  if (!haystack) return '';
  const lower = haystack.toLowerCase();
  const term = queryTerms.map((value) => value.toLowerCase()).find((value) => value && lower.includes(value));
  if (!term) return haystack.slice(0, 160);
  const index = lower.indexOf(term);
  const start = Math.max(0, index - 60);
  const end = Math.min(haystack.length, index + term.length + 80);
  return `${start > 0 ? '...' : ''}${haystack.slice(start, end)}${end < haystack.length ? '...' : ''}`;
}

export function nodeContentText(node: NodeProjection): string {
  return richTextToMarkdownReferenceMarkup(node.content);
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
  return index.projection.nodes.find((node) => (
    node.type === 'tagDef'
    && !isInTrash(index, node.id)
    && node.content.text.trim().toLowerCase() === normalized
  ));
}

export function indexProjection(projection: DocumentProjection): ProjectionIndex {
  return {
    projection,
    nodes: new Map(projection.nodes.map((node) => [node.id, node])),
  };
}

export function projectionIndexForHost(host: OutlinerToolHost): ProjectionIndex {
  return host.getDocumentReadModel?.().asProjectionIndex() ?? indexProjection(host.getProjection());
}

export function projectionFingerprint(projection: DocumentProjection): string {
  return JSON.stringify(projection.nodes.map((node) => ({
    id: node.id,
    parentId: node.parentId,
    children: node.children,
    text: node.content.text,
    tags: node.tags,
    type: node.type,
    targetId: node.type === 'reference' ? node.targetId : undefined,
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
