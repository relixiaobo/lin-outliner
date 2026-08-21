export const TRANSCRIPT_ROW_GAP_PX = 12;
export const TRANSCRIPT_ROW_ESTIMATE_PX = 104;
export const TRANSCRIPT_VIRTUAL_MIN_TURNS = 8;
export const TRANSCRIPT_VIRTUAL_OVERSCAN_PX = 240;

export interface TranscriptVirtualItem {
  readonly height: number;
  readonly top: number;
}

export interface TranscriptVirtualLayout {
  readonly items: readonly TranscriptVirtualItem[];
  readonly totalHeight: number;
}

export interface TranscriptVirtualRange {
  readonly end: number;
  readonly start: number;
}

export interface TranscriptTurnViewport {
  readonly bottom: number;
  readonly top: number;
}

export interface TranscriptScrollTransaction {
  readonly generation: number;
  readonly targetTop: number;
}

export type TranscriptCoveragePhase = 'imperative' | 'layout';
export type TranscriptCoverageDecision =
  | 'covered'
  | 'commit-before-return'
  | 'prepare-before-write';

interface TranscriptRowIdentity {
  readonly id: string;
}

interface TranscriptViewportGeometry {
  readonly currentScrollTop: number;
  readonly scrollerTop: number;
  readonly targetScrollTop: number;
  readonly totalHeight: number;
  readonly turnsTop: number;
  readonly viewportHeight: number;
}

export function transcriptUsesVirtualWindow(turnCount: number): boolean {
  return turnCount > TRANSCRIPT_VIRTUAL_MIN_TURNS;
}

export function buildTranscriptVirtualLayout<Row extends TranscriptRowIdentity>(
  rows: readonly Row[],
  measuredHeights: ReadonlyMap<string, number>,
  estimateHeight: (row: Row) => number,
): TranscriptVirtualLayout {
  const items: TranscriptVirtualItem[] = [];
  let top = 0;
  for (const row of rows) {
    const height = measuredHeights.get(row.id) ?? estimateHeight(row);
    items.push({ height, top });
    top += height + TRANSCRIPT_ROW_GAP_PX;
  }
  return {
    items,
    totalHeight: rows.length > 0 ? top - TRANSCRIPT_ROW_GAP_PX : 0,
  };
}

export function clampTranscriptScrollTop(
  targetTop: number,
  scrollHeight: number,
  viewportHeight: number,
): number {
  return Math.max(0, Math.min(Math.max(0, scrollHeight - viewportHeight), targetTop));
}

export function transcriptTurnViewport({
  currentScrollTop,
  scrollerTop,
  targetScrollTop,
  totalHeight,
  turnsTop,
  viewportHeight,
}: TranscriptViewportGeometry): TranscriptTurnViewport {
  const turnOrigin = currentScrollTop + turnsTop - scrollerTop;
  const localTop = targetScrollTop - turnOrigin;
  return {
    bottom: Math.max(0, Math.min(totalHeight, localTop + viewportHeight)),
    top: Math.max(0, Math.min(totalHeight, localTop)),
  };
}

export function mergeTranscriptTurnViewports(
  first: TranscriptTurnViewport,
  second: TranscriptTurnViewport,
): TranscriptTurnViewport {
  return {
    bottom: Math.max(first.bottom, second.bottom),
    top: Math.min(first.top, second.top),
  };
}

export function sameTranscriptTurnViewport(
  first: TranscriptTurnViewport,
  second: TranscriptTurnViewport,
): boolean {
  return Math.abs(first.top - second.top) < 0.5
    && Math.abs(first.bottom - second.bottom) < 0.5;
}

export function transcriptTurnItemViewport(
  layout: TranscriptVirtualLayout,
  index: number,
): TranscriptTurnViewport | null {
  const item = layout.items[index];
  if (!item) return null;
  return {
    bottom: item.top + item.height,
    top: item.top,
  };
}

function firstItemEndingAfter(items: readonly TranscriptVirtualItem[], y: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const item = items[middle]!;
    if (item.top + item.height <= y) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstItemStartingAtOrAfter(items: readonly TranscriptVirtualItem[], y: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (items[middle]!.top < y) low = middle + 1;
    else high = middle;
  }
  return low;
}

function intersectingTurnRange(
  layout: TranscriptVirtualLayout,
  viewport: TranscriptTurnViewport,
): TranscriptVirtualRange {
  if (viewport.bottom <= viewport.top || layout.items.length === 0) return { end: 0, start: 0 };
  const start = firstItemEndingAfter(layout.items, viewport.top);
  const end = firstItemStartingAtOrAfter(layout.items, viewport.bottom);
  return { end, start: Math.min(start, end) };
}

export function visibleTranscriptTurnRange(
  layout: TranscriptVirtualLayout,
  viewport: TranscriptTurnViewport,
): TranscriptVirtualRange {
  const itemCount = layout.items.length;
  if (itemCount === 0) return { end: 0, start: 0 };
  const minimumY = Math.max(0, viewport.top - TRANSCRIPT_VIRTUAL_OVERSCAN_PX);
  const maximumY = Math.min(
    layout.totalHeight,
    viewport.bottom + TRANSCRIPT_VIRTUAL_OVERSCAN_PX,
  );
  const start = Math.max(0, firstItemEndingAfter(layout.items, minimumY) - 1);
  const end = Math.min(
    itemCount,
    firstItemStartingAtOrAfter(layout.items, maximumY) + 1,
  );
  return { end: Math.max(end, Math.min(itemCount, start + 1)), start };
}

export function transcriptRangeCoversViewport(
  layout: TranscriptVirtualLayout,
  committedRange: TranscriptVirtualRange,
  viewport: TranscriptTurnViewport,
): boolean {
  const required = intersectingTurnRange(layout, viewport);
  if (required.end <= required.start) return true;
  return committedRange.start <= required.start && committedRange.end >= required.end;
}

export function decideTranscriptCoverage(
  virtualized: boolean,
  layout: TranscriptVirtualLayout,
  committedRange: TranscriptVirtualRange,
  viewport: TranscriptTurnViewport,
  phase: TranscriptCoveragePhase,
): TranscriptCoverageDecision {
  if (!virtualized || transcriptRangeCoversViewport(layout, committedRange, viewport)) {
    return 'covered';
  }
  return phase === 'imperative' ? 'commit-before-return' : 'prepare-before-write';
}

export function nextTranscriptScrollTransaction(
  currentGeneration: number,
  targetTop: number,
): TranscriptScrollTransaction {
  return { generation: currentGeneration + 1, targetTop };
}

export function transcriptScrollTransactionIsCurrent(
  transaction: TranscriptScrollTransaction,
  currentGeneration: number,
): boolean {
  return transaction.generation === currentGeneration;
}
