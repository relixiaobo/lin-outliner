// Row-level applicability, derived from the projection alone.
//
// The stage-0 spike behind D1 traced the selection family's renderer-looking
// signature to the bottom and found nothing renderer-bound survives: `rowMap`
// is a cache with an existing derivation fallback, and `actionPolicy` computes
// from `(id, node, parent)` with no view config, expansion or UI state. So the
// derivation lives here and the renderer's `SelectableRow` is this plus the
// pane root it needs for its own keyboard-only actions.

import { projectFieldConfig } from '../configProjection';
import { isOptionsFieldType } from '../fieldTypeRegistry';
import { isContentBearingNode, type NodeId, type NodeProjection } from '../types';
import { resolveViewToolbarVisible } from '../viewConfig';

export type NodeRowKind =
  | 'content'
  | 'fieldEntry'
  | 'fieldValue'
  | 'syntheticSystemValue';

export type NodeRowAction =
  | 'node-trash'
  | 'field-value-remove'
  | 'node-reorder'
  | 'node-clone'
  | 'target-node'
  | 'disabled';

export interface NodeRowActionPolicy {
  delete: Extract<NodeRowAction, 'node-trash' | 'field-value-remove' | 'disabled'>;
  move: Extract<NodeRowAction, 'node-reorder' | 'disabled'>;
  duplicate: Extract<NodeRowAction, 'node-clone' | 'disabled'>;
  tag: Extract<NodeRowAction, 'target-node' | 'disabled'>;
  checkbox: Extract<NodeRowAction, 'target-node' | 'disabled'>;
}

export interface NodeRowFacets {
  id: NodeId;
  parentId: NodeId | null;
  kind: NodeRowKind;
  stored: boolean;
  mutable: boolean;
  actionPolicy: NodeRowActionPolicy;
}

export const SYNTHETIC_SYSTEM_REFERENCE_PREFIX = 'sysref:';

export function isSyntheticSystemValueId(id: NodeId): boolean {
  return id.startsWith(SYNTHETIC_SYSTEM_REFERENCE_PREFIX);
}

export const DISABLED_ROW_POLICY: NodeRowActionPolicy = {
  delete: 'disabled',
  move: 'disabled',
  duplicate: 'disabled',
  tag: 'disabled',
  checkbox: 'disabled',
};

export const NODE_ROW_POLICY: NodeRowActionPolicy = {
  delete: 'node-trash',
  move: 'node-reorder',
  duplicate: 'node-clone',
  tag: 'target-node',
  checkbox: 'target-node',
};

export const FIELD_VALUE_ROW_POLICY: NodeRowActionPolicy = {
  delete: 'field-value-remove',
  move: 'node-reorder',
  duplicate: 'node-clone',
  tag: 'target-node',
  checkbox: 'target-node',
};

export function nodeRowFacetsFor(params: {
  id: NodeId;
  parentId: NodeId | null;
  byId: ReadonlyMap<NodeId, NodeProjection>;
}): NodeRowFacets {
  const node = params.byId.get(params.id);
  const parent = params.parentId ? params.byId.get(params.parentId) : undefined;
  const synthetic = isSyntheticSystemValueId(params.id);
  const kind = nodeRowKind(params.id, node, parent);
  const stored = Boolean(node) && !synthetic;
  const mutable = stored && !(node?.locked ?? true);
  return {
    id: params.id,
    parentId: params.parentId,
    kind,
    stored,
    mutable,
    actionPolicy: rowActionPolicyFor(kind, mutable),
  };
}

/** Facets for an id whose parent comes from the document rather than a row walk. */
export function nodeRowFacetsForId(
  id: NodeId,
  byId: ReadonlyMap<NodeId, NodeProjection>,
): NodeRowFacets | null {
  const node = byId.get(id);
  if (!node && !isSyntheticSystemValueId(id)) return null;
  return nodeRowFacetsFor({ id, parentId: node?.parentId ?? null, byId });
}

function nodeRowKind(
  id: NodeId,
  node: NodeProjection | undefined,
  parent: NodeProjection | undefined,
): NodeRowKind {
  if (isSyntheticSystemValueId(id)) return 'syntheticSystemValue';
  if (parent?.type === 'fieldEntry') return 'fieldValue';
  if (node?.type === 'fieldEntry') return 'fieldEntry';
  return 'content';
}

export function rowActionPolicyFor(kind: NodeRowKind, mutable: boolean): NodeRowActionPolicy {
  if (!mutable || kind === 'syntheticSystemValue') return DISABLED_ROW_POLICY;
  if (kind === 'fieldValue') return FIELD_VALUE_ROW_POLICY;
  return NODE_ROW_POLICY;
}

/**
 * Field values of an option-pool or checkbox field cannot be duplicated — the
 * clone would register a second identical option. Shared with the shipped
 * selection path so both surfaces refuse the same rows.
 */
export function canDuplicateRow(
  row: NodeRowFacets,
  byId: ReadonlyMap<NodeId, NodeProjection>,
): boolean {
  if (row.kind !== 'fieldValue') return true;
  const valueNode = byId.get(row.id);
  if (!valueNode || valueNode.type === 'reference') return false;
  const fieldEntry = row.parentId ? byId.get(row.parentId) : undefined;
  if (fieldEntry?.type !== 'fieldEntry') return false;
  const fieldDef = fieldEntry.fieldDefId ? byId.get(fieldEntry.fieldDefId) : undefined;
  const fieldType = fieldDef
    ? projectFieldConfig(byId as Map<NodeId, NodeProjection>, fieldDef).fieldType
    : undefined;
  if (isOptionsFieldType(fieldType) || fieldType === 'checkbox') return false;
  return true;
}

/**
 * Collapse a selection to its roots: a row whose ancestor is also selected is
 * covered by that ancestor's structural action.
 */
export function selectionRootIds(
  ids: readonly NodeId[],
  byId: ReadonlyMap<NodeId, NodeProjection>,
  parentIdForRow: (id: NodeId) => NodeId | null | undefined = (id) => byId.get(id)?.parentId,
): NodeId[] {
  const selected = new Set(ids);
  return ids.filter((id) => {
    let parentId = parentIdForRow(id);
    while (parentId) {
      if (selected.has(parentId)) return false;
      parentId = parentIdForRow(parentId);
    }
    return true;
  });
}

/** A reference row acts structurally on itself and semantically on its target. */
export function contentTargetIdForRow(
  rowId: NodeId,
  byId: ReadonlyMap<NodeId, NodeProjection>,
  fallbackTargetId: NodeId = rowId,
): NodeId {
  const row = byId.get(rowId);
  if (row?.type === 'reference' && row.targetId) return row.targetId;
  return row ? row.id : fallbackTargetId;
}

/**
 * Follow a reference CHAIN to the first non-reference node. The anchored row's
 * content facet uses this (the shipped `targetEditId` / `drillDownId` path);
 * batch member targets deliberately keep the shipped single hop above.
 */
export function resolveReferenceChainTargetId(
  targetId: NodeId,
  byId: ReadonlyMap<NodeId, NodeProjection>,
): NodeId | null {
  let currentId: NodeId | undefined = targetId;
  const visited = new Set<NodeId>();
  while (currentId) {
    if (visited.has(currentId)) return null;
    visited.add(currentId);
    const current = byId.get(currentId);
    if (!current) return null;
    if (current.type !== 'reference') return current.id;
    currentId = current.targetId;
  }
  return null;
}

export function contentTargetIdsForRows(
  rowIds: readonly NodeId[],
  byId: ReadonlyMap<NodeId, NodeProjection>,
): NodeId[] {
  const seen = new Set<NodeId>();
  const targetIds: NodeId[] = [];
  for (const rowId of rowIds) {
    const targetId = contentTargetIdForRow(rowId, byId);
    if (seen.has(targetId)) continue;
    seen.add(targetId);
    targetIds.push(targetId);
  }
  return targetIds;
}

/** Tag ids every target already carries — the exclusion set for `addTag`. */
export function commonTagIdsForTargets(
  targetIds: readonly NodeId[],
  byId: ReadonlyMap<NodeId, NodeProjection>,
): NodeId[] {
  if (targetIds.length === 0) return [];
  const first = byId.get(targetIds[0]!);
  if (!first || !isContentBearingNode(first)) return [];
  const common = new Set(first.tags);
  for (const targetId of targetIds.slice(1)) {
    const target = byId.get(targetId);
    const tags = new Set(target && isContentBearingNode(target) ? target.tags : []);
    for (const tagId of [...common]) {
      if (!tags.has(tagId)) common.delete(tagId);
    }
  }
  return [...common];
}

export function isDescendantOf(
  byId: ReadonlyMap<NodeId, NodeProjection>,
  nodeId: NodeId,
  possibleAncestorId: NodeId,
): boolean {
  let current = byId.get(nodeId);
  const visited = new Set<NodeId>();
  while (current?.parentId && !visited.has(current.id)) {
    if (current.parentId === possibleAncestorId) return true;
    visited.add(current.id);
    current = byId.get(current.parentId);
  }
  return false;
}

/** The view facts the registry reads. The full `ViewConfig` stays renderer-side. */
export interface NodeViewSettings {
  viewDefId: NodeId | null;
  viewMode: 'list' | 'table' | 'cards' | 'calendar';
  toolbarVisible: boolean;
}

export function readNodeViewSettings(
  parent: NodeProjection | undefined,
  byId: ReadonlyMap<NodeId, NodeProjection>,
): NodeViewSettings {
  for (const childId of parent?.children ?? []) {
    const child = byId.get(childId);
    if (child?.type !== 'viewDef') continue;
    return {
      viewDefId: child.id,
      viewMode: child.viewMode ?? 'list',
      toolbarVisible: resolveViewToolbarVisible(parent, child.toolbarVisible),
    };
  }
  return {
    viewDefId: null,
    viewMode: 'list',
    toolbarVisible: resolveViewToolbarVisible(parent, undefined),
  };
}
