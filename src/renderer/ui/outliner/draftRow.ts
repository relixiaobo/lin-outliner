import { useRef } from 'react';
import type { NodeId, NodeProjection } from '../../api/types';
import { EMPTY_RICH_TEXT } from '../../api/types';
import { freshNodeId } from '../../../core/nodeId';

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
export function makeDraftNode(id: NodeId, parentId: NodeId): NodeProjection {
  const now = Date.now();
  return {
    id,
    parentId,
    children: [],
    content: EMPTY_RICH_TEXT,
    tags: [],
    createdAt: now,
    updatedAt: now,
    locked: false,
    doneStateEnabled: false,
    autoCollected: false,
  };
}

/**
 * A stable client id for a parent's trailing draft row. It survives re-renders
 * (so React keeps the draft's editor mounted), and is regenerated once the draft
 * materializes — its id then belongs to a real node in `byId`, so the next draft
 * needs a fresh id. Also resets when the owning parent changes.
 */
export function useTrailingDraftId(parentId: NodeId, byId: Map<NodeId, NodeProjection>): NodeId {
  const idRef = useRef<NodeId | null>(null);
  const parentRef = useRef<NodeId>(parentId);
  if (idRef.current === null || parentRef.current !== parentId || byId.has(idRef.current)) {
    idRef.current = freshNodeId();
    parentRef.current = parentId;
  }
  return idRef.current;
}
