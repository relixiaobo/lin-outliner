import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetService, imageDimensions, sniffMimeType } from '../../src/main/assetService';

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

describe('AssetService', () => {
  let root: string;
  let service: AssetService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lin-asset-test-'));
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

  test('ingested ids survive lin-asset:// URL hostname normalization (lowercasing)', async () => {
    // The protocol handler reads the id from `new URL(req.url).hostname`, which
    // lowercases. Ids must therefore be lowercase so they still resolve.
    for (let i = 0; i < 8; i += 1) {
      const meta = await service.ingest({ kind: 'buffer', data: pngBytes(4, 4) });
      const hostname = new URL(`lin-asset://${meta.id}`).hostname;
      expect(hostname).toBe(meta.id);
      const response = await service.serve(hostname);
      expect(response.status).toBe(200);
    }
  });

  test('serve streams the bytes with the recorded MIME and 404s missing assets', async () => {
    const meta = await service.ingest({ kind: 'buffer', data: pngBytes(10, 10) });
    const ok = await service.serve(meta.id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(pngBytes(10, 10));

    const missing = await service.serve('doesnotexist000000000');
    expect(missing.status).toBe(404);
  });

  test('delete removes the bytes and sidecar', async () => {
    const meta = await service.ingest({ kind: 'buffer', data: pngBytes(10, 10) });
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
});

describe('sniffMimeType', () => {
  test('detects common formats by magic bytes', () => {
    expect(sniffMimeType(pngBytes(1, 1))).toBe('image/png');
    expect(sniffMimeType(gifBytes(1, 1))).toBe('image/gif');
    expect(sniffMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMimeType(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe('application/pdf');
  });

  test('falls back to the filename extension when bytes are inconclusive', () => {
    expect(sniffMimeType(new Uint8Array([0, 0, 0]), 'note.svg')).toBe('image/svg+xml');
    expect(sniffMimeType(new Uint8Array([0, 0, 0]), 'mystery')).toBeUndefined();
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
