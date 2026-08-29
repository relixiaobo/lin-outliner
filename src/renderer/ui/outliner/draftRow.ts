import { useRef } from 'react';
import type { ContentBearingNodeProjection, NodeId, NodeProjection, RichText } from '../../api/types';
import { EMPTY_RICH_TEXT } from '../../api/types';
import { freshNodeId } from '../../../core/nodeId';

export type PendingDraftPolicy = 'advance' | 'retain';

// A renderer-only trailing "draft" row is an `OutlinerItem` whose node does not
// exist in the projection yet. To make eager materialization seamless, the draft
// row carries the exact `node:<uuid>` it will be persisted under from birth, so
// when the user types and we `createNode` under that id, React keeps the same
// component (and its ProseMirror view) mounted — IME is never interrupted.

/**
 * Synthesize a minimal plain-content `NodeProjection` for a draft row. It flows
 * through `OutlinerItem`'s normal render path (so the editor sits in the same
 * JSX position before and after materialization), but contributes nothing to
 * the projection, search, or agent context until the user types.
 */
export function makeDraftNode(
  id: NodeId,
  parentId: NodeId,
  content: RichText = EMPTY_RICH_TEXT,
): ContentBearingNodeProjection {
  const now = Date.now();
  return {
    id,
    parentId,
    children: [],
    content,
    tags: [],
    createdAt: now,
    updatedAt: now,
    locked: false,
    autoCollected: false,
  };
}

/**
 * A stable client id for a parent's trailing draft row. It survives re-renders
 * (so React keeps the draft's editor mounted), and is regenerated once the draft
 * materializes — its id then belongs to a real node in `byId`, so the next draft
 * needs a fresh id. Also resets when the owning parent changes.
 */
export function useTrailingDraftId(
  ownerKey: NodeId,
  byId: Map<NodeId, NodeProjection>,
  reservedIds?: ReadonlySet<NodeId>,
  pendingPolicy: PendingDraftPolicy = 'advance',
): NodeId {
  const idRef = useRef<NodeId | null>(null);
  const ownerRef = useRef<NodeId>(ownerKey);
  if (
    idRef.current === null
    || ownerRef.current !== ownerKey
    || shouldMintNextDraftId(
      idRef.current,
      byId,
      reservedIds?.has(idRef.current) === true,
      pendingPolicy,
    )
  ) {
    idRef.current = freshNodeId();
    ownerRef.current = ownerKey;
  }
  return idRef.current;
}

export function shouldMintNextDraftId(
  id: NodeId,
  byId: ReadonlyMap<NodeId, NodeProjection>,
  reserved: boolean,
  pendingPolicy: PendingDraftPolicy,
): boolean {
  return byId.has(id) || (pendingPolicy === 'advance' && reserved);
}
