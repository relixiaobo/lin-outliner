import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Bytes, sha256File } from '../../src/main/fileHashing';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('file hashing', () => {
  test('hashes in-memory and file-backed bytes identically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lin-outliner-file-hashing-'));
    const filePath = join(root, 'asset.bin');
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a);
    await writeFile(filePath, bytes);

    try {
      const expected = sha256(bytes);
      expect(await sha256Bytes(bytes)).toBe(expected);
      expect(await sha256File(filePath)).toBe(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('large in-memory hashes yield before completing', async () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0x42);
    let eventLoopTurnRan = false;
    const eventLoopTurn = new Promise<void>((resolve) => {
      setImmediate(() => {
        eventLoopTurnRan = true;
        resolve();
      });
    });

    try {
      await sha256Bytes(bytes);
      expect(eventLoopTurnRan).toBe(true);
    } finally {
      await eventLoopTurn;
    }
  });
});
