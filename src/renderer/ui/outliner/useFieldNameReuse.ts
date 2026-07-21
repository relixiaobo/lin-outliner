import { useMemo, useState } from 'react';
import type { NodeId, NodeProjection } from '../../api/types';
import {
  buildSystemFieldReuseCandidates,
  filterFieldReuseCandidates,
  queryUserFieldReuseCandidates,
  type FieldReuseCandidate,
} from '../interactions/fieldReuseCandidates';

interface UseFieldNameReuseArgs {
  byId: Map<NodeId, NodeProjection>;
  /** The field entry being edited (its owner is `parentId`). */
  entryId: NodeId;
  parentId: NodeId;
  /** The draft def the entry currently points at — excluded from its own list. */
  draftDefId: NodeId | undefined;
  trashId: NodeId;
  nameDraft: string;
  /** A system field's name is fixed, so it never offers reuse. */
  disabled: boolean;
}

/**
 * The field-name reuse popover's state machine, isolated from the row component.
 *
 * Two independent dimensions drive `open`: the input's focus (`onFocus`/`onBlur`)
 * and a within-focus mode — `typing` (filter by the query), `forced` (Space on an
 * empty name summons the full picker), or `dismissed` (Escape / a selection closed
 * it until the name changes or the input refocuses). Keeping the resets here means
 * a missed reset can't leak across the row's other handlers.
 *
 * User-field candidates are served from a byId-keyed active-field index: opening
 * the picker may build that index once for the projection snapshot, but typed
 * queries reuse it and broad prefixes return only the visible candidate window.
 */
export interface FieldNameReuse {
  open: boolean;
  candidates: FieldReuseCandidate[];
  onFocus: () => void;
  onBlur: () => void;
  onChange: () => void;
  /** Space on an empty name: show every reusable field, not just query matches. */
  summon: () => void;
  /** Escape, a selection, or the popover closing itself. */
  dismiss: () => void;
}

export function useFieldNameReuse(args: UseFieldNameReuseArgs): FieldNameReuse {
  const { byId, entryId, parentId, draftDefId, trashId, nameDraft, disabled } = args;
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);

  // User fields first, then built-in system fields, each section filtered + sorted
  // on its own. A field already present on this node is never offered again (a node
  // may not carry the same field twice), so reuse is a cross-node gesture.
  const candidates = useMemo<FieldReuseCandidate[]>(() => {
    if (!focused || disabled) return [];
    const ownerDefIds = new Set<string>();
    const owner = byId.get(parentId);
    for (const childId of owner?.children ?? []) {
      const child = byId.get(childId);
      if (child?.type === 'fieldEntry' && child.id !== entryId && child.fieldDefId) {
        ownerDefIds.add(child.fieldDefId);
      }
    }
    const userCandidates = queryUserFieldReuseCandidates(byId, nameDraft, {
      excludeDefId: draftDefId,
      excludeDefIds: ownerDefIds,
      forceOpen,
      trashId,
    });
    const systemAll = buildSystemFieldReuseCandidates()
      .filter((candidate) => !ownerDefIds.has(candidate.id));
    if (forceOpen && nameDraft.trim() === '') {
      return [...userCandidates, ...systemAll];
    }
    return [
      ...userCandidates,
      ...filterFieldReuseCandidates(systemAll, nameDraft),
    ];
  }, [focused, disabled, forceOpen, nameDraft, draftDefId, trashId, byId, parentId, entryId]);

  return {
    open: focused && !dismissed && candidates.length > 0,
    candidates,
    onFocus: () => { setFocused(true); setDismissed(false); },
    onBlur: () => { setFocused(false); setForceOpen(false); },
    onChange: () => { setDismissed(false); setForceOpen(false); },
    summon: () => { setForceOpen(true); setDismissed(false); },
    dismiss: () => { setDismissed(true); setForceOpen(false); },
  };
}
