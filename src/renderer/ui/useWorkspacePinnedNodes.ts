import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentProjection, NodeId } from '../api/types';

const STORAGE_KEY = 'lin-outliner:workspace-layout:v3:pinned';
const STORAGE_VERSION = 1;
const MAX_PINNED_NODES = 100;

interface PersistedPinnedNodes {
  version: typeof STORAGE_VERSION;
  nodeIds: NodeId[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sanitizePinnedNodeIds(value: unknown, liveNodeIds: Set<NodeId>): NodeId[] {
  const rawNodeIds = Array.isArray(value)
    ? value
    : isRecord(value) && value.version === STORAGE_VERSION && Array.isArray(value.nodeIds)
      ? value.nodeIds
      : [];
  const seen = new Set<NodeId>();
  const nodeIds: NodeId[] = [];
  for (const nodeId of rawNodeIds) {
    if (typeof nodeId !== 'string' || !liveNodeIds.has(nodeId) || seen.has(nodeId)) continue;
    seen.add(nodeId);
    nodeIds.push(nodeId);
    if (nodeIds.length >= MAX_PINNED_NODES) break;
  }
  return nodeIds;
}

function loadPinnedNodeIds(liveNodeIds: Set<NodeId>): NodeId[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return sanitizePinnedNodeIds(JSON.parse(raw) as unknown, liveNodeIds);
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

export function useWorkspacePinnedNodes(projection: DocumentProjection | null) {
  const liveNodeIds = useMemo(() => new Set(projection?.nodes.map((node) => node.id) ?? []), [projection]);
  const [pinnedNodeIds, setPinnedNodeIds] = useState<NodeId[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!projection) return;
    if (!initializedRef.current) {
      const loaded = loadPinnedNodeIds(liveNodeIds);
      initializedRef.current = true;
      setPinnedNodeIds(loaded);
      setHydrated(true);
      return;
    }
    setPinnedNodeIds((current) => {
      const source = current;
      const sanitized = sanitizePinnedNodeIds(source, liveNodeIds);
      if (!sameNodeIds(source, sanitized)) persistPinnedNodeIds(sanitized);
      return sameNodeIds(current, sanitized) ? current : sanitized;
    });
  }, [liveNodeIds, projection]);

  useEffect(() => {
    if (!hydrated) return;
    persistPinnedNodeIds(pinnedNodeIds);
  }, [hydrated, pinnedNodeIds]);

  const pinNode = useCallback((nodeId: NodeId) => {
    if (!liveNodeIds.has(nodeId)) return;
    setPinnedNodeIds((current) => {
      if (current.includes(nodeId)) return current;
      return [...current, nodeId].slice(-MAX_PINNED_NODES);
    });
  }, [liveNodeIds]);

  const unpinNode = useCallback((nodeId: NodeId) => {
    setPinnedNodeIds((current) => current.filter((pinnedNodeId) => pinnedNodeId !== nodeId));
  }, []);

  const togglePin = useCallback((nodeId: NodeId) => {
    if (!liveNodeIds.has(nodeId)) return;
    setPinnedNodeIds((current) => (
      current.includes(nodeId)
        ? current.filter((pinnedNodeId) => pinnedNodeId !== nodeId)
        : [...current, nodeId].slice(-MAX_PINNED_NODES)
    ));
  }, [liveNodeIds]);

  const isNodePinned = useCallback((nodeId: NodeId) => pinnedNodeIds.includes(nodeId), [pinnedNodeIds]);

  return {
    isNodePinned,
    pinNode,
    pinnedNodeIds,
    togglePin,
    unpinNode,
  };
}
