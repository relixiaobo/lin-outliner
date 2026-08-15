import {
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { NodeId } from '../api/types';
import type { DocumentIndex } from './document';

interface DocumentIndexSubscription {
  readonly listener: () => void;
  readonly nodeIds: ReadonlySet<NodeId> | null;
}

/**
 * Stable access to the renderer's current document index.
 *
 * The projection object intentionally changes after every accepted delta. This
 * store lets consumers read the newest index without making that object identity
 * a React prop, and lets transcript leaves subscribe only to the nodes whose
 * titles or derived colors they actually render.
 */
export class DocumentIndexStore {
  private current: DocumentIndex;
  private readonly subscriptions = new Set<DocumentIndexSubscription>();

  constructor(initial: DocumentIndex) {
    this.current = initial;
  }

  getCurrent = (): DocumentIndex => this.current;

  commit(next: DocumentIndex): void {
    const previous = this.current;
    if (next === previous) return;
    this.current = next;
    for (const subscription of [...this.subscriptions]) {
      if (
        subscription.nodeIds === null
        || subscribedNodesChanged(previous, next, subscription.nodeIds)
      ) subscription.listener();
    }
  }

  subscribe(
    nodeIds: ReadonlySet<NodeId> | null,
    listener: () => void,
  ): () => void {
    const subscription = { listener, nodeIds };
    this.subscriptions.add(subscription);
    return () => this.subscriptions.delete(subscription);
  }
}

/**
 * Subscribe to every index commit (`nodeIds = null`) or to a bounded node set.
 * Inactive consumers retain their last snapshot and unsubscribe, so hiding the
 * Agent rail preserves component state without paying for document updates.
 */
export function useDocumentIndexSnapshot(
  store: DocumentIndexStore,
  nodeIds: readonly NodeId[] | ReadonlySet<NodeId> | null,
  active: boolean,
): DocumentIndex {
  const subscribedNodeIds = useMemo(
    () => nodeIds === null
      ? null
      : nodeIds instanceof Set
        ? nodeIds
        : new Set(nodeIds),
    [nodeIds],
  );
  const frozenRef = useRef(store.getCurrent());
  const previousActiveRef = useRef(active);
  const previousStoreRef = useRef(store);

  // Capture once at either activity boundary. While inactive, unrelated parent
  // renders continue to see the same object; reopening catches up atomically.
  if (
    active
    || previousActiveRef.current !== active
    || previousStoreRef.current !== store
  ) frozenRef.current = store.getCurrent();
  previousActiveRef.current = active;
  previousStoreRef.current = store;

  const subscribe = useCallback((listener: () => void) => (
    active ? store.subscribe(subscribedNodeIds, listener) : () => undefined
  ), [active, store, subscribedNodeIds]);
  const getSnapshot = useCallback(() => {
    if (active) frozenRef.current = store.getCurrent();
    return frozenRef.current;
  }, [active, store]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function subscribedNodesChanged(
  previous: DocumentIndex,
  next: DocumentIndex,
  nodeIds: ReadonlySet<NodeId>,
): boolean {
  for (const nodeId of nodeIds) {
    const previousRevision = previous.renderRev?.get(nodeId);
    const nextRevision = next.renderRev?.get(nodeId);
    if (previousRevision !== undefined || nextRevision !== undefined) {
      if (previousRevision !== nextRevision) return true;
      continue;
    }
    // `buildIndex` callers outside the live projection store do not carry
    // renderRev. Object identity is the correct fallback for those fixtures.
    if (previous.byId.get(nodeId) !== next.byId.get(nodeId)) return true;
  }
  return false;
}
