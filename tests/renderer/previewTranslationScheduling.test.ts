import { describe, expect, test } from 'bun:test';
import {
  PREFETCH_TRANSLATION_BATCH_LIMITS,
  PREVIEW_TRANSLATION_MAX_CONCURRENT_REQUESTS,
  PreviewTranslationLatencyTracker,
  VISIBLE_TRANSLATION_BATCH_LIMITS,
  previewTranslationLookaheadViewports,
} from '../../src/renderer/ui/preview/previewTranslationScheduling';

describe('preview translation scheduling policy', () => {
  test('uses latency-sized visible batches and throughput-sized prefetch batches', () => {
    expect(VISIBLE_TRANSLATION_BATCH_LIMITS).toEqual({ maxBlocks: 8, maxChars: 2_000 });
    expect(PREFETCH_TRANSLATION_BATCH_LIMITS).toEqual({ maxBlocks: 16, maxChars: 4_000 });
    expect(PREVIEW_TRANSLATION_MAX_CONCURRENT_REQUESTS).toBe(6);
  });

  test('keeps a stationary floor and expands lookahead with reading velocity and latency', () => {
    expect(previewTranslationLookaheadViewports(0, 1_500)).toBe(3);
    expect(previewTranslationLookaheadViewports(0.0002, 3_000)).toBe(3);
    expect(previewTranslationLookaheadViewports(0.001, 3_000)).toBe(5);
    expect(previewTranslationLookaheadViewports(0.01, 30_000)).toBe(8);
  });

  test('tracks a bounded high-latency estimate without one fast response hiding slower work', () => {
    const tracker = new PreviewTranslationLatencyTracker();
    expect(tracker.estimateMs).toBe(1_500);
    tracker.record(400);
    tracker.record(800);
    tracker.record(2_400);
    tracker.record(1_800);
    expect(tracker.estimateMs).toBe(2_400);
    tracker.record(50_000);
    expect(tracker.estimateMs).toBe(30_000);
  });
});
