import { describe, expect, test } from 'bun:test';
import type { PreviewSourceDescriptor } from '../../src/core/preview';
import { isPassivePlaybackSource, isPreviewableSource } from '../../src/renderer/ui/preview/previewRenderers';

function fileSource(overrides: Partial<Extract<PreviewSourceDescriptor, { kind: 'file' }>>): PreviewSourceDescriptor {
  return {
    kind: 'file',
    sourceKind: 'asset',
    id: 'asset:file',
    target: { kind: 'asset', assetId: 'asset-file' },
    name: 'file.bin',
    ext: 'bin',
    mimeType: 'application/octet-stream',
    entryKind: 'file',
    sizeBytes: 4,
    ...overrides,
  };
}

describe('file preview renderers', () => {
  test('treats URL sources as previewable web pages', () => {
    expect(isPreviewableSource({
      kind: 'url',
      id: 'url:https://example.com/',
      target: { kind: 'url', url: 'https://example.com/' },
      title: 'Example',
      url: 'https://example.com/',
    })).toBe(true);
  });

  test('treats HTML as previewable', () => {
    expect(isPreviewableSource(fileSource({
      name: 'index.html',
      ext: 'html',
      mimeType: 'text/html',
    }))).toBe(true);

    expect(isPreviewableSource(fileSource({
      name: 'legacy.htm',
      ext: 'htm',
      mimeType: 'application/octet-stream',
    }))).toBe(true);
  });

  test('treats EPUB as previewable while generic ZIP stays metadata-only', () => {
    expect(isPreviewableSource(fileSource({
      name: 'book.epub',
      ext: 'epub',
      mimeType: 'application/epub+zip',
    }))).toBe(true);

    expect(isPreviewableSource(fileSource({
      name: 'archive.zip',
      ext: 'zip',
      mimeType: 'application/zip',
    }))).toBe(false);
  });

  test('treats MP4 video and MP3 audio as direct-play previewable sources', () => {
    const video = fileSource({
      name: 'clip.mp4',
      ext: 'mp4',
      mimeType: 'video/mp4',
    });
    expect(isPreviewableSource(video)).toBe(true);
    expect(isPassivePlaybackSource(video)).toBe(true);

    const audio = fileSource({
      name: 'song.mp3',
      ext: 'mp3',
      mimeType: 'audio/mpeg',
    });
    expect(isPreviewableSource(audio)).toBe(true);
    expect(isPassivePlaybackSource(audio)).toBe(true);

    expect(isPreviewableSource(fileSource({
      name: 'clip.mp4',
      ext: 'mp4',
      mimeType: 'application/octet-stream',
    }))).toBe(false);
  });

  test('does not treat document previews as direct-play sources', () => {
    expect(isPassivePlaybackSource(fileSource({
      name: 'report.pdf',
      ext: 'pdf',
      mimeType: 'application/pdf',
    }))).toBe(false);
  });
});
