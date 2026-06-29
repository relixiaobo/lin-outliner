import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFilePreviewStreamRegistry, parseRangeHeader } from '../../src/main/localFilePreviewStream';
import { resolveTrustedLocalFileReference } from '../../src/main/localFileReferenceSecurity';

describe('local file preview stream registry', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lin-preview-local-stream-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('parses single byte ranges', () => {
    expect(parseRangeHeader(null, 10)).toBeNull();
    expect(parseRangeHeader('bytes=0-3', 10)).toEqual({ start: 0, end: 3 });
    expect(parseRangeHeader('bytes=4-', 10)).toEqual({ start: 4, end: 9 });
    expect(parseRangeHeader('bytes=-4', 10)).toEqual({ start: 6, end: 9 });
    expect(parseRangeHeader('bytes=8-30', 10)).toEqual({ start: 8, end: 9 });
    expect(parseRangeHeader('bytes=10-', 10)).toBe('invalid');
    expect(parseRangeHeader('bytes=4-3', 10)).toBe('invalid');
    expect(parseRangeHeader('bytes=0-1,3-4', 10)).toBe('invalid');
  });

  test('serves tokenized trusted local files with range support', async () => {
    const filePath = join(root, 'clip.mp4');
    await writeFile(filePath, '0123456789');
    const file = await resolveTrustedLocalFileReference(filePath, [root]);
    expect(file).not.toBeNull();

    const registry = new LocalFilePreviewStreamRegistry(() => [root]);
    const token = await registry.issue(file!, 'video/mp4');
    expect(token).toBeTruthy();

    const partial = await registry.serve(token!, requestWithRange('bytes=2-5'));
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-type')).toBe('video/mp4');
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(partial.headers.get('content-length')).toBe('4');
    expect(await partial.text()).toBe('2345');

    const full = await registry.serve(token!, requestWithRange(null));
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('content-length')).toBe('10');
    expect(await full.text()).toBe('0123456789');

    const invalid = await registry.serve(token!, requestWithRange('bytes=20-30'));
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('content-range')).toBe('bytes */10');
  });

  test('rejects missing tokens and files that no longer resolve inside the trusted root', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'lin-preview-local-stream-outside-'));
    try {
      const filePath = join(root, 'file.txt');
      const outsidePath = join(outsideRoot, 'outside.txt');
      await writeFile(filePath, 'inside');
      await writeFile(outsidePath, 'outside');
      const file = await resolveTrustedLocalFileReference(filePath, [root]);
      expect(file).not.toBeNull();

      const registry = new LocalFilePreviewStreamRegistry(() => [root]);
      const token = await registry.issue(file!, 'text/plain');
      expect(token).toBeTruthy();
      await rm(filePath);
      await symlink(outsidePath, filePath);

      expect((await registry.serve('missing-token', requestWithRange(null))).status).toBe(404);
      expect((await registry.serve(token!, requestWithRange(null))).status).toBe(404);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

function requestWithRange(range: string | null): Pick<Request, 'headers'> {
  const headers = new Headers();
  if (range) headers.set('range', range);
  return { headers };
}
