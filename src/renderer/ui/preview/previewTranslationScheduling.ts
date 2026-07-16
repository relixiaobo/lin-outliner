import { URL_PAGE_TRANSLATION_MAX_ACTIVE_BATCHES } from '../../../core/urlPageTranslation';

export const PREVIEW_TRANSLATION_MAX_CONCURRENT_REQUESTS = URL_PAGE_TRANSLATION_MAX_ACTIVE_BATCHES;

export const VISIBLE_TRANSLATION_BATCH_LIMITS = Object.freeze({
  maxBlocks: 8,
  maxChars: 2_000,
});

export const PREFETCH_TRANSLATION_BATCH_LIMITS = Object.freeze({
  maxBlocks: 16,
  maxChars: 4_000,
});

export const PREVIEW_TRANSLATION_MIN_LOOKAHEAD_VIEWPORTS = 3;
export const PREVIEW_TRANSLATION_MAX_LOOKAHEAD_VIEWPORTS = 8;
export const PREVIEW_TRANSLATION_DEFAULT_LATENCY_MS = 1_500;
export const PREVIEW_TRANSLATION_MAX_LATENCY_MS = 30_000;

const LOOKAHEAD_SAFETY_MS = 2_000;
const LATENCY_SAMPLE_LIMIT = 12;

export function previewTranslationLookaheadViewports(
  velocityViewportsPerMs: number,
  requestLatencyMs: number,
): number {
  const velocity = Number.isFinite(velocityViewportsPerMs)
    ? Math.max(0, Math.abs(velocityViewportsPerMs))
    : 0;
  const latency = Number.isFinite(requestLatencyMs)
    ? Math.max(0, Math.min(PREVIEW_TRANSLATION_MAX_LATENCY_MS, requestLatencyMs))
    : PREVIEW_TRANSLATION_DEFAULT_LATENCY_MS;
  const predicted = Math.ceil(velocity * (latency + LOOKAHEAD_SAFETY_MS));
  return Math.max(
    PREVIEW_TRANSLATION_MIN_LOOKAHEAD_VIEWPORTS,
    Math.min(PREVIEW_TRANSLATION_MAX_LOOKAHEAD_VIEWPORTS, predicted),
  );
}

export class PreviewTranslationLatencyTracker {
  private readonly samples: number[] = [];

  get estimateMs(): number {
    if (this.samples.length === 0) return PREVIEW_TRANSLATION_DEFAULT_LATENCY_MS;
    return Math.max(...this.samples);
  }

  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.samples.push(Math.max(1, Math.min(PREVIEW_TRANSLATION_MAX_LATENCY_MS, durationMs)));
    if (this.samples.length > LATENCY_SAMPLE_LIMIT) this.samples.shift();
  }
}
