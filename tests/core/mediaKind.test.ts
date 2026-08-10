import { describe, expect, test } from 'bun:test';
import { mediaKindForMimeType } from '../../src/core/mediaKind';

describe('mediaKindForMimeType', () => {
  test('normalizes explicit image, audio, and video MIME families', () => {
    expect(mediaKindForMimeType(' IMAGE/SVG+XML ')).toBe('image');
    expect(mediaKindForMimeType('audio/flac')).toBe('audio');
    expect(mediaKindForMimeType('video/x-matroska')).toBe('video');
  });

  test('does not infer media from generic or non-media MIME families', () => {
    expect(mediaKindForMimeType('application/octet-stream')).toBeNull();
    expect(mediaKindForMimeType('application/ogg')).toBeNull();
    expect(mediaKindForMimeType('application/pdf')).toBeNull();
    expect(mediaKindForMimeType(undefined)).toBeNull();
  });
});
