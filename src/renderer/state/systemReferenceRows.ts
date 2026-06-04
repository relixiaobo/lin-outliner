import {
  DAY_FIELD,
  OWNER_FIELD,
  REF_COUNT_FIELD,
  systemFieldDisplay,
} from '../../core/systemFields';
import type { NodeId, NodeProjection } from '../api/types';

// The read-only system fields that resolve to other nodes: References (backlink
// sources), Owner (the parent), Day (the nearest day-tagged ancestor). They are
// computed, not stored.
const NODE_REFERENCE_SYSTEM_FIELDS: ReadonlySet<string> = new Set([
  REF_COUNT_FIELD,
  OWNER_FIELD,
  DAY_FIELD,
]);

export function isNodeReferenceSystemField(systemFieldId: string): boolean {
  return NODE_REFERENCE_SYSTEM_FIELDS.has(systemFieldId);
}

export function syntheticSystemReferenceId(entryId: NodeId, targetId: NodeId): NodeId {
  return `sysref:${entryId}:${targetId}`;
}

export function isSyntheticSystemReferenceId(id: NodeId): boolean {
  return id.startsWith('sysref:');
}

export function systemReferenceTargets(
  owner: NodeProjection | undefined,
  systemFieldId: string | undefined,
  byId: Map<NodeId, NodeProjection>,
): NodeId[] {
  if (!owner || !systemFieldId || !isNodeReferenceSystemField(systemFieldId)) return [];
  const display = systemFieldDisplay(owner, systemFieldId, byId);
  if (display.kind === 'nodeRefs') return display.refs.map((ref) => ref.id);
  if (display.kind === 'dayRef') return display.nodeId ? [display.nodeId] : [];
  return [];
}

export function systemReferenceValueIds(
  entry: NodeProjection | undefined,
  byId: Map<NodeId, NodeProjection>,
): NodeId[] {
  if (entry?.type !== 'fieldEntry') return [];
  const owner = entry.parentId ? byId.get(entry.parentId) : undefined;
  return systemReferenceTargets(owner, entry.fieldDefId, byId)
    .map((targetId) => syntheticSystemReferenceId(entry.id, targetId));
}
