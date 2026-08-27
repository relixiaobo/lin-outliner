// Shared client-node id helpers. A plain content node's id is `node:` followed
// by a v4 UUID — exactly what core mints for an untyped node. Both the renderer
// (which proposes a draft row's id so it survives eager materialization) and
// core (which mints ids and validates client proposals) import these, so the id
// shape has a single source of truth.

import {
  DAILY_NOTES_ID,
  LIBRARY_ID,
  SCHEMA_ID,
  SEARCHES_ID,
  WORKSPACE_ID,
} from './types';

const CLIENT_NODE_ID_PATTERN = /^node:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;

export const PUBLIC_REFERENCE_NODE_IDS = Object.freeze([
  WORKSPACE_ID,
  DAILY_NOTES_ID,
  LIBRARY_ID,
  SCHEMA_ID,
  SEARCHES_ID,
] as const);

const PUBLIC_REFERENCE_NODE_ID_SET = new Set<string>(PUBLIC_REFERENCE_NODE_IDS);

export function freshNodeId(): string {
  return `node:${crypto.randomUUID()}`;
}

/**
 * A client-minted plain-node id: `node:` + a v4 UUID, exactly what
 * `freshNodeId()` produces. The renderer may propose such an id (so a draft row
 * keeps its React identity through materialization); core validates it before
 * accepting. Reserved/structural ids (workspace, trash, …) and forged strings
 * are rejected by the strict shape.
 */
export function isClientNodeId(id: string): boolean {
  return CLIENT_NODE_ID_PATTERN.test(id);
}

/** The only internal Node identities that may cross a textual reference boundary. */
export function publicReferenceNodeKey(nodeId: string): string | null {
  const normalized = nodeId.trim();
  if (PUBLIC_REFERENCE_NODE_ID_SET.has(normalized)) return normalized;
  return CLIENT_NODE_ID_PATTERN.exec(normalized)?.[1]?.toLowerCase() ?? null;
}

/** Maps a public `node://` authority back to the canonical internal Node id. */
export function nodeIdFromPublicReferenceKey(key: string): string | null {
  if (PUBLIC_REFERENCE_NODE_ID_SET.has(key)) return key;
  const candidate = `node:${key.toLowerCase()}`;
  return CLIENT_NODE_ID_PATTERN.test(candidate) ? candidate : null;
}

export function isPublicReferenceNodeId(nodeId: string): boolean {
  return publicReferenceNodeKey(nodeId) !== null;
}
