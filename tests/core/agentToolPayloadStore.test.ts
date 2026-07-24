import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS,
  ToolPayloadStore,
  measureToolPayloadImage,
} from '../../src/main/agent/persistence/ToolPayloadStore';
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

  test('rejects invalid and oversized base64 before writing image bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const oversized = 'A'.repeat(MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS + 4);

    expect(measureToolPayloadImage(oversized)).toEqual({ ok: false, reason: 'imageByteLimit' });
    expect(measureToolPayloadImage('not base64!')).toEqual({ ok: false, reason: 'invalidBase64' });
    await expect(store.writeImage(threadId, 'tool-call', 0, oversized, 'image/png'))
      .rejects.toThrow('imageByteLimit');
    await expect(store.writeImage(threadId, 'tool-call', 0, 'not base64!', 'image/png'))
      .rejects.toThrow('invalidBase64');
  });

  test('round-trips content-addressed text output and rejects invalid digests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const output = await store.writeText(threadId, 'tool-call', 'full output', 'text/plain', 'Tool output');
    const outputId = output.id;

    expect(await store.readText(threadId, outputId)).toBe('full output');
    expect(output).toMatchObject({
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
      mimeType: 'text/plain',
      byteLength: 11,
      summary: 'Tool output',
    });
    let invalidDigestError: unknown = null;
    try {
      await store.readText(threadId, '../outside');
    } catch (error) {
      invalidDigestError = error;
    }
    expect(invalidDigestError).toBeInstanceOf(Error);
    expect((invalidDigestError as Error).message).toBe('Invalid tool output digest');
  });
});
