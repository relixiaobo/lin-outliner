import type { NodeId, NodeProjection } from '../api/types';
import type { TrailingDraftPlacement } from './document';
import type { OutlinerRowItem } from './outlinerRows';

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
