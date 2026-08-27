import type { NodeId, NodeProjection } from '../api/types';
import type { PendingStructuralChange, TrailingDraftPlacement } from './document';
import type { OutlinerRowItem } from './outlinerRows';

export interface PendingRowPlacement {
  kind: 'insert' | 'replace';
  index: number;
  referenceIndex: number | null;
}

export function resolvePendingRowPlacement<Row>(params: {
  rows: readonly Row[];
  change: Pick<PendingStructuralChange, 'id' | 'parentId' | 'beforeId' | 'afterId'>;
  matches: (row: Row, id: NodeId, parentId: NodeId) => boolean;
  fallbackIndex: (rows: readonly Row[], parentId: NodeId) => number | null;
  afterAnchorIndex?: (rows: readonly Row[], anchorIndex: number) => number;
}): PendingRowPlacement | null {
  const { rows, change, matches } = params;
  const existingIndex = rows.findIndex((row) => matches(row, change.id, change.parentId));
  if (existingIndex >= 0) {
    return { kind: 'replace', index: existingIndex, referenceIndex: existingIndex };
  }
  if (change.beforeId) {
    const anchorIndex = rows.findIndex((row) => matches(row, change.beforeId!, change.parentId));
    if (anchorIndex >= 0) {
      return { kind: 'insert', index: anchorIndex, referenceIndex: anchorIndex };
    }
  }
  if (change.afterId) {
    const anchorIndex = rows.findIndex((row) => matches(row, change.afterId!, change.parentId));
    if (anchorIndex >= 0) {
      return {
        kind: 'insert',
        index: params.afterAnchorIndex?.(rows, anchorIndex) ?? anchorIndex + 1,
        referenceIndex: anchorIndex,
      };
    }
  }
  const fallbackIndex = params.fallbackIndex(rows, change.parentId);
  return fallbackIndex === null
    ? null
    : { kind: 'insert', index: fallbackIndex, referenceIndex: fallbackIndex < rows.length ? fallbackIndex : null };
}

export function applyPendingRowPlacement<Row>(
  rows: readonly Row[],
  row: Row,
  placement: PendingRowPlacement,
): Row[] {
  return applyPendingRowsPlacement(rows, [row], placement);
}

export function applyPendingRowsPlacement<Row>(
  rows: readonly Row[],
  pendingRows: readonly Row[],
  placement: PendingRowPlacement,
): Row[] {
  return placement.kind === 'replace'
    ? [...rows.slice(0, placement.index), ...pendingRows, ...rows.slice(placement.index + 1)]
    : [...rows.slice(0, placement.index), ...pendingRows, ...rows.slice(placement.index)];
}

export function pendingStructuralProjectionSuppressions(
  changes: readonly Pick<PendingStructuralChange, 'id' | 'parentId' | 'sourceParentId'>[],
  parentId: NodeId,
  pendingRemovalIds: ReadonlySet<NodeId>,
): ReadonlySet<NodeId> {
  const sourceIds = changes
    .filter((change) => change.sourceParentId === parentId)
    .map((change) => change.id);
  if (sourceIds.length === 0) return pendingRemovalIds;
  return new Set([...pendingRemovalIds, ...sourceIds]);
}

export function pendingStructuralRow(
  change: PendingStructuralChange,
  existsInProjection: boolean,
): OutlinerRowItem {
  if (change.presentation === 'field') {
    return {
      id: change.id,
      type: 'field',
      slot: {
        id: change.id,
        fieldDefId: change.resolvedFieldDefId?.current ?? `pending-field-def:${change.id}`,
        source: 'own',
        entryId: change.id,
      },
    };
  }
  return {
    id: change.id,
    type: 'content',
    ...(pendingStructuralRowIsDraft(change, !existsInProjection) ? { draft: true } : {}),
    beforeId: change.beforeId,
    afterId: change.afterId,
  };
}

export function pendingStructuralRowIsDraft(
  change: Pick<PendingStructuralChange, 'originatesFromDraft'>,
  fallbackDraft: boolean,
): boolean {
  return change.originatesFromDraft === true || fallbackDraft;
}

export function trailingDraftPlacementMatches(params: {
  placement: TrailingDraftPlacement | null | undefined;
  parentId: NodeId;
  panelId?: string | null;
}): boolean {
  const { placement, parentId, panelId } = params;
  return Boolean(
    placement
      && placement.parentId === parentId
      && (
        panelId === undefined
        || placement.panelId === null
        || placement.panelId === panelId
      ),
  );
}

export function resolveTrailingDraftAfterId(params: {
  placement: TrailingDraftPlacement | null | undefined;
  parentId: NodeId;
  panelId?: string | null;
  rows: readonly OutlinerRowItem[];
}): NodeId | null {
  if (!trailingDraftPlacementMatches(params)) return null;
  const afterId = params.placement?.afterId ?? null;
  if (!afterId) return null;
  return params.rows.some((row) => row.id === afterId) ? afterId : null;
}

export function insertTrailingDraftRow(
  rows: readonly OutlinerRowItem[],
  draftRow: OutlinerRowItem,
  afterId: NodeId | null,
): OutlinerRowItem[] {
  if (!afterId) return [...rows, draftRow];
  const index = rows.findIndex((row) => row.id === afterId);
  if (index < 0) return [...rows, draftRow];
  return [...rows.slice(0, index + 1), draftRow, ...rows.slice(index + 1)];
}

export function insertPendingStructuralRow(
  rows: readonly OutlinerRowItem[],
  pendingRow: OutlinerRowItem,
  beforeId: NodeId | null,
  afterId: NodeId | null,
): OutlinerRowItem[] {
  const placement = resolvePendingRowPlacement({
    rows,
    change: {
      id: pendingRow.id,
      parentId: '',
      beforeId,
      afterId,
    },
    matches: (row, id) => row.id === id,
    fallbackIndex: (currentRows) => {
      const trailingIndex = currentRows.findIndex((row) => row.type === 'content' && row.draft);
      return trailingIndex >= 0 ? trailingIndex : currentRows.length;
    },
  });
  return placement ? applyPendingRowPlacement(rows, pendingRow, placement) : [...rows];
}

export function draftCreateIndex(parent: NodeProjection | undefined, afterId: NodeId | null): number | null {
  if (!afterId) return null;
  const afterIndex = parent?.children.indexOf(afterId) ?? -1;
  return afterIndex < 0 ? null : afterIndex + 1;
}

export function previousDraftSiblingId(
  rows: readonly OutlinerRowItem[],
  afterId: NodeId | null,
): NodeId | null {
  const candidateRows = rows.filter((row) => row.type === 'content' || row.type === 'field');
  if (!afterId) return candidateRows.at(-1)?.id ?? null;
  const index = candidateRows.findIndex((row) => row.id === afterId);
  return index < 0 ? null : candidateRows[index]?.id ?? null;
}

export function trailingDraftPlacementEquals(
  left: TrailingDraftPlacement | null | undefined,
  right: TrailingDraftPlacement | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.parentId === right.parentId
    && left.afterId === right.afterId
    && left.panelId === right.panelId;
}
