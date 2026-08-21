import { describe, expect, test } from 'bun:test';
import {
  buildTranscriptVirtualLayout,
  clampTranscriptScrollTop,
  decideTranscriptCoverage,
  mergeTranscriptTurnViewports,
  nextTranscriptScrollTransaction,
  transcriptRangeCoversViewport,
  transcriptScrollTransactionIsCurrent,
  transcriptTurnItemViewport,
  transcriptTurnViewport,
  transcriptUsesVirtualWindow,
  visibleTranscriptTurnRange,
  TRANSCRIPT_VIRTUAL_MIN_TURNS,
} from '../../src/renderer/agent/transcriptVirtualWindow';

const rows = Array.from({ length: 12 }, (_, index) => ({ id: `turn-${index + 1}` }));
const uniformLayout = buildTranscriptVirtualLayout(rows, new Map(), () => 100);

describe('transcript virtual window', () => {
  test('keeps the threshold Turn in flow layout and virtualizes the next one', () => {
    expect(transcriptUsesVirtualWindow(TRANSCRIPT_VIRTUAL_MIN_TURNS)).toBe(false);
    expect(transcriptUsesVirtualWindow(TRANSCRIPT_VIRTUAL_MIN_TURNS + 1)).toBe(true);
  });

  test('builds variable-height slots from measurements before estimates', () => {
    const layout = buildTranscriptVirtualLayout(
      rows.slice(0, 3),
      new Map([['turn-2', 180]]),
      () => 100,
    );
    expect(layout.items).toEqual([
      { height: 100, top: 0 },
      { height: 180, top: 112 },
      { height: 100, top: 304 },
    ]);
    expect(layout.totalHeight).toBe(404);
  });

  test('normalizes the viewport against the Turns origin rather than the scroller', () => {
    const viewport = transcriptTurnViewport({
      currentScrollTop: 900,
      scrollerTop: 100,
      targetScrollTop: 1_700,
      totalHeight: 2_000,
      turnsTop: 400,
      viewportHeight: 600,
    });
    // The live Turns origin is content offset 1,200, so 1,700 is Turn-local 500.
    expect(viewport).toEqual({ bottom: 1_100, top: 500 });
  });

  test('treats a viewport wholly inside a long Goal as requiring no Turn', () => {
    const viewport = transcriptTurnViewport({
      currentScrollTop: 0,
      scrollerTop: 100,
      targetScrollTop: 400,
      totalHeight: uniformLayout.totalHeight,
      turnsTop: 1_300,
      viewportHeight: 600,
    });
    expect(viewport).toEqual({ bottom: 0, top: 0 });
    expect(transcriptRangeCoversViewport(uniformLayout, { end: 1, start: 0 }, viewport)).toBe(true);
  });

  test('selects a range from the Turn-local viewport and proves exact coverage', () => {
    const viewport = { bottom: uniformLayout.totalHeight, top: 1_100 };
    const staleRange = { end: 3, start: 0 };
    expect(transcriptRangeCoversViewport(uniformLayout, staleRange, viewport)).toBe(false);
    const nextRange = visibleTranscriptTurnRange(uniformLayout, viewport);
    expect(nextRange.start).toBeGreaterThan(0);
    expect(transcriptRangeCoversViewport(uniformLayout, nextRange, viewport)).toBe(true);
  });

  test('derives a target Turn viewport before that Turn has mounted', () => {
    const viewport = transcriptTurnItemViewport(uniformLayout, 9);
    expect(viewport).toEqual({ bottom: 1_108, top: 1_008 });
    const range = visibleTranscriptTurnRange(uniformLayout, viewport!);
    expect(range.start).toBeLessThanOrEqual(9);
    expect(range.end).toBeGreaterThan(9);
    expect(transcriptRangeCoversViewport(uniformLayout, range, viewport!)).toBe(true);
    expect(transcriptTurnItemViewport(uniformLayout, rows.length)).toBeNull();
  });

  test('distinguishes imperative repair from lifecycle preparation', () => {
    const viewport = { bottom: 1_250, top: 900 };
    const staleRange = { end: 3, start: 0 };
    expect(decideTranscriptCoverage(true, uniformLayout, staleRange, viewport, 'imperative'))
      .toBe('commit-before-return');
    expect(decideTranscriptCoverage(true, uniformLayout, staleRange, viewport, 'layout'))
      .toBe('prepare-before-write');
    expect(decideTranscriptCoverage(false, uniformLayout, staleRange, viewport, 'imperative'))
      .toBe('covered');
  });

  test('covers anchor travel with one contiguous viewport request', () => {
    expect(mergeTranscriptTurnViewports(
      { bottom: 300, top: 0 },
      { bottom: 1_100, top: 800 },
    )).toEqual({ bottom: 1_100, top: 0 });
  });

  test('replays the browser-clamped target and rejects a stale transaction', () => {
    expect(clampTranscriptScrollTop(2_000, 1_500, 600)).toBe(900);
    const transaction = nextTranscriptScrollTransaction(6, 2_000);
    expect(transcriptScrollTransactionIsCurrent(transaction, 7)).toBe(true);
    expect(transcriptScrollTransactionIsCurrent(transaction, 8)).toBe(false);
    const clampedViewport = transcriptTurnViewport({
      currentScrollTop: 0,
      scrollerTop: 0,
      targetScrollTop: clampTranscriptScrollTop(2_000, 1_500, 600),
      totalHeight: uniformLayout.totalHeight,
      turnsTop: 0,
      viewportHeight: 600,
    });
    const range = visibleTranscriptTurnRange(uniformLayout, clampedViewport);
    expect(transcriptRangeCoversViewport(uniformLayout, range, clampedViewport)).toBe(true);
  });
});
