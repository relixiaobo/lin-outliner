import {
  buildReferenceSummary,
  type ReferenceSource,
  type ReferenceSummary,
} from '../../core/references';
import { isContentBearingNode } from '../../core/types';
import { inlineRefNodeId, type NodeId, type NodeProjection } from '../api/types';
import { SparseProjectionMap } from './sparseProjectionMap';

export function buildLinkedReferenceSummary(
  byId: ReadonlyMap<NodeId, NodeProjection>,
  trashNodeIds: ReadonlySet<NodeId>,
): ReferenceSummary {
  return sparseSummary(buildReferenceSummary(byId, {
    isDeleted: (nodeId) => trashNodeIds.has(nodeId),
  }));
}

export function patchLinkedReferenceSummary(params: {
  readonly previous: ReferenceSummary;
  readonly previousById: ReadonlyMap<NodeId, NodeProjection>;
  readonly nextById: ReadonlyMap<NodeId, NodeProjection>;
  readonly changedNodes: readonly NodeProjection[];
  readonly trashNodeIds: ReadonlySet<NodeId>;
  readonly rebuild: boolean;
}): ReferenceSummary {
  if (params.rebuild) return buildLinkedReferenceSummary(params.nextById, params.trashNodeIds);

  const patches = new Map<NodeId, readonly ReferenceSource[]>();
  for (const node of params.changedNodes) {
    const previous = params.previousById.get(node.id);
    if (!previous || sameInlineReferencePresentation(previous, node)) continue;

    const replacementsByTarget = inlineSourcesByTarget(node);
    for (const targetId of new Set(inlineReferenceTargetIds(node))) {
      const current = patches.get(targetId) ?? params.previous.byTarget.get(targetId) ?? [];
      const replacements = replacementsByTarget.get(targetId) ?? [];
      let replacementIndex = 0;
      const next = current.map((source) => {
        if (source.kind !== 'inline' || source.referenceNodeId !== node.id) return source;
        return replacements[replacementIndex++] ?? source;
      });
      patches.set(targetId, next);
    }
  }
  if (patches.size === 0) return params.previous;

  return {
    byTarget: SparseProjectionMap.fromReadonlyMap(params.previous.byTarget).patch([...patches], []),
    countsByTarget: params.previous.countsByTarget,
  };
}

function sparseSummary(summary: ReferenceSummary): ReferenceSummary {
  return {
    byTarget: SparseProjectionMap.fromReadonlyMap(summary.byTarget),
    countsByTarget: SparseProjectionMap.fromReadonlyMap(summary.countsByTarget),
  };
}

function inlineSourcesByTarget(node: NodeProjection): Map<NodeId, ReferenceSource[]> {
  const result = new Map<NodeId, ReferenceSource[]>();
  if (!isContentBearingNode(node)) return result;
  for (const inlineRef of node.content.inlineRefs) {
    const targetId = inlineRefNodeId(inlineRef);
    if (!targetId) continue;
    const sources = result.get(targetId) ?? [];
    sources.push({
      targetId,
      sourceNodeId: node.id,
      referenceNodeId: node.id,
      kind: 'inline',
      inlineDisplayName: inlineRef.displayName,
    });
    result.set(targetId, sources);
  }
  return result;
}

function inlineReferenceTargetIds(node: NodeProjection): NodeId[] {
  if (!isContentBearingNode(node)) return [];
  return node.content.inlineRefs.flatMap((inlineRef) => {
    const targetId = inlineRefNodeId(inlineRef);
    return targetId ? [targetId] : [];
  });
}

function sameInlineReferencePresentation(left: NodeProjection, right: NodeProjection): boolean {
  if (!isContentBearingNode(left) || !isContentBearingNode(right)) return left.type === right.type;
  if (left.content.inlineRefs.length !== right.content.inlineRefs.length) return false;
  for (let index = 0; index < left.content.inlineRefs.length; index += 1) {
    const leftRef = left.content.inlineRefs[index]!;
    const rightRef = right.content.inlineRefs[index]!;
    if (
      inlineRefNodeId(leftRef) !== inlineRefNodeId(rightRef)
      || leftRef.displayName !== rightRef.displayName
    ) return false;
  }
  return true;
}
