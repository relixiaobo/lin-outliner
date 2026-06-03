import type { NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { isContentNode, textOf } from '../shared';
import { textMatchRank } from './candidateRanking';
import { isNodeInTrash } from './nodeLocation';
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

const DEFAULT_REFERENCE_LIMIT = 24;

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

function ancestorIds(node: NodeProjection | undefined, byId: Map<NodeId, NodeProjection>): Set<NodeId> {
  const ids = new Set<NodeId>();
  let currentId = node?.parentId;
  while (currentId) {
    ids.add(currentId);
    const current = byId.get(currentId);
    if (!current) break;
    currentId = current.parentId;
  }
  return ids;
}

function contextRank(
  node: NodeProjection,
  currentNode: NodeProjection | undefined,
  currentAncestors: Set<NodeId>,
): number {
  if (!currentNode) return 3;
  if (node.parentId && node.parentId === currentNode.parentId) return 0;
  if (currentAncestors.has(node.id)) return 1;
  if (node.parentId && currentAncestors.has(node.parentId)) return 2;
  return 3;
}

function nodeCandidates(
  index: DocumentIndex,
  currentNodeId: NodeId | null,
  query: string,
  treeReferenceParentId: NodeId | null,
  excludeCurrentNode: boolean,
): ReferenceCandidate[] {
  const normalized = query.trim().toLowerCase();
  const currentNode = currentNodeId ? index.byId.get(currentNodeId) : undefined;
  const currentAncestors = ancestorIds(currentNode, index.byId);
  const candidates = index.projection.nodes
    .filter((node) => isContentNode(node)
      && !(excludeCurrentNode && node.id === currentNodeId)
      && !isNodeInTrash(index, node.id))
    .map((node) => {
      const label = textOf(node);
      const rawText = node.content.text.trim();
      const reason = treeReferenceParentId
        ? getTreeReferenceBlockReason({
          parentId: treeReferenceParentId,
          targetId: node.id,
          byId: index.byId,
        })
        : null;
      return {
        node,
        label,
        normalizedLabel: label.toLowerCase(),
        disabledReason: reason === 'already_in_parent' ? null : getTreeReferenceBlockMessage(reason),
        isUntitled: rawText.length === 0,
        contextRank: contextRank(node, currentNode, currentAncestors),
      };
    })
    .map((candidate) => ({
      ...candidate,
      rank: textMatchRank(candidate.normalizedLabel, normalized),
    }))
    .filter((candidate) => candidate.rank !== null)
    .sort((left, right) => {
      if (left.rank !== right.rank) return (left.rank ?? 0) - (right.rank ?? 0);
      if (Boolean(left.disabledReason) !== Boolean(right.disabledReason)) {
        return left.disabledReason ? 1 : -1;
      }
      if (left.isUntitled !== right.isUntitled) return left.isUntitled ? 1 : -1;
      if (left.contextRank !== right.contextRank) return left.contextRank - right.contextRank;
      if (normalized && left.label.length !== right.label.length) return left.label.length - right.label.length;
      if (left.node.updatedAt !== right.node.updatedAt) return right.node.updatedAt - left.node.updatedAt;
      return left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
    })
    .slice(0, DEFAULT_REFERENCE_LIMIT);

  return candidates.map((candidate) => {
    const { node } = candidate;
    return {
      type: 'node',
      id: node.id,
      label: candidate.label,
      breadcrumb: breadcrumbFor(node, index.byId),
      disabledReason: candidate.disabledReason,
    };
  });
}

export function buildReferenceCandidates(params: {
  index: DocumentIndex;
  currentNodeId: NodeId | null;
  query: string;
  treeReferenceParentId?: NodeId | null;
  allowCreate?: boolean;
  // The outliner mentions from inside a node, so it excludes that node from its
  // own results (you can't reference yourself). The agent composer is not a node
  // and has no "self" — it passes false so the focused/context node stays
  // mentionable. Defaults to true to preserve the outliner contract.
  excludeCurrentNode?: boolean;
}): ReferenceCandidate[] {
  const {
    index,
    currentNodeId,
    query,
    treeReferenceParentId = null,
    allowCreate = true,
    excludeCurrentNode = true,
  } = params;
  const normalized = query.trim();
  return [
    ...matchDateShortcuts(normalized),
    ...nodeCandidates(index, currentNodeId, normalized, treeReferenceParentId, excludeCurrentNode),
    ...(normalized && allowCreate ? [{ type: 'create' as const, label: normalized }] : []),
  ];
}
