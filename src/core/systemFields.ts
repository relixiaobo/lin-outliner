// System fields: read-only, computed projections of a node (Created, Done, Tags,
// References, Owner, Day, …). They have no backing definition node — their value
// is derived from the owner on demand. This module is the single source for that
// derivation: `resolveSystemField` computes the structured value once, and the two
// consumers adapt it — `systemFieldValues` (sort/group/filter strings) and
// `systemFieldDisplay` (the render union). Sharing one resolver keeps the two from
// drifting, and living in `core/` lets both the renderer and the main process use
// it (it reads a structural node shape that `Node` and `NodeProjection` satisfy).

import type { NodeId, NodeType } from './types';

export const NAME_FIELD = 'sys:name';
export const CREATED_FIELD = 'sys:createdAt';
export const UPDATED_FIELD = 'sys:updatedAt';
export const DONE_FIELD = 'sys:done';
export const DONE_AT_FIELD = 'sys:doneAt';
export const TAGS_FIELD = 'sys:tags';
export const REF_COUNT_FIELD = 'sys:refCount';
export const OWNER_FIELD = 'sys:owner';
export const DAY_FIELD = 'sys:day';

/** The node fields system-field derivation reads. `Node` and `NodeProjection` both satisfy it. */
export interface SysFieldNode {
  id: NodeId;
  type?: NodeType;
  content: { text: string };
  children: readonly NodeId[];
  tags: readonly NodeId[];
  parentId?: NodeId | null;
  completedAt?: number;
  createdAt?: number;
  updatedAt?: number;
  targetId?: NodeId;
  fieldDefId?: NodeId;
}
export type SysFieldNodeMap = ReadonlyMap<NodeId, SysFieldNode>;

export function isSystemFieldId(fieldId: string | undefined): fieldId is string {
  return typeof fieldId === 'string' && fieldId.startsWith('sys:');
}

// Single source for the system-field labels; the reuse picker choices and
// `systemFieldLabel` both derive from it (Name is excluded from the picker — a
// node's name is its title, not a field it carries).
const SYSTEM_FIELD_LABELS: ReadonlyArray<{ id: string; label: string; pickable: boolean }> = [
  { id: NAME_FIELD, label: 'Name', pickable: false },
  { id: CREATED_FIELD, label: 'Created', pickable: true },
  { id: UPDATED_FIELD, label: 'Last edited', pickable: true },
  { id: DONE_FIELD, label: 'Done', pickable: true },
  { id: DONE_AT_FIELD, label: 'Done time', pickable: true },
  { id: TAGS_FIELD, label: 'Tags', pickable: true },
  { id: REF_COUNT_FIELD, label: 'References', pickable: true },
  { id: OWNER_FIELD, label: 'Owner', pickable: true },
  { id: DAY_FIELD, label: 'Day', pickable: true },
];

/** The label for a system field id, or undefined for a non-system field. */
export function systemFieldLabel(fieldId: string): string | undefined {
  return SYSTEM_FIELD_LABELS.find((entry) => entry.id === fieldId)?.label;
}

/** The built-in system fields a node can carry as a read-only field (Name excluded). */
export const SYSTEM_FIELD_CHOICES: ReadonlyArray<{ id: string; label: string }> =
  SYSTEM_FIELD_LABELS.filter((entry) => entry.pickable).map(({ id, label }) => ({ id, label }));

/** A navigable node reference surfaced by a read-only system field. */
export interface SystemFieldRef {
  id: NodeId;
  label: string;
}

function nodeTitle(node: SysFieldNode | undefined): string {
  return node?.content.text || 'Untitled';
}

/** A reference node resolves to (displays) its target; everything else is itself. */
export function displayNode(node: SysFieldNode, byId: SysFieldNodeMap): SysFieldNode {
  if (node.type === 'reference' && node.targetId) {
    return byId.get(node.targetId) ?? node;
  }
  return node;
}

// The nearest ancestor tagged "day" (a daily-note date node), including the node
// itself. Mirrors the core `ancestor_day_node` auto-init resolution.
function nearestDayNode(node: SysFieldNode, byId: SysFieldNodeMap): SysFieldNode | undefined {
  let current: SysFieldNode | undefined = node;
  const seen = new Set<NodeId>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.tags.some((tagId) => byId.get(tagId)?.content.text.trim().toLowerCase() === 'day')) {
      return current;
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return undefined;
}

// Backlinks: the references whose target is `node`. `count` is every such reference
// (what sort/group reports); `sources` are the deduped containing nodes, each
// navigable (what the value renders).
function resolveBacklinks(node: SysFieldNode, byId: SysFieldNodeMap): { sources: SystemFieldRef[]; count: number } {
  const sources: SystemFieldRef[] = [];
  const seen = new Set<NodeId>();
  let count = 0;
  for (const candidate of byId.values()) {
    if (candidate.type !== 'reference' || candidate.targetId !== node.id) continue;
    count += 1;
    const source = candidate.parentId ? byId.get(candidate.parentId) : undefined;
    if (!source || seen.has(source.id)) continue;
    seen.add(source.id);
    sources.push({ id: source.id, label: nodeTitle(source) });
  }
  return { sources, count };
}

/**
 * The structured value of a system field on `owner` — computed once, then adapted
 * by `systemFieldValues` (sort/group) and `systemFieldDisplay` (render).
 *
 * - `done`       — completion boolean.
 * - `date`       — Created / Last edited / Done time as an epoch (`ms`, null when absent).
 * - `tags`       — the owner's applied tag ids.
 * - `nodeRefs`   — Owner (parent) and References (backlink sources), with a raw `count`.
 * - `dayRef`     — the nearest `day`-tagged ancestor.
 * - `text`       — fallback (unreachable for the known system fields).
 */
export type ResolvedSystemField =
  | { kind: 'done'; done: boolean }
  | { kind: 'date'; ms: number | null }
  | { kind: 'tags'; tagIds: NodeId[] }
  | { kind: 'nodeRefs'; refs: SystemFieldRef[]; count: number }
  | { kind: 'dayRef'; nodeId: NodeId | null; text: string }
  | { kind: 'text'; values: string[] };

export function resolveSystemField(owner: SysFieldNode, fieldId: string, byId: SysFieldNodeMap): ResolvedSystemField {
  const node = displayNode(owner, byId);
  if (fieldId === DONE_FIELD) return { kind: 'done', done: Boolean(node.completedAt) };
  if (fieldId === CREATED_FIELD) return { kind: 'date', ms: node.createdAt ?? null };
  if (fieldId === UPDATED_FIELD) return { kind: 'date', ms: node.updatedAt ?? null };
  if (fieldId === DONE_AT_FIELD) return { kind: 'date', ms: node.completedAt && node.completedAt > 0 ? node.completedAt : null };
  if (fieldId === TAGS_FIELD) return { kind: 'tags', tagIds: [...node.tags] };
  if (fieldId === OWNER_FIELD) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    return { kind: 'nodeRefs', refs: parent ? [{ id: parent.id, label: nodeTitle(parent) }] : [], count: parent ? 1 : 0 };
  }
  if (fieldId === DAY_FIELD) {
    const day = nearestDayNode(node, byId);
    return { kind: 'dayRef', nodeId: day?.id ?? null, text: day ? day.content.text.trim() : '' };
  }
  if (fieldId === REF_COUNT_FIELD) {
    const { sources, count } = resolveBacklinks(node, byId);
    return { kind: 'nodeRefs', refs: sources, count };
  }
  return { kind: 'text', values: [] };
}

/**
 * A system field's sort/group/filter values. Dates stay raw epoch-ms strings (the
 * date-filter parser expects that); References reports its raw count; Owner/Day/Tags
 * report their text. `NAME_FIELD` is handled by the caller (it reads node text).
 */
export function systemFieldValues(owner: SysFieldNode, fieldId: string, byId: SysFieldNodeMap): string[] {
  const resolved = resolveSystemField(owner, fieldId, byId);
  switch (resolved.kind) {
    case 'done':
      return [resolved.done ? 'true' : 'false'];
    case 'date':
      return resolved.ms === null ? [] : [String(resolved.ms)];
    case 'tags':
      return resolved.tagIds.map((tagId) => byId.get(tagId)?.content.text || tagId);
    case 'nodeRefs':
      // References sorts/groups by its raw count; Owner reports the parent's title.
      return fieldId === REF_COUNT_FIELD
        ? [String(resolved.count)]
        : resolved.refs.map((ref) => ref.label).filter(Boolean);
    case 'dayRef':
      return resolved.text ? [resolved.text] : [];
    default:
      return resolved.values;
  }
}

function formatSystemDate(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * How a read-only system field renders on `owner` — by its real type, not as bare
 * text. The row component switches on `kind`.
 *
 * - `done`     — boolean checkbox (the one mutable system field).
 * - `date`     — Created / Last edited / Done time (formatted day + calendar glyph).
 * - `dayRef`   — Day: the date of the nearest `day`-tagged ancestor, navigable.
 * - `tags`     — the owner's applied tags as colored badges.
 * - `nodeRefs` — Owner (the parent node) and References (backlink sources): links.
 * - `text`     — fallback (never hit by the known system fields).
 */
export type SystemFieldDisplay =
  | { kind: 'done'; checked: boolean }
  | { kind: 'date'; text: string }
  | { kind: 'dayRef'; nodeId: NodeId | null; text: string }
  | { kind: 'tags'; tagIds: NodeId[] }
  | { kind: 'nodeRefs'; refs: SystemFieldRef[] }
  | { kind: 'text'; text: string };

export function systemFieldDisplay(owner: SysFieldNode, fieldId: string, byId: SysFieldNodeMap): SystemFieldDisplay {
  const resolved = resolveSystemField(owner, fieldId, byId);
  switch (resolved.kind) {
    case 'done':
      return { kind: 'done', checked: resolved.done };
    case 'date':
      return { kind: 'date', text: formatSystemDate(resolved.ms) };
    case 'tags':
      return { kind: 'tags', tagIds: resolved.tagIds };
    case 'nodeRefs':
      return { kind: 'nodeRefs', refs: resolved.refs };
    case 'dayRef':
      return { kind: 'dayRef', nodeId: resolved.nodeId, text: resolved.text };
    default:
      return { kind: 'text', text: resolved.values.join(', ') };
  }
}

/**
 * True when the node carries a built-in Done field (a `sys:done` field entry
 * child). Typed structurally on the minimum it reads — a node's child ids and,
 * per child, its `type`/`fieldDefId` — so both core's `ConfigNodeMap` and the
 * renderer's projection map satisfy it without converting to `SysFieldNode`.
 */
export function nodeHasDoneField(
  node: { children: readonly NodeId[] },
  byId: ReadonlyMap<NodeId, { type?: NodeType; fieldDefId?: NodeId }>,
): boolean {
  return node.children.some((childId) => {
    const child = byId.get(childId);
    return child?.type === 'fieldEntry' && child.fieldDefId === DONE_FIELD;
  });
}
