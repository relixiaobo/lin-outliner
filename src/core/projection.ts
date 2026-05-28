import {
  DAILY_NOTES_ID,
  LIBRARY_ID,
  RECENTS_ID,
  SCHEMA_ID,
  SEARCHES_ID,
  SETTINGS_ID,
  TRASH_ID,
  type DocumentProjection,
  type DocumentState,
  type Node,
  type NodeId,
  type NodeProjection,
} from './types';

// Project a single node: drop the trash bookkeeping fields and detach from the
// store with a deep clone, so consumers can hold the projection without
// aliasing Core's internal state. Kept as a JSON clone (not structuredClone) so
// the projected shape stays byte-identical to the historical projection.
export function projectNode(node: Node): NodeProjection {
  const { trashedFromParentId: _trashedFromParentId, trashedFromIndex: _trashedFromIndex, ...projection } = node;
  return clone(projection);
}

// Assemble the projection envelope from already-projected nodes. Shared by the
// cold full rebuild below and Core's incremental cache, so both produce an
// identical wrapper.
export function assembleProjection(
  workspaceId: NodeId,
  rootId: NodeId,
  todayId: string,
  order: readonly string[],
  byId: ReadonlyMap<string, NodeProjection>,
): DocumentProjection {
  return {
    workspaceId,
    rootId,
    libraryId: LIBRARY_ID,
    dailyNotesId: DAILY_NOTES_ID,
    schemaId: SCHEMA_ID,
    searchesId: SEARCHES_ID,
    recentsId: RECENTS_ID,
    trashId: TRASH_ID,
    settingsId: SETTINGS_ID,
    todayId,
    nodes: order.map((id) => requiredProjection(byId, id)),
  };
}

export function buildDocumentProjection(state: DocumentState, todayId: string): DocumentProjection {
  const order = Object.keys(state.nodes).sort();
  const byId = new Map<string, NodeProjection>();
  for (const id of order) byId.set(id, projectNode(requiredNode(state, id)));
  return assembleProjection(state.workspaceId, state.rootId, todayId, order, byId);
}

function requiredNode(state: DocumentState, nodeId: string): Node {
  const node = state.nodes[nodeId];
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

function requiredProjection(byId: ReadonlyMap<string, NodeProjection>, nodeId: string): NodeProjection {
  const node = byId.get(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
