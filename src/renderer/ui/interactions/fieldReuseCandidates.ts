import type { NodeId, NodeProjection } from '../../api/types';
import { SYSTEM_FIELD_CHOICES } from '../../../core/systemFields';
import { isNodeInSubtree } from './nodeLocation';

// A field the user can reuse for the entry they are naming. `user` candidates are
// real `fieldDef` nodes (reuse = relink the entry to that def). `system`
// candidates are the built-in read-only view fields (Created, Done time, …); the
// renderer materializes a backing def on demand before relinking — so both kinds
// resolve to a real def by the time `reuse_field_definition` runs.
export interface FieldReuseCandidate {
  id: string;
  label: string;
  section: 'Fields' | 'System fields';
  kind: 'user' | 'system';
  /** Present for `system` candidates: the `systemKind` the backing def carries. */
  systemKind?: string;
}

interface IndexedFieldReuseCandidate extends FieldReuseCandidate {
  lowerLabel: string;
}

interface ActiveFieldReuseIndex {
  sortedFields: IndexedFieldReuseCandidate[];
}

const TYPED_FIELD_REUSE_LIMIT = 24;
const activeFieldReuseIndexCache = new WeakMap<Map<NodeId, NodeProjection>, Map<string, ActiveFieldReuseIndex>>();

/**
 * Existing user field definitions, offered for reuse while naming a field. Every
 * `fieldDef` node with a name is a reusable definition (mirrors
 * `collectViewFieldChoices`' "Fields" section). The entry's own draft def is
 * excluded so it never offers to relink onto itself.
 */
export function buildUserFieldReuseCandidates(
  byId: Map<NodeId, NodeProjection>,
  options: { excludeDefId?: string; trashId?: NodeId } = {},
): FieldReuseCandidate[] {
  const candidates: FieldReuseCandidate[] = [];
  for (const node of byId.values()) {
    if (node.type !== 'fieldDef') continue;
    if (node.id === options.excludeDefId) continue;
    if (options.trashId && isNodeInSubtree(byId, node.id, options.trashId)) continue;
    const label = node.content.text.trim();
    if (!label) continue;
    candidates.push({ id: node.id, label, section: 'Fields', kind: 'user' });
  }
  return candidates;
}

function cacheKeyForTrashRoot(trashId: NodeId | undefined): string {
  return trashId ?? '';
}

function compareIndexedFieldLabel(left: IndexedFieldReuseCandidate, right: IndexedFieldReuseCandidate): number {
  const byLower = left.lowerLabel.localeCompare(right.lowerLabel, undefined, { sensitivity: 'base' });
  if (byLower !== 0) return byLower;
  return left.id.localeCompare(right.id);
}

function activeFieldReuseIndex(
  byId: Map<NodeId, NodeProjection>,
  trashId: NodeId | undefined,
): ActiveFieldReuseIndex {
  const cacheKey = cacheKeyForTrashRoot(trashId);
  let perTrashRoot = activeFieldReuseIndexCache.get(byId);
  if (!perTrashRoot) {
    perTrashRoot = new Map();
    activeFieldReuseIndexCache.set(byId, perTrashRoot);
  }

  const cached = perTrashRoot.get(cacheKey);
  if (cached) return cached;

  const sortedFields: IndexedFieldReuseCandidate[] = [];
  for (const node of byId.values()) {
    if (node.type !== 'fieldDef') continue;
    if (trashId && isNodeInSubtree(byId, node.id, trashId)) continue;
    const label = node.content.text.trim();
    if (!label) continue;
    sortedFields.push({
      id: node.id,
      label,
      lowerLabel: label.toLowerCase(),
      section: 'Fields',
      kind: 'user',
    });
  }
  sortedFields.sort(compareIndexedFieldLabel);

  const index = { sortedFields };
  perTrashRoot.set(cacheKey, index);
  return index;
}

function isExcluded(
  candidate: FieldReuseCandidate,
  excludeDefId: string | undefined,
  excludeDefIds: ReadonlySet<string> | undefined,
): boolean {
  return candidate.id === excludeDefId || Boolean(excludeDefIds?.has(candidate.id));
}

function lowerBoundByLabel(
  fields: readonly IndexedFieldReuseCandidate[],
  needle: string,
): number {
  let low = 0;
  let high = fields.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (fields[mid].lowerLabel.localeCompare(needle, undefined, { sensitivity: 'base' }) < 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

function publicCandidate(candidate: IndexedFieldReuseCandidate): FieldReuseCandidate {
  return {
    id: candidate.id,
    label: candidate.label,
    section: candidate.section,
    kind: candidate.kind,
  };
}

export function queryUserFieldReuseCandidates(
  byId: Map<NodeId, NodeProjection>,
  query: string,
  options: {
    excludeDefId?: string;
    excludeDefIds?: ReadonlySet<string>;
    trashId?: NodeId;
    forceOpen?: boolean;
    limit?: number;
  } = {},
): FieldReuseCandidate[] {
  const fields = activeFieldReuseIndex(byId, options.trashId).sortedFields;
  const limit = options.limit ?? TYPED_FIELD_REUSE_LIMIT;
  const needle = query.trim().toLowerCase();

  if (options.forceOpen && !needle) {
    return fields
      .filter((candidate) => !isExcluded(candidate, options.excludeDefId, options.excludeDefIds))
      .map(publicCandidate);
  }

  if (!needle || limit <= 0) return [];

  const candidates: FieldReuseCandidate[] = [];
  const prefixStart = lowerBoundByLabel(fields, needle);
  for (let index = prefixStart; index < fields.length && candidates.length < limit; index += 1) {
    const candidate = fields[index];
    if (!candidate.lowerLabel.startsWith(needle)) break;
    if (!isExcluded(candidate, options.excludeDefId, options.excludeDefIds)) {
      candidates.push(publicCandidate(candidate));
    }
  }

  if (candidates.length >= limit) return candidates;

  for (const candidate of fields) {
    if (candidates.length >= limit) break;
    if (candidate.lowerLabel.startsWith(needle)) continue;
    if (!candidate.lowerLabel.includes(needle)) continue;
    if (isExcluded(candidate, options.excludeDefId, options.excludeDefIds)) continue;
    candidates.push(publicCandidate(candidate));
  }
  return candidates;
}

/**
 * The built-in system fields offered for reuse (Created, Done time, …). Each
 * resolves to its `sys:*` id; selecting one points the entry at that id, which
 * the renderer treats as a read-only computed field.
 */
export function buildSystemFieldReuseCandidates(): FieldReuseCandidate[] {
  return SYSTEM_FIELD_CHOICES.map((choice) => ({
    id: choice.id,
    label: choice.label,
    section: 'System fields',
    kind: 'system',
    systemKind: choice.id,
  }));
}

/**
 * Narrow the candidate list to those matching the typed name. An exact-name match
 * is intentionally kept: typing a field's full name is exactly when reuse matters
 * most (dedupe rather than fork). The popover starts with nothing highlighted, so
 * Enter still commits the user's own name unless they Arrow into a candidate.
 */
export function filterFieldReuseCandidates(
  candidates: FieldReuseCandidate[],
  query: string,
): FieldReuseCandidate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return candidates
    .filter((candidate) => candidate.label.toLowerCase().includes(needle))
    .sort((a, b) => {
      // Prefix matches first, then alphabetical — the closest name is easiest to
      // reach with a single ArrowDown.
      const aStarts = a.label.toLowerCase().startsWith(needle);
      const bStarts = b.label.toLowerCase().startsWith(needle);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });
}

/**
 * Order candidates alphabetically by label. Used when the full picker is summoned
 * with an empty query (Space on an empty field name) — there is no needle to rank
 * by, so plain alphabetical order is the most predictable.
 */
export function sortFieldReuseCandidatesByLabel(
  candidates: FieldReuseCandidate[],
): FieldReuseCandidate[] {
  return [...candidates].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  );
}
