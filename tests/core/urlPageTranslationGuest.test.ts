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
      retryOnly: false,
      visibleOnly: false,
      ...overrides,
    },
  };
}

describe('URL page translation guest command validation', () => {
  test('allows sixteen caption cues without widening the four-block page limit', () => {
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

  test('rejects an oversized isolated-world runtime source', () => {
    expect(() => validateUrlPageTranslationGuestCommand({
      operation: 'initialize',
      labels: { retry: 'Retry', translating: 'Translating' },
      runtimeSource: 'x'.repeat(URL_PAGE_TRANSLATION_MAX_RUNTIME_SOURCE_CHARS + 1),
      targetLanguage: 'en',
    })).toThrow('initialization');
  });
});
