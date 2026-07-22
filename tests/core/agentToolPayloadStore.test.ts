import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolPayloadStore } from '../../src/main/agent/persistence/ToolPayloadStore';
import { uuidV7 } from '../../src/main/agent/uuid';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent tool payload store', () => {
  test('writes content-addressed image files and deletes them with the owning Thread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const bytes = Buffer.from('binary image bytes');

    const first = await store.writeImage(threadId, 'tool-call', 0, bytes.toString('base64'), 'image/png');
    const second = await store.writeImage(threadId, 'tool-call', 0, bytes.toString('base64'), 'image/png');
    expect(first).toBe(second);
    expect(await readFile(first)).toEqual(bytes);

    await store.deleteThread(threadId);
    await expect(stat(first)).rejects.toThrow();
  });
});
