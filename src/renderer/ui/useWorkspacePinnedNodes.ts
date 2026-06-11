import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NodeId } from '../api/types';
import type { DocumentIndex } from '../state/document';
import { isRecord } from '../state/persistence';

const STORAGE_KEY = 'lin-outliner:workspace-layout:v3:pinned';
const STORAGE_VERSION = 1;
const MAX_PINNED_NODES = 100;

interface PersistedPinnedNodes {
  version: typeof STORAGE_VERSION;
  nodeIds: NodeId[];
}

function sanitizePinnedNodeIds(value: unknown, hasNodeId: (nodeId: NodeId) => boolean): NodeId[] {
  const rawNodeIds = Array.isArray(value)
    ? value
    : isRecord(value) && value.version === STORAGE_VERSION && Array.isArray(value.nodeIds)
      ? value.nodeIds
      : [];
  const seen = new Set<NodeId>();
  const nodeIds: NodeId[] = [];
  for (const nodeId of rawNodeIds) {
    if (typeof nodeId !== 'string' || !hasNodeId(nodeId) || seen.has(nodeId)) continue;
    seen.add(nodeId);
    nodeIds.push(nodeId);
    if (nodeIds.length >= MAX_PINNED_NODES) break;
  }
  return nodeIds;
}

function loadPinnedNodeIds(hasNodeId: (nodeId: NodeId) => boolean): NodeId[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return sanitizePinnedNodeIds(JSON.parse(raw) as unknown, hasNodeId);
  } catch {
    return [];
  }
}

function persistPinnedNodeIds(nodeIds: readonly NodeId[]) {
  const payload: PersistedPinnedNodes = {
    version: STORAGE_VERSION,
    nodeIds: [...nodeIds],
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort UI state only.
  }
}

function sameNodeIds(a: readonly NodeId[], b: readonly NodeId[]): boolean {
  return a.length === b.length && a.every((nodeId, index) => nodeId === b[index]);
}

export function useWorkspacePinnedNodes(byId: DocumentIndex['byId'] | null) {
  const [pinnedNodeIds, setPinnedNodeIds] = useState<NodeId[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!byId) return;
    const hasNodeId = (nodeId: NodeId) => byId.has(nodeId);
    if (!initializedRef.current) {
      const loaded = loadPinnedNodeIds(hasNodeId);
      initializedRef.current = true;
      setPinnedNodeIds(loaded);
      setHydrated(true);
      return;
    }
    setPinnedNodeIds((current) => {
      const sanitized = sanitizePinnedNodeIds(current, hasNodeId);
      return sameNodeIds(current, sanitized) ? current : sanitized;
    });
  }, [byId]);

  useEffect(() => {
    if (!hydrated) return;
    persistPinnedNodeIds(pinnedNodeIds);
  }, [hydrated, pinnedNodeIds]);

  const togglePin = useCallback((nodeId: NodeId) => {
    if (!byId?.has(nodeId)) return;
    setPinnedNodeIds((current) => (
      current.includes(nodeId)
        ? current.filter((pinnedNodeId) => pinnedNodeId !== nodeId)
        : [...current, nodeId].slice(-MAX_PINNED_NODES)
    ));
  }, [byId]);

  // Insert a node into the pinned list at a specific position. Handles both adding a
  // new pin (drag from the outline) and reordering an existing one (drag within the
  // list): the node is removed first, then re-inserted, with `index` interpreted
  // against the CURRENT list so a same-list move lands where the insertion line showed.
  const pinNodeAtIndex = useCallback((nodeId: NodeId, index: number) => {
    if (!byId?.has(nodeId)) return;
    setPinnedNodeIds((current) => {
      const currentIndex = current.indexOf(nodeId);
      const without = current.filter((pinnedNodeId) => pinnedNodeId !== nodeId);
      let target = index;
      if (currentIndex !== -1 && currentIndex < index) target -= 1;
      target = Math.max(0, Math.min(target, without.length));
      if (currentIndex === target && currentIndex !== -1) return current;
      const next = [...without.slice(0, target), nodeId, ...without.slice(target)];
      return next.slice(0, MAX_PINNED_NODES);
    });
  }, [byId]);

  const pinnedNodeIdSet = useMemo(() => new Set(pinnedNodeIds), [pinnedNodeIds]);
  const isNodePinned = useCallback((nodeId: NodeId) => pinnedNodeIdSet.has(nodeId), [pinnedNodeIdSet]);

  return {
    isNodePinned,
    pinNodeAtIndex,
    pinnedNodeIds,
    togglePin,
  };
}
