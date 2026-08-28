import { describe, expect, test } from 'bun:test';
import {
  assetImageDimensions,
  assetMediaDurationMs,
  assetPdfPageCount,
  mimeTypeForAssetFilename,
  sniffAssetMimeType,
} from '../../src/core/assetMetadata';

describe('asset metadata', () => {
  test('detects common formats by magic bytes before filename fallback', () => {
    expect(sniffAssetMimeType(pngBytes(1, 1))).toBe('image/png');
    expect(sniffAssetMimeType(gifBytes(1, 1))).toBe('image/gif');
    expect(sniffAssetMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffAssetMimeType(Buffer.from('%PDF-'))).toBe('application/pdf');
    expect(sniffAssetMimeType(wavBytes(100))).toBe('audio/wav');
    expect(sniffAssetMimeType(Buffer.from('fLaC'))).toBe('audio/flac');
    expect(sniffAssetMimeType(new Uint8Array([0xff, 0xf1]))).toBe('audio/aac');
    expect(sniffAssetMimeType(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('application/zip');
    expect(sniffAssetMimeType(Buffer.from('%PDF-'), 'renamed.epub')).toBe('application/pdf');
  });

  test('uses filename fallback while keeping EPUB distinct from ZIP', () => {
    expect(sniffAssetMimeType(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'book.epub'))
      .toBe('application/epub+zip');
    expect(sniffAssetMimeType(Buffer.from('OggS'), 'clip.ogv')).toBe('video/ogg');
    expect(sniffAssetMimeType(new Uint8Array([0, 0, 0]), 'note.svg')).toBe('image/svg+xml');
    expect(sniffAssetMimeType(new Uint8Array([0, 0, 0]), 'mystery')).toBeUndefined();
  });

  test('keeps media filename inference aligned with ingestion', () => {
    expect(mimeTypeForAssetFilename('clip.mp4')).toBe('video/mp4');
    expect(mimeTypeForAssetFilename('clip.m4v')).toBe('video/mp4');
    expect(mimeTypeForAssetFilename('clip.mov')).toBe('video/quicktime');
    expect(mimeTypeForAssetFilename('memo.m4a')).toBe('audio/mp4');
    expect(mimeTypeForAssetFilename('voice.opus')).toBe('audio/opus');
    expect(mimeTypeForAssetFilename('screening.ogv')).toBe('video/ogg');
    expect(mimeTypeForAssetFilename('screening.mkv')).toBe('video/x-matroska');
  });

  test('derives image dimensions, PDF page count, and WAV duration', () => {
    expect(assetImageDimensions(pngBytes(640, 480), 'image/png')).toEqual({ width: 640, height: 480 });
    expect(assetImageDimensions(gifBytes(32, 16), 'image/gif')).toEqual({ width: 32, height: 16 });
    expect(assetImageDimensions(new Uint8Array([1, 2, 3]), 'application/pdf')).toBeUndefined();
    expect(assetPdfPageCount(pdfBytes(2))).toBe(2);
    expect(assetMediaDurationMs(wavBytes(1_250), 'audio/wav')).toBe(1_250);
  });
});

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function gifBytes(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(10);
  bytes.write('GIF89a', 0, 'ascii');
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function pdfBytes(pages: number): Uint8Array {
  const pageObjects = Array.from({ length: pages }, (_, index) => (
    `${index + 2} 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n`
  )).join('');
  return Buffer.from(`%PDF-1.4\n${pageObjects}%%EOF\n`);
}

function wavBytes(durationMs: number): Uint8Array {
  const sampleRate = 8_000;
  const byteRate = sampleRate * 2;
  const dataSize = Math.round(byteRate * durationMs / 1_000);
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(byteRate, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataSize, 40);
  return bytes;
}
