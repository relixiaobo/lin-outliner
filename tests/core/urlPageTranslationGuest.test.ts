import { describe, expect, test } from 'bun:test';
import {
  URL_CAPTION_TRANSLATION_MAX_BATCH_CHARS,
  URL_CAPTION_TRANSLATION_MAX_BLOCKS,
  URL_PAGE_TRANSLATION_MAX_BATCH_CHARS,
  URL_PAGE_TRANSLATION_MAX_BLOCKS,
} from '../../src/core/urlPageTranslation';
import {
  URL_PAGE_TRANSLATION_MAX_RUNTIME_SOURCE_CHARS,
  validateUrlPageTranslationGuestCommand,
} from '../../src/core/urlPageTranslationGuest';

function nextBatchCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: 'next-batch',
    options: {
      activeBatches: [],
      captionMaxBlocks: URL_CAPTION_TRANSLATION_MAX_BLOCKS,
      captionMaxChars: URL_CAPTION_TRANSLATION_MAX_BATCH_CHARS,
      maxBlocks: URL_PAGE_TRANSLATION_MAX_BLOCKS,
      maxChars: URL_PAGE_TRANSLATION_MAX_BATCH_CHARS,
      estimatedLatencyMs: 1_500,
      queueVisible: true,
      retryOnly: false,
      visibleOnly: false,
      ...overrides,
    },
  };
}

describe('URL page translation guest command validation', () => {
  test('allows bounded sixteen-block page and caption batches', () => {
    expect(validateUrlPageTranslationGuestCommand(nextBatchCommand())).toMatchObject({
      operation: 'next-batch',
      options: {
        captionMaxBlocks: URL_CAPTION_TRANSLATION_MAX_BLOCKS,
        maxBlocks: URL_PAGE_TRANSLATION_MAX_BLOCKS,
      },
    });
    expect(() => validateUrlPageTranslationGuestCommand(nextBatchCommand({
      maxBlocks: URL_PAGE_TRANSLATION_MAX_BLOCKS + 1,
    }))).toThrow('block count');
    expect(() => validateUrlPageTranslationGuestCommand(nextBatchCommand({
      captionMaxBlocks: URL_CAPTION_TRANSLATION_MAX_BLOCKS + 1,
    }))).toThrow('caption block count');
  });

  test('allows six active batches and rejects unbounded scheduling inputs', () => {
    const activeBatches = Array.from({ length: 6 }, (_, index) => ({
      ids: [`b${index}`],
      requestId: `request:${index}`,
    }));
    expect(validateUrlPageTranslationGuestCommand(nextBatchCommand({ activeBatches }))).toMatchObject({
      operation: 'next-batch',
      options: { activeBatches, estimatedLatencyMs: 1_500, queueVisible: true },
    });
    expect(() => validateUrlPageTranslationGuestCommand(nextBatchCommand({
      activeBatches: [...activeBatches, { ids: ['extra'], requestId: 'request:extra' }],
    }))).toThrow('active URL page translation batches');
    expect(() => validateUrlPageTranslationGuestCommand(nextBatchCommand({ estimatedLatencyMs: 60_001 })))
      .toThrow('estimated latency');
    expect(() => validateUrlPageTranslationGuestCommand(nextBatchCommand({ queueVisible: 'yes' })))
      .toThrow('batch mode');
  });

  test('validates bounded isolated-world work waits', () => {
    expect(validateUrlPageTranslationGuestCommand({
      operation: 'wait-for-work',
      afterRevision: 42,
      timeoutMs: 1_000,
    })).toEqual({ operation: 'wait-for-work', afterRevision: 42, timeoutMs: 1_000 });
    expect(() => validateUrlPageTranslationGuestCommand({
      operation: 'wait-for-work',
      afterRevision: -1,
      timeoutMs: 1_000,
    })).toThrow('work wait');
    expect(() => validateUrlPageTranslationGuestCommand({
      operation: 'wait-for-work',
      afterRevision: 0,
      timeoutMs: 60_000,
    })).toThrow('work wait');
  });

  test('rejects an oversized isolated-world runtime source', () => {
    expect(() => validateUrlPageTranslationGuestCommand({
      operation: 'initialize',
      labels: { retry: 'Retry', translating: 'Translating' },
      runtimeSource: 'x'.repeat(URL_PAGE_TRANSLATION_MAX_RUNTIME_SOURCE_CHARS + 1),
      targetLanguage: 'en',
    })).toThrow('initialization');
  });
});
