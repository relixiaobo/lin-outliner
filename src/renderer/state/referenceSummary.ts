import { buildReferenceSummary, type ReferenceSummary } from '../../core/references';
import { nodeIsInSubtree } from '../../core/treeUtils';
import type { NodeId, NodeProjection } from '../api/types';
import type { DocumentIndex } from './document';

const summaryCache = new WeakMap<ReadonlyMap<NodeId, NodeProjection>, ReferenceSummary>();

export function referenceSummaryForIndex(index: DocumentIndex): ReferenceSummary {
  const cached = summaryCache.get(index.byId);
  if (cached) return cached;

  const summary = buildReferenceSummary(index.byId, {
    includeUnlinked: true,
    isDeleted: (nodeId) => nodeIsInSubtree(index.byId, nodeId, index.projection.trashId),
  });
  summaryCache.set(index.byId, summary);
  return summary;
}
