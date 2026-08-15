import {
  createUnlinkedReferenceMatcher,
  type ReferenceSource,
} from '../../core/references';
import type { NodeId } from '../api/types';
import type { DocumentIndex } from './document';

const DEFAULT_CHUNK_SIZE = 64;

export interface CooperativeReferenceScanOptions {
  readonly chunkSize?: number;
  readonly signal?: AbortSignal;
  readonly yieldControl?: () => Promise<void>;
}

export async function scanUnlinkedReferenceSources(
  index: DocumentIndex,
  targetId: NodeId,
  options: CooperativeReferenceScanOptions = {},
): Promise<readonly ReferenceSource[] | null> {
  const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const yieldControl = options.yieldControl ?? yieldToRenderer;
  const matcher = createUnlinkedReferenceMatcher(index.byId, {
    includeUnlinked: true,
    mentionTargetIds: [targetId],
    isDeleted: (nodeId) => index.trashNodeIds.has(nodeId),
  });
  const sources: ReferenceSource[] = [];
  const nodes = index.byId.values();

  // The caller starts this from a debounced effect. Yield once more before the
  // first batch so even task submission cannot put a document walk in an input
  // event's synchronous continuation.
  await yieldControl();
  if (options.signal?.aborted) return null;

  let exhausted = false;
  while (!exhausted) {
    for (let count = 0; count < chunkSize; count += 1) {
      const next = nodes.next();
      if (next.done) {
        exhausted = true;
        break;
      }
      for (const source of matcher.matchNode(next.value)) {
        if (source.targetId === targetId) sources.push(source);
      }
    }
    if (!exhausted) {
      await yieldControl();
      if (options.signal?.aborted) return null;
    }
  }
  return sources;
}

function yieldToRenderer(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
