import type { NodeId, NodeProjection } from '../api/types';
import {
  localStorageOrNull,
  pruneLocalStorageEntries,
  readLocalStorageKeyedStore,
  writeLocalStorageKeyedStore,
} from './localStorageStore';
import { hiddenFieldKey } from './outlinerRows';
import { isRecord } from './persistence';

const STORAGE_KEY = 'lin-outliner:outline-view-state:v1';
const STORE_VERSION = 1;
const MAX_ROOT_STATES = 500;

interface PersistedOutlineRootState {
  expandedNodeIds: NodeId[];
  expandedHiddenFieldKeys: string[];
  updatedAt: number;
}

interface PersistedOutlineViewStateStore {
  version: typeof STORE_VERSION;
  byRootNodeId: Record<NodeId, PersistedOutlineRootState>;
}

interface OutlineScope {
  nodeIds: Set<NodeId>;
  hiddenFieldKeys: Set<string>;
}

export interface OutlineExpansionInput {
  expanded: ReadonlySet<NodeId>;
  expandedHiddenFields: ReadonlySet<string>;
}

export interface OutlineExpansionState {
  expanded: Set<NodeId>;
  expandedHiddenFields: Set<string>;
}

export function persistOutlineViewState(
  rootNodeId: NodeId,
  byId: Map<NodeId, NodeProjection>,
  state: OutlineExpansionInput,
): void {
  const storage = localStorageOrNull();
  if (!storage || !byId.has(rootNodeId)) return;

  const scope = collectOutlineScope(rootNodeId, byId);
  const store = readStore(storage);
  store.byRootNodeId[rootNodeId] = {
    expandedNodeIds: [...state.expanded]
      .filter((nodeId) => scope.nodeIds.has(nodeId))
      .sort(),
    expandedHiddenFieldKeys: [...state.expandedHiddenFields]
      .filter((key) => scope.hiddenFieldKeys.has(key))
      .sort(),
    updatedAt: Date.now(),
  };
  pruneStore(store);
  writeStore(storage, store);
}

export function restoreOutlineExpansionForRoot(
  rootNodeId: NodeId,
  byId: Map<NodeId, NodeProjection>,
  currentExpanded: ReadonlySet<NodeId>,
  currentExpandedHiddenFields: ReadonlySet<string>,
): OutlineExpansionState {
  const restored = loadOutlineViewState(rootNodeId, byId);
  if (!restored) {
    return {
      expanded: new Set([...currentExpanded, rootNodeId]),
      expandedHiddenFields: new Set(currentExpandedHiddenFields),
    };
  }

  const expanded = new Set(currentExpanded);
  for (const nodeId of restored.expandedNodeIds) expanded.add(nodeId);
  expanded.add(rootNodeId);

  const expandedHiddenFields = new Set(currentExpandedHiddenFields);
  for (const key of restored.expandedHiddenFieldKeys) expandedHiddenFields.add(key);

  return { expanded, expandedHiddenFields };
}

function loadOutlineViewState(
  rootNodeId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): PersistedOutlineRootState | null {
  const storage = localStorageOrNull();
  if (!storage || !byId.has(rootNodeId)) return null;
  const state = readStore(storage).byRootNodeId[rootNodeId];
  if (!state) return null;

  const scope = collectOutlineScope(rootNodeId, byId);
  return {
    expandedNodeIds: state.expandedNodeIds.filter((nodeId) => scope.nodeIds.has(nodeId)),
    expandedHiddenFieldKeys: state.expandedHiddenFieldKeys.filter((key) => scope.hiddenFieldKeys.has(key)),
    updatedAt: state.updatedAt,
  };
}

function collectOutlineScope(
  rootNodeId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): OutlineScope {
  const nodeIds = new Set<NodeId>();
  const hiddenFieldKeys = new Set<string>();
  const visitedParents = new Set<NodeId>();

  const visitParent = (parentId: NodeId) => {
    if (visitedParents.has(parentId)) return;
    visitedParents.add(parentId);
    nodeIds.add(parentId);

    const parent = byId.get(parentId);
    if (!parent) return;
    for (const childId of parent.children) {
      if (byId.get(childId)?.type === 'fieldEntry') {
        hiddenFieldKeys.add(hiddenFieldKey(parentId, childId));
      }
      visitRow(childId);
    }
  };

  const visitRow = (rowId: NodeId) => {
    if (nodeIds.has(rowId)) return;
    nodeIds.add(rowId);
    visitParent(rowId);
  };

  visitParent(rootNodeId);
  return { nodeIds, hiddenFieldKeys };
}

function readStore(storage: Storage): PersistedOutlineViewStateStore {
  const byRootNodeId = readLocalStorageKeyedStore({
    storage,
    storageKey: STORAGE_KEY,
    version: STORE_VERSION,
    entriesKey: 'byRootNodeId',
    decodeEntry: decodeOutlineRootState,
  });
  return { version: STORE_VERSION, byRootNodeId };
}

function writeStore(storage: Storage, store: PersistedOutlineViewStateStore): void {
  writeLocalStorageKeyedStore({
    storage,
    storageKey: STORAGE_KEY,
    version: STORE_VERSION,
    entriesKey: 'byRootNodeId',
    entries: store.byRootNodeId,
  });
}

function pruneStore(store: PersistedOutlineViewStateStore): void {
  pruneLocalStorageEntries(store.byRootNodeId, MAX_ROOT_STATES, (entry) => entry.updatedAt);
}

function decodeOutlineRootState(value: unknown): PersistedOutlineRootState | null {
  if (!isRecord(value)) return null;
  return {
    expandedNodeIds: stringArray(value.expandedNodeIds),
    expandedHiddenFieldKeys: stringArray(value.expandedHiddenFieldKeys),
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : 0,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
