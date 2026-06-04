import type { NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { DEFAULT_MESSAGES, type Messages } from '../../../core/i18n';
import { isContentNode, textOf } from '../shared';
import { textMatchRank } from './candidateRanking';
import { isNodeInTrash } from './nodeLocation';
import { getTreeReferenceBlockMessage, getTreeReferenceBlockReason } from './referenceRules';

// Localized strings the candidate builder needs (it is a pure helper outside React).
// Callers thread these from useT(); they default to the canonical English tree so
// tests and any non-localized caller still work without baking literals here.
export interface ReferenceCandidateLabels {
  untitled: string;
  today: string;
  tomorrow: string;
  yesterday: string;
}

export function referenceCandidateLabels(t: Messages): ReferenceCandidateLabels {
  return {
    untitled: t.common.untitled,
    today: t.outliner.field.referenceDateToday,
    tomorrow: t.outliner.field.referenceDateTomorrow,
    yesterday: t.outliner.field.referenceDateYesterday,
  };
}

const DEFAULT_REFERENCE_LABELS = referenceCandidateLabels(DEFAULT_MESSAGES);

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
  offset: number;
}> = [
  { key: 'today', offset: 0 },
  { key: 'tomorrow', offset: 1 },
  { key: 'yesterday', offset: -1 },
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

export function matchDateShortcuts(query: string, labels: ReferenceCandidateLabels = DEFAULT_REFERENCE_LABELS): ReferenceCandidate[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return DATE_SHORTCUTS
    // Match on the stable key (locale-independent), not the displayed label.
    .filter((shortcut) => shortcut.key.startsWith(normalized))
    .map((shortcut) => {
      const date = dateWithOffset(shortcut.offset);
      return {
        type: 'date',
        key: shortcut.key,
        label: `${labels[shortcut.key]} ${dayLabel(date)}`,
        date,
      };
    });
}

function breadcrumbFor(node: NodeProjection, byId: Map<NodeId, NodeProjection>, untitled: string): string {
  const parts: string[] = [];
  let currentId = node.parentId;
  while (currentId && parts.length < 3) {
    const parent = byId.get(currentId);
    if (!parent || parent.locked) break;
    // Untitled ancestors still occupy a path segment — dropping them would collapse
    // `A / <untitled> / Target` to `A / Target`, making Target look like a child of A.
    parts.unshift(textOf(parent, untitled));
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
  labels: ReferenceCandidateLabels,
): ReferenceCandidate[] {
  const normalized = query.trim().toLowerCase();
  const currentNode = currentNodeId ? index.byId.get(currentNodeId) : undefined;
  const currentAncestors = ancestorIds(currentNode, index.byId);
  const candidates = index.projection.nodes
    .filter((node) => isContentNode(node)
      && !(excludeCurrentNode && node.id === currentNodeId)
      && !isNodeInTrash(index, node.id))
    .map((node) => {
      const label = textOf(node) || labels.untitled;
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
      breadcrumb: breadcrumbFor(node, index.byId, labels.untitled),
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
  // Localized labels; defaults to English so tests/non-localized callers still work.
  labels?: ReferenceCandidateLabels;
}): ReferenceCandidate[] {
  const {
    index,
    currentNodeId,
    query,
    treeReferenceParentId = null,
    allowCreate = true,
    excludeCurrentNode = true,
    labels = DEFAULT_REFERENCE_LABELS,
  } = params;
  const normalized = query.trim();
  return [
    ...matchDateShortcuts(normalized, labels),
    ...nodeCandidates(index, currentNodeId, normalized, treeReferenceParentId, excludeCurrentNode, labels),
    ...(normalized && allowCreate ? [{ type: 'create' as const, label: normalized }] : []),
  ];
}
