import type { NodeId, NodeProjection } from '../../api/types';
import { SYSTEM_FIELD_CHOICES } from '../../state/outlinerRows';

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

/**
 * Existing user field definitions, offered for reuse while naming a field. Every
 * `fieldDef` node with a name is a reusable definition (mirrors
 * `collectViewFieldChoices`' "Fields" section). The entry's own draft def is
 * excluded so it never offers to relink onto itself.
 */
export function buildUserFieldReuseCandidates(
  byId: Map<NodeId, NodeProjection>,
  options: { excludeDefId?: string } = {},
): FieldReuseCandidate[] {
  const candidates: FieldReuseCandidate[] = [];
  for (const node of byId.values()) {
    if (node.type !== 'fieldDef') continue;
    if (node.id === options.excludeDefId) continue;
    const label = node.content.text.trim();
    if (!label) continue;
    candidates.push({ id: node.id, label, section: 'Fields', kind: 'user' });
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
