import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetService, imageDimensions, mimeTypeForFilename, sniffMimeType } from '../../src/main/assetService';

function pngBytes(width: number, height: number): Uint8Array {
  const buf = Buffer.alloc(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR chunk length
  buf.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return new Uint8Array(buf);
}

function gifBytes(width: number, height: number): Uint8Array {
  const buf = Buffer.alloc(10);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return new Uint8Array(buf);
}

function wavBytes(durationMs: number): Uint8Array {
  const sampleRate = 8000;
  const byteRate = sampleRate * 2;
  const dataSize = Math.round(byteRate * durationMs / 1000);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return new Uint8Array(buf);
}

function pdfBytes(pages: number): Uint8Array {
  const pageObjects = Array.from({ length: pages }, (_, index) => (
    `${index + 2} 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n`
  )).join('');
  return new TextEncoder().encode(`%PDF-1.4\n1 0 obj\n<< /Type /Pages /Count ${pages} >>\nendobj\n${pageObjects}%%EOF\n`);
}

describe('AssetService', () => {
  let root: string;
  let service: AssetService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lin-outliner-asset-test-'));
    service = new AssetService(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('ingests an image buffer, records metadata, and writes bytes + sidecar', async () => {
    const meta = await service.ingest({ kind: 'buffer', data: pngBytes(120, 80), originalFilename: 'shot.png' });
    expect(meta).toMatchObject({
      mimeType: 'image/png',
      byteSize: 24,
      originalFilename: 'shot.png',
      imageWidth: 120,
      imageHeight: 80,
    });
    expect(meta.id).toMatch(/^[A-Za-z0-9_-]{21}$/);

    const entries = await readdir(root);
    expect(entries).toContain(`${meta.id}.png`);
    expect(entries).toContain(`${meta.id}.meta.json`);

    // ingest resolves only after both files are durable, and the metadata sidecar
    // keeps the existing pretty-without-trailing-newline format.
    expect(await readFile(join(root, `${meta.id}.png`))).toEqual(Buffer.from(pngBytes(120, 80)));
    const sidecar = await readFile(join(root, `${meta.id}.meta.json`), 'utf8');
    expect(sidecar.endsWith('\n')).toBe(false);
    expect(JSON.parse(sidecar)).toMatchObject({
      id: meta.id,
      mimeType: 'image/png',
      originalFilename: 'shot.png',
    });
  });

  test('lookup returns persisted metadata after a fresh service reads the sidecar', async () => {
    const meta = await service.ingest({ kind: 'buffer', data: gifBytes(64, 48) });
    const reader = new AssetService(root);
    expect(await reader.lookup(meta.id)).toMatchObject({
      id: meta.id,
      mimeType: 'image/gif',
      imageWidth: 64,
      imageHeight: 48,
    });
  });

  test('ingested ids survive asset:// URL hostname normalization (lowercasing)', async () => {
    // The protocol handler reads the id from `new URL(req.url).hostname`, which
    // lowercases. Ids must therefore be lowercase so they still resolve.
    for (let i = 0; i < 8; i += 1) {
      const meta = await service.ingest({ kind: 'buffer', data: pngBytes(4, 4) });
      const hostname = new URL(`asset://${meta.id}`).hostname;
      expect(hostname).toBe(meta.id);
      const response = await service.serve(hostname);
      expect(response.status).toBe(200);
    }
  });

  test('serve streams the bytes with the recorded MIME, byte range support, and 404s missing assets', async () => {
    const meta = await service.ingest({ kind: 'buffer', data: pngBytes(10, 10) });
    const ok = await service.serve(meta.id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(ok.headers.get('accept-ranges')).toBe('bytes');
    expect(ok.headers.get('content-length')).toBe('24');
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(pngBytes(10, 10));

    const partial = await service.serve(meta.id, requestWithRange('bytes=1-3'));
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 1-3/24');
    expect(partial.headers.get('content-length')).toBe('3');
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(pngBytes(10, 10).slice(1, 4));

    const invalid = await service.serve(meta.id, requestWithRange('bytes=100-200'));
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('content-range')).toBe('bytes */24');

    const missing = await service.serve('doesnotexist000000000');
    expect(missing.status).toBe(404);
  });

  test('delete removes the bytes and sidecar', async () => {
    const meta = await service.ingest({ kind: 'buffer', data: pngBytes(10, 10) });
    expect(await service.lookup(meta.id)).toMatchObject({ id: meta.id });
    await service.delete(meta.id);
    expect(await service.lookup(meta.id)).toBeNull();
    expect(await readdir(root)).toHaveLength(0);
  });

  test('rejects ids that could escape the asset directory', async () => {
    expect(service.lookup('../secret')).rejects.toThrow(/invalid asset id/);
  });

  test('falls back to octet-stream for unknown bytes', async () => {
    const meta = await service.ingest({ kind: 'buffer', data: new Uint8Array([1, 2, 3, 4]) });
    expect(meta.mimeType).toBe('application/octet-stream');
    expect(meta.imageWidth).toBeUndefined();
  });

  test('derives PDF page count metadata', async () => {
    const meta = await service.ingest({ kind: 'buffer', data: pdfBytes(2), originalFilename: 'report.pdf' });
    expect(meta).toMatchObject({
      mimeType: 'application/pdf',
      pdfPageCount: 2,
      originalFilename: 'report.pdf',
    });
  });

  test('keeps EPUB files distinct from generic ZIP archives', async () => {
    const meta = await service.ingest({
      kind: 'buffer',
      data: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      originalFilename: 'book.epub',
    });
    expect(meta).toMatchObject({
      mimeType: 'application/epub+zip',
      originalFilename: 'book.epub',
    });
    expect((await readdir(root)).some((entry) => entry.endsWith('.epub'))).toBe(true);
  });

  test('derives WAV duration metadata', async () => {
    const meta = await service.ingest({ kind: 'buffer', data: wavBytes(1250), originalFilename: 'memo.wav' });
    expect(meta).toMatchObject({
      mimeType: 'audio/wav',
      audioDurationMs: 1250,
      originalFilename: 'memo.wav',
    });
  });

  test('refuses to serve an asset file symlink that escapes the asset directory', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'lin-outliner-asset-outside-'));
    try {
      const outsideFile = join(outsideRoot, 'secret.txt');
      await writeFile(outsideFile, 'secret');
      await symlink(outsideFile, join(root, 'escapes.txt'));
      await writeFile(join(root, 'escapes.meta.json'), JSON.stringify({
        id: 'escapes',
        mimeType: 'text/plain',
        byteSize: 6,
        createdAt: Date.now(),
      }));

      expect(await service.pathFor('escapes')).toBeNull();
      expect((await service.serve('escapes')).status).toBe(404);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

function requestWithRange(range: string): Pick<Request, 'headers'> {
  const headers = new Headers();
  headers.set('range', range);
  return { headers };
}

describe('sniffMimeType', () => {
  test('detects common formats by magic bytes', () => {
    expect(sniffMimeType(pngBytes(1, 1))).toBe('image/png');
    expect(sniffMimeType(gifBytes(1, 1))).toBe('image/gif');
    expect(sniffMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMimeType(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe('application/pdf');
    expect(sniffMimeType(wavBytes(100))).toBe('audio/wav');
    expect(sniffMimeType(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('application/zip');
  });

  test('falls back to the filename extension when bytes are inconclusive', () => {
    expect(sniffMimeType(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'book.epub')).toBe('application/epub+zip');
    expect(sniffMimeType(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), 'renamed.epub')).toBe('application/pdf');
    expect(sniffMimeType(new Uint8Array([0, 0, 0]), 'note.svg')).toBe('image/svg+xml');
    expect(sniffMimeType(new Uint8Array([0, 0, 0]), 'mystery')).toBeUndefined();
  });
});

describe('mimeTypeForFilename', () => {
  test('keeps local-file preview MIME inference aligned with asset ingestion', () => {
    expect(mimeTypeForFilename('clip.mp4')).toBe('video/mp4');
    expect(mimeTypeForFilename('clip.m4v')).toBe('video/mp4');
    expect(mimeTypeForFilename('clip.mov')).toBe('video/quicktime');
    expect(mimeTypeForFilename('clip.webm')).toBe('video/webm');
    expect(mimeTypeForFilename('memo.mp3')).toBe('audio/mpeg');
    expect(mimeTypeForFilename('memo.m4a')).toBe('audio/mp4');
  });
});

describe('imageDimensions', () => {
  test('reads PNG and GIF intrinsic sizes', () => {
    expect(imageDimensions(pngBytes(640, 480), 'image/png')).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(gifBytes(32, 16), 'image/gif')).toEqual({ width: 32, height: 16 });
  });

  test('returns undefined for unsupported types', () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3]), 'application/pdf')).toBeUndefined();
  });
});
