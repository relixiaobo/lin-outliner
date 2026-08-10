import { afterEach, describe, expect, test } from 'bun:test';
import {
  readEpubReadingPosition,
  readPdfReadingPosition,
  writeEpubReadingPosition,
  writePdfReadingPosition,
} from '../../src/renderer/ui/preview/readingPositionStore';

const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
    return;
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

describe('reading position store', () => {
  test('retains PDF positions in memory when localStorage is unavailable', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        get localStorage(): never {
          throw new Error('storage unavailable');
        },
      },
    });
    const targetKey = `pdf-without-storage-${Date.now()}`;
    const position = {
      pageNumber: 12,
      pageOffsetRatio: 0.42,
      updatedAt: 1_234,
    };

    writePdfReadingPosition(targetKey, position);

    expect(readPdfReadingPosition(targetKey)).toEqual(position);
  });

  test('retains EPUB positions in memory when localStorage is unavailable', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        get localStorage(): never {
          throw new Error('storage unavailable');
        },
      },
    });
    const targetKey = `epub-without-storage-${Date.now()}`;
    const position = {
      sectionIndex: 12,
      sectionOffsetRatio: 0.42,
      updatedAt: 1_234,
    };

    writeEpubReadingPosition(targetKey, position);

    expect(readEpubReadingPosition(targetKey)).toEqual(position);
  });
});
