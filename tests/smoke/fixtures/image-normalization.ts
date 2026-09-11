import { app, nativeImage } from 'electron';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBoundedAgentImage as fromFile, prepareBoundedAgentImageBytes as fromBytes } from '../../../src/main/agent/normalizeImageObservation';
import { MAX_IMAGE_ATTACHMENT_SOURCE_BYTES, MAX_PROMPT_IMAGE_BYTES } from '../../../src/core/agentAttachmentLimits';

void (async () => {
await app.whenReady();
const root = await mkdtemp(join(tmpdir(), 'tenon-pixel-decoder-'));
try {
  // Four unequal quadrants and transparency make an icon/crop/rotation observable.
  const width = 80, height = 40;
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = y < 12 ? (x < 24 ? [0, 0, 255, 255] : [0, 255, 0, 255])
      : (x < 24 ? [255, 0, 0, 255] : [0, 0, 0, 0]);
    bitmap.set(color, (y * width + x) * 4);
  }
  const source = nativeImage.createFromBitmap(bitmap, { width, height });
  const png = source.toPNG();
  const original = source.toBitmap();
  const normalized = await fromBytes(png, 'bytes');
  assert.deepEqual(nativeImage.createFromBuffer(normalized.bytes).toBitmap(), original);
  for (const name of ['marked.png', 'marked.blob', 'marked']) {
    const path = join(root, name);
    await writeFile(path, png);
    const result = await fromFile(path, name);
    assert.deepEqual(result.bytes, normalized.bytes);
    assert.deepEqual(result.sourceDimensions, { width, height });
    assert.deepEqual(result.dimensions, { width, height });
  }
  // EXIF orientation 6 rotates the stored JPEG 90 degrees clockwise.
  const jpeg = source.toJPEG(95);
  const exif = Buffer.from('ffe1002245786966000049492a0008000000010012010300010000000600000000000000', 'hex');
  const oriented = Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
  const result = await fromBytes(oriented, 'oriented JPEG');
  assert.deepEqual(result.sourceDimensions, { width: height, height: width });
  assert.deepEqual(result.dimensions, { width: height, height: width });
  const orientedBitmap = nativeImage.createFromBuffer(result.bytes).toBitmap();
  const topRight = (5 * height + 35) * 4;
  assert.ok(orientedBitmap[topRight + 2]! > 220 && orientedBitmap[topRight]! < 25);
  // Cover every EXIF transform using independent expected red-marker positions.
  const redPoints = [[5, 5], [74, 5], [74, 34], [5, 34], [5, 5], [34, 5], [34, 74], [5, 74]];
  for (let orientation = 1; orientation <= 8; orientation++) {
    const header = Buffer.from(exif); header.writeUInt16LE(orientation, 28);
    const bytes = Buffer.concat([jpeg.subarray(0, 2), header, jpeg.subarray(2)]);
    const rotated = await fromBytes(bytes, `orientation ${orientation}`);
    const size = orientation >= 5 ? { width: height, height: width } : { width, height };
    assert.deepEqual(rotated.dimensions, size);
    const bitmap = nativeImage.createFromBuffer(rotated.bytes).toBitmap();
    const [x, y] = redPoints[orientation - 1]!;
    const offset = (y! * size.width + x!) * 4;
    assert.ok(bitmap[offset + 2]! > 220 && bitmap[offset]! < 25, `red marker in orientation ${orientation}`);
  }
  // Incompressible pixels exercise the byte-budget encoder, not just resizing.
  const noise = Buffer.alloc(2000 * 2000 * 4); let seed = 17;
  for (let i = 0; i < noise.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      noise[i + channel] = seed >>> 24;
    }
    noise[i + 3] = 255;
  }
  const noisy = await fromBytes(nativeImage.createFromBitmap(noise, { width: 2000, height: 2000 }).toPNG(), 'noise');
  assert.equal(noisy.mimeType, 'image/jpeg');
  assert.ok(noisy.bytes.byteLength <= MAX_PROMPT_IMAGE_BYTES);
  const large = source.resize({ width: 3200, height: 1600 }).toPNG();
  const bounded = await fromBytes(large, 'large');
  assert.deepEqual(bounded.sourceDimensions, { width: 3200, height: 1600 });
  assert.deepEqual(bounded.dimensions, { width: 2000, height: 1000 });
  assert.ok(bounded.bytes.byteLength <= MAX_PROMPT_IMAGE_BYTES);
  await assert.rejects(fromBytes(Buffer.from('not an image'), 'corrupt'), /could not be decoded/);
  await assert.rejects(fromBytes(Buffer.alloc(0), 'empty'), /empty/);
  const oversized = join(root, 'oversized');
  const handle = await open(oversized, 'w');
  await handle.truncate(MAX_IMAGE_ATTACHMENT_SOURCE_BYTES + 1); await handle.close();
  await assert.rejects(fromFile(oversized, 'oversized'), /decode budget/);
  await assert.rejects(fromFile(root, 'directory'), /regular file/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fromBytes(png, 'cancelled', controller.signal), /abort/i);
  await assert.rejects(fromFile(join(root, 'missing'), 'cancelled', controller.signal), /abort/i);
  // Aborting a queued producer cannot poison the shared lane.
  const queued = new AbortController();
  const first = fromFile(join(root, 'marked.blob'), 'first');
  const second = fromBytes(png, 'queued', queued.signal); queued.abort();
  await first; await assert.rejects(second, /abort/i);
  assert.deepEqual((await fromBytes(png, 'after cancellation')).bytes, normalized.bytes);
  console.log(JSON.stringify({ ok: true, pixelFidelity: true, suffixes: ['png', 'blob', 'none'], oriented: result.dimensions, bounded: bounded.dimensions }));
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true }); app.exit(process.exitCode ?? 0);
}

})();
