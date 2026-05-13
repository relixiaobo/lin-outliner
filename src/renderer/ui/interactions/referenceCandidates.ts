import type { NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { isContentNode, textOf } from '../shared';
import { getTreeReferenceBlockMessage, getTreeReferenceBlockReason } from './referenceRules';

export type ReferenceCandidate =
  | {
    type: 'date';
    key: 'today' | 'tomorrow' | 'yesterday';
    label: string;
    date: Date;
  }
  | {
    type: 'node';
    id: NodeId;
    label: string;
    breadcrumb: string;
    disabledReason: string | null;
  }
  | {
    type: 'create';
    label: string;
  };

const DATE_SHORTCUTS: Array<{
  key: 'today' | 'tomorrow' | 'yesterday';
  label: string;
  offset: number;
}> = [
  { key: 'today', label: 'Today', offset: 0 },
  { key: 'tomorrow', label: 'Tomorrow', offset: 1 },
  { key: 'yesterday', label: 'Yesterday', offset: -1 },
];

function dateWithOffset(offset: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date;
}

function dayLabel(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function matchDateShortcuts(query: string): ReferenceCandidate[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return DATE_SHORTCUTS
    .filter((shortcut) => shortcut.key.startsWith(normalized))
    .map((shortcut) => {
      const date = dateWithOffset(shortcut.offset);
      return {
        type: 'date',
        key: shortcut.key,
        label: `${shortcut.label} ${dayLabel(date)}`,
        date,
      };
    });
}

function breadcrumbFor(node: NodeProjection, byId: Map<NodeId, NodeProjection>): string {
  const parts: string[] = [];
  let currentId = node.parentId;
  while (currentId && parts.length < 3) {
    const parent = byId.get(currentId);
    if (!parent || parent.locked) break;
    const label = textOf(parent);
    if (label) parts.unshift(label);
    currentId = parent.parentId;
  }
  return parts.join(' / ');
}

function nodeCandidates(
  index: DocumentIndex,
  currentNodeId: NodeId,
  query: string,
  treeReferenceParentId: NodeId | null,
): ReferenceCandidate[] {
  const normalized = query.trim().toLowerCase();
  const candidates = index.projection.nodes
    .filter((node) => isContentNode(node) && node.id !== currentNodeId)
    .filter((node) => {
      if (!normalized) return true;
      return textOf(node).toLowerCase().includes(normalized);
    })
    .sort((a, b) => {
      if (!normalized && b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      return textOf(a).localeCompare(textOf(b), undefined, { sensitivity: 'base' });
    })
    .slice(0, normalized ? 8 : 5);

  return candidates.map((node) => {
    const reason = treeReferenceParentId
      ? getTreeReferenceBlockReason({
        parentId: treeReferenceParentId,
        targetId: node.id,
        byId: index.byId,
      })
      : null;
    return {
      type: 'node',
      id: node.id,
      label: textOf(node),
      breadcrumb: breadcrumbFor(node, index.byId),
      disabledReason: getTreeReferenceBlockMessage(reason),
    };
  });
}

export function buildReferenceCandidates(params: {
  index: DocumentIndex;
  currentNodeId: NodeId;
  query: string;
  treeReferenceParentId?: NodeId | null;
  allowCreate?: boolean;
}): ReferenceCandidate[] {
  const { index, currentNodeId, query, treeReferenceParentId = null, allowCreate = true } = params;
  const normalized = query.trim();
  return [
    ...matchDateShortcuts(normalized),
    ...nodeCandidates(index, currentNodeId, normalized, treeReferenceParentId),
    ...(normalized && allowCreate ? [{ type: 'create' as const, label: normalized }] : []),
  ];
}
