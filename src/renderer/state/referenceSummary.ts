import { buildReferenceSummary, type ReferenceSummary } from '../../core/references';
import { nodeIsInSubtree } from '../../core/treeUtils';
import type { NodeId, NodeProjection } from '../api/types';
import type { DocumentIndex } from './document';

const summaryCache = new WeakMap<ReadonlyMap<NodeId, NodeProjection>, ReferenceSummary>();
const targetSummaryCache = new WeakMap<ReadonlyMap<NodeId, NodeProjection>, Map<NodeId, ReferenceSummary>>();

export function referenceSummaryForIndex(index: DocumentIndex): ReferenceSummary {
  const cached = summaryCache.get(index.byId);
  if (cached) return cached;

  const summary = buildReferenceSummary(index.byId, {
    isDeleted: (nodeId) => nodeIsInSubtree(index.byId, nodeId, index.projection.trashId),
  });
  summaryCache.set(index.byId, summary);
  return summary;
}

export function referenceSummaryForExpandedTarget(index: DocumentIndex, targetId: NodeId): ReferenceSummary {
  const summariesByTarget = targetSummaryCache.get(index.byId);
  const cached = summariesByTarget?.get(targetId);
  if (cached) return cached;

  const summary = buildReferenceSummary(index.byId, {
    includeUnlinked: true,
    mentionTargetIds: [targetId],
    isDeleted: (nodeId) => nodeIsInSubtree(index.byId, nodeId, index.projection.trashId),
  });
  const nextSummariesByTarget = summariesByTarget ?? new Map<NodeId, ReferenceSummary>();
  nextSummariesByTarget.set(targetId, summary);
  targetSummaryCache.set(index.byId, nextSummariesByTarget);
  return summary;
}
