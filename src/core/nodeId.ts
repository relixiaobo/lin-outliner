// Shared client-node id helpers. A plain content node's id is `node:` followed
// by a v4 UUID. Core adds the explicit public-reference allowlist without
// duplicating the shared contract used by the Outline Runtime.

import {
  CLIENT_NODE_ID_PATTERN,
  freshNodeId,
  isClientNodeId,
} from '../shared/nodeId';
import {
  DAILY_NOTES_ID,
  LIBRARY_ID,
  SCHEMA_ID,
  SEARCHES_ID,
  WORKSPACE_ID,
} from './types';

export { CLIENT_NODE_ID_PATTERN, freshNodeId, isClientNodeId };

export const PUBLIC_REFERENCE_NODE_IDS = Object.freeze([
  WORKSPACE_ID,
  DAILY_NOTES_ID,
  LIBRARY_ID,
  SCHEMA_ID,
  SEARCHES_ID,
] as const);

const PUBLIC_REFERENCE_NODE_ID_SET = new Set<string>(PUBLIC_REFERENCE_NODE_IDS);

/** The only internal Node identities that may cross a textual reference boundary. */
export function publicReferenceNodeKey(nodeId: string): string | null {
  const normalized = nodeId.trim();
  if (PUBLIC_REFERENCE_NODE_ID_SET.has(normalized)) return normalized;
  return isClientNodeId(normalized) ? normalized.slice('node:'.length).toLowerCase() : null;
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
