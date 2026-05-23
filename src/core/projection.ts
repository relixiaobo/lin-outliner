import {
  DAILY_NOTES_ID,
  LIBRARY_ID,
  SCHEMA_ID,
  SEARCHES_ID,
  SETTINGS_ID,
  TRASH_ID,
  type DocumentProjection,
  type DocumentState,
  type Node,
  type NodeProjection,
} from './types';

export function buildDocumentProjection(state: DocumentState, todayId: string): DocumentProjection {
  return {
    workspaceId: state.workspaceId,
    rootId: state.rootId,
    libraryId: LIBRARY_ID,
    dailyNotesId: DAILY_NOTES_ID,
    schemaId: SCHEMA_ID,
    searchesId: SEARCHES_ID,
    trashId: TRASH_ID,
    settingsId: SETTINGS_ID,
    todayId,
    nodes: Object.keys(state.nodes).sort().map((id) => projectNode(requiredNode(state, id))),
  };
}

function projectNode(node: Node): NodeProjection {
  const { trashedFromParentId: _trashedFromParentId, trashedFromIndex: _trashedFromIndex, ...projection } = node;
  return clone(projection);
}

function requiredNode(state: DocumentState, nodeId: string): Node {
  const node = state.nodes[nodeId];
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
