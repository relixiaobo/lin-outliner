import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS,
  ToolPayloadStore,
  measureToolPayloadImage,
} from '../../src/main/agent/persistence/ToolPayloadStore';
import { MAX_THREAD_MANAGED_ATTACHMENT_BYTES } from '../../src/core/agentAttachmentLimits';
import { uuidV7 } from '../../src/main/agent/uuid';

const roots: string[] = [];

function turnEnvironmentPayload(acceptedAt = 1_720_000_000_000) {
  return {
    schemaVersion: 1,
    kind: 'turnEnvironment',
    acceptedAt,
    utcInstant: new Date(acceptedAt).toISOString(),
    localDate: '2024-07-03',
    localTime: '09:46:40',
    timeZone: 'UTC',
    utcOffsetMinutes: 0,
    locale: 'en-US',
    workingDirectory: '/tmp/project',
    conversationMode: 'interactive',
    executionMode: 'root',
    replyIdentity: null,
    todayNodeId: null,
  } as const;
}

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

    expect(await store.readTextReference(threadId, output)).toBe('full output');
    expect(output).toMatchObject({
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
      mimeType: 'text/plain',
      byteLength: 11,
      summary: 'Tool output',
    });
    let invalidDigestError: unknown = null;
    try {
      await store.readTextReference(threadId, { ...output, id: '../outside' });
    } catch (error) {
      invalidDigestError = error;
    }
    expect(invalidDigestError).toBeInstanceOf(Error);
    expect((invalidDigestError as Error).message).toBe('Invalid tool output digest');
  });

  test('verifies complete text references during reads, copies, and reconciliation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    const external = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-external-'));
    roots.push(root, external);
    const store = new ToolPayloadStore(root);
    const sourceThreadId = uuidV7(1_720_000_000_000);
    const targetThreadId = uuidV7(1_720_000_000_001);
    const retained = await store.writeText(
      sourceThreadId,
      'tool-call',
      'verified output',
      'text/plain',
      'Verified output',
    );
    const orphan = await store.writeText(
      sourceThreadId,
      'orphan-call',
      'orphan output',
      'application/json',
      'Orphan output',
    );

    expect(await store.readTextReference(sourceThreadId, retained)).toBe('verified output');
    expect(await store.readTextReference(sourceThreadId, { ...retained, byteLength: retained.byteLength + 1 }))
      .toBeNull();
    expect(await store.copyTextToThread(sourceThreadId, targetThreadId, retained)).toBe(true);
    await store.deleteThread(sourceThreadId);
    expect(await store.readTextReference(targetThreadId, retained)).toBe('verified output');

    const secondSource = uuidV7(1_720_000_000_002);
    const corrupt = await store.writeText(secondSource, 'tool-call', 'original bytes', 'text/plain', 'Output');
    await writeFile(join(root, secondSource, `${corrupt.id}.txt`), 'tampered bytes');
    expect(await store.readTextReference(secondSource, corrupt)).toBeNull();
    expect(await store.copyTextToThread(secondSource, targetThreadId, corrupt)).toBe(false);

    const pruneThread = uuidV7(1_720_000_000_003);
    const keep = await store.writeText(pruneThread, 'keep', 'keep', 'text/plain', 'Keep');
    const remove = await store.writeText(pruneThread, 'remove', 'remove', 'application/json', 'Remove');
    await store.pruneUnreferencedTextOutputs(pruneThread, [keep]);
    expect(await store.readTextReference(pruneThread, keep)).toBe('keep');
    expect(await store.readTextReference(pruneThread, remove)).toBeNull();
    expect(orphan.id).not.toBe(retained.id);

    const unsafeThreadId = uuidV7(1_720_000_000_004);
    await symlink(external, join(root, unsafeThreadId));
    await writeFile(join(external, `${retained.id}.txt`), 'verified output');
    expect(await store.readTextReference(unsafeThreadId, retained)).toBeNull();
    await expect(store.writeText(unsafeThreadId, 'unsafe', 'escape', 'text/plain', 'Escape'))
      .rejects.toThrow('unsafe directory entry');
    await expect(store.copyTextToThread(targetThreadId, unsafeThreadId, retained))
      .rejects.toThrow('unsafe directory entry');
  });

  test('owns content-addressed context payloads across copy and source deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const sourceThreadId = uuidV7(1_720_000_000_000);
    const targetThreadId = uuidV7(1_720_000_000_001);
    const payload = turnEnvironmentPayload();

    const ref = await store.writeContext(sourceThreadId, payload);
    expect(ref.id).toMatch(/^[a-f0-9]{64}$/);
    expect(ref).toMatchObject({
      mimeType: 'application/vnd.tenon.agent-context+json',
      byteLength: Buffer.byteLength(JSON.stringify(payload)),
      schemaVersion: 1,
      kind: 'turnEnvironment',
    });
    expect(await store.readContext(sourceThreadId, ref)).toEqual(payload);
    expect(await store.readContext(sourceThreadId, { ...ref, kind: 'userView' })).toBeNull();
    expect(await store.copyContextToThread(sourceThreadId, targetThreadId, { ...ref, kind: 'userView' }))
      .toBe(false);
    expect(await store.copyContextToThread(sourceThreadId, targetThreadId, ref)).toBe(true);

    const fileName = `${ref.id}.json`;
    const sourceStat = await lstat(join(root, sourceThreadId, 'context', fileName));
    const targetStat = await lstat(join(root, targetThreadId, 'context', fileName));
    expect(targetStat.ino).not.toBe(sourceStat.ino);

    await store.deleteThread(sourceThreadId);
    expect(await store.readContext(targetThreadId, ref)).toEqual(payload);
  });

  test('rejects invalid or corrupt context payloads and prunes orphans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    await expect(store.writeContext(threadId, 'not-json')).rejects.toThrow('expected an object');
    await expect(store.writeContext(threadId, { ...turnEnvironmentPayload(), unexpected: true }))
      .rejects.toThrow('unknown fields');
    const retainedPayload = turnEnvironmentPayload();
    const retained = await store.writeContext(threadId, retainedPayload);
    const orphan = await store.writeContext(threadId, turnEnvironmentPayload(1_720_000_000_001));

    await store.pruneUnreferencedContexts(threadId, [retained]);
    expect(await store.readContext(threadId, retained)).toEqual(retainedPayload);
    expect(await store.readContext(threadId, orphan)).toBeNull();

    const retainedPath = join(root, threadId, 'context', `${retained.id}.json`);
    const original = await readFile(retainedPath, 'utf8');
    await writeFile(retainedPath, 'x'.repeat(original.length));
    expect(await store.readContext(threadId, retained)).toBeNull();
  });

  test('applies the Thread quota and safe-directory rules to context payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    const external = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-external-'));
    roots.push(root, external);
    const store = new ToolPayloadStore(root);
    const sourceThreadId = uuidV7(1_720_000_000_000);
    const targetThreadId = uuidV7(1_720_000_000_001);
    const ref = await store.writeContext(sourceThreadId, turnEnvironmentPayload());
    const existingPath = join(root, targetThreadId, 'resources', 'a'.repeat(64), 'existing.bin');
    await mkdir(join(root, targetThreadId, 'resources', 'a'.repeat(64)), { recursive: true });
    await writeFile(existingPath, '');
    await truncate(existingPath, MAX_THREAD_MANAGED_ATTACHMENT_BYTES - 1);
    await expect(store.copyContextToThread(sourceThreadId, targetThreadId, ref))
      .rejects.toThrow('Thread storage quota');

    const unsafeThreadId = uuidV7(1_720_000_000_002);
    const externalFile = join(external, 'keep.json');
    await writeFile(externalFile, '{"keep":true}');
    await mkdir(join(root, unsafeThreadId), { recursive: true });
    await symlink(external, join(root, unsafeThreadId, 'context'));
    await store.pruneUnreferencedContexts(unsafeThreadId, []);
    expect(await readFile(externalFile, 'utf8')).toBe('{"keep":true}');
    await expect(store.writeContext(unsafeThreadId, turnEnvironmentPayload()))
      .rejects.toThrow();
  });

  test('streams a managed resource into content-addressed storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const uploadId = await store.beginResourceUpload({
      threadId,
      attachmentId: 'attachment-1',
      expectedBytes: 6,
      mimeType: 'text/plain',
      fileName: '../report.txt',
    });

    await store.appendResourceUpload(threadId, 'attachment-1', uploadId, Buffer.from('abc'));
    await store.appendResourceUpload(threadId, 'attachment-1', uploadId, Buffer.from('def'));
    const ref = await store.finishResourceUpload(threadId, 'attachment-1', uploadId);

    expect(ref.id).toMatch(/^[a-f0-9]{64}$/);
    expect(ref).toEqual({
      id: ref.id,
      mimeType: 'text/plain',
      byteLength: 6,
      fileName: 'report.txt',
    });
    expect(await store.readResource(threadId, ref)).toEqual(Buffer.from('abcdef'));
  });

  test('stores an empty managed resource without a special transport path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const uploadId = await store.beginResourceUpload({
      threadId,
      attachmentId: 'empty-attachment',
      expectedBytes: 0,
      mimeType: 'application/octet-stream',
      fileName: 'empty.bin',
    });

    const ref = await store.finishResourceUpload(threadId, 'empty-attachment', uploadId);

    expect(ref.byteLength).toBe(0);
    expect(await store.readResource(threadId, ref)).toEqual(Buffer.alloc(0));
  });

  test('reports whether a direct resource write created new storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);

    const first = await store.writeResourceWithStatus(
      threadId,
      Buffer.from('prompt image'),
      'image/png',
      'prompt.png',
    );
    const second = await store.writeResourceWithStatus(
      threadId,
      Buffer.from('prompt image'),
      'image/png',
      'prompt.png',
    );

    expect(first.created).toBe(true);
    expect(second).toEqual({ ref: first.ref, created: false });
  });

  test('removes incomplete staged uploads on failure and startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const uploadId = await store.beginResourceUpload({
      threadId,
      attachmentId: 'attachment-1',
      expectedBytes: 4,
      mimeType: 'text/plain',
      fileName: 'partial.txt',
    });
    await store.appendResourceUpload(threadId, 'attachment-1', uploadId, Buffer.from('abc'));
    await expect(store.finishResourceUpload(threadId, 'attachment-1', uploadId))
      .rejects.toThrow('declared byte length');
    expect(await readdir(join(root, threadId, '.staging'))).toEqual([]);

    const stalePath = join(root, threadId, '.staging', 'stale');
    await writeFile(stalePath, 'stale');
    await new ToolPayloadStore(root).initialize();
    await expect(stat(stalePath)).rejects.toThrow();
  });

  test('copies managed resources to a fork and preserves them after source deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const sourceThreadId = uuidV7(1_720_000_000_000);
    const forkThreadId = uuidV7(1_720_000_000_001);
    const ref = await store.writeResource(sourceThreadId, Buffer.from('fork resource'), 'text/plain', 'fork.txt');

    expect(await store.copyResourceToThread(sourceThreadId, forkThreadId, ref)).toBe(true);
    const sourcePath = join(root, sourceThreadId, 'resources', ref.id, ref.fileName);
    const forkPath = join(root, forkThreadId, 'resources', ref.id, ref.fileName);
    expect((await lstat(sourcePath)).ino).not.toBe((await lstat(forkPath)).ino);
    await writeFile(sourcePath, 'source changed');
    expect(await store.readResource(forkThreadId, ref)).toEqual(Buffer.from('fork resource'));
    await store.deleteThread(sourceThreadId);
    expect(await store.readResource(forkThreadId, ref)).toEqual(Buffer.from('fork resource'));
  });

  test('copies managed resources to disposable observations without exposing canonical files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const ref = await store.writeResource(threadId, Buffer.from('canonical'), 'text/plain', 'resource.txt');
    const targetDirectory = join(root, 'scratch', 'observation');
    await mkdir(targetDirectory, { recursive: true });

    const observedPath = await store.copyResourceForObservation(threadId, ref, targetDirectory);
    const canonicalPath = join(root, threadId, 'resources', ref.id, ref.fileName);
    expect(observedPath).not.toBe(canonicalPath);
    expect((await lstat(observedPath!)).ino).not.toBe((await lstat(canonicalPath)).ino);
    await writeFile(observedPath!, 'modified!');

    expect(await store.readResource(threadId, ref)).toEqual(Buffer.from('canonical'));
  });

  test('applies the Thread quota to direct resource writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const existingPath = join(root, threadId, 'resources', 'a'.repeat(64), 'existing.bin');
    await mkdir(join(root, threadId, 'resources', 'a'.repeat(64)), { recursive: true });
    await writeFile(existingPath, '');
    await truncate(existingPath, MAX_THREAD_MANAGED_ATTACHMENT_BYTES - 1);

    await expect(store.writeResource(threadId, Buffer.from('xx'), 'application/octet-stream', 'next.bin'))
      .rejects.toThrow('Thread storage quota');
  });

  test('serializes concurrent upload reservations against the Thread quota', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const existingPath = join(root, threadId, 'resources', 'a'.repeat(64), 'existing.bin');
    await mkdir(join(root, threadId, 'resources', 'a'.repeat(64)), { recursive: true });
    await writeFile(existingPath, '');
    await truncate(existingPath, MAX_THREAD_MANAGED_ATTACHMENT_BYTES - 3);

    const results = await Promise.allSettled(['first', 'second'].map((attachmentId) => (
      store.beginResourceUpload({
        threadId,
        attachmentId,
        expectedBytes: 2,
        mimeType: 'application/octet-stream',
        fileName: `${attachmentId}.bin`,
      })
    )));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const admitted = results.find((result) => result.status === 'fulfilled');
    if (admitted?.status === 'fulfilled') {
      await store.abortResourceUpload(threadId, 'first', admitted.value).catch(async () => {
        await store.abortResourceUpload(threadId, 'second', admitted.value);
      });
    }
  });

  test('applies the Thread quota when copying a managed resource to a fork', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const sourceThreadId = uuidV7(1_720_000_000_000);
    const targetThreadId = uuidV7(1_720_000_000_001);
    const ref = await store.writeResource(sourceThreadId, Buffer.from('xx'), 'application/octet-stream', 'source.bin');
    const existingPath = join(root, targetThreadId, 'resources', 'a'.repeat(64), 'existing.bin');
    await mkdir(join(root, targetThreadId, 'resources', 'a'.repeat(64)), { recursive: true });
    await writeFile(existingPath, '');
    await truncate(existingPath, MAX_THREAD_MANAGED_ATTACHMENT_BYTES - 1);

    await expect(store.copyResourceToThread(sourceThreadId, targetThreadId, ref))
      .rejects.toThrow('Thread storage quota');
  });

  test('prunes unreferenced resources and preserves canonical Thread references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const retained = await store.writeResource(threadId, Buffer.from('retained'), 'text/plain', 'retained.txt');
    const orphan = await store.writeResource(threadId, Buffer.from('orphan'), 'text/plain', 'orphan.txt');

    await store.pruneUnreferencedResources(threadId, [retained]);

    expect(await store.readResource(threadId, retained)).toEqual(Buffer.from('retained'));
    expect(await store.readResource(threadId, orphan)).toBeNull();
    expect(await store.deleteResource(threadId, retained)).toBe(true);
    expect(await store.deleteResource(threadId, retained)).toBe(false);
  });

  test('does not follow a symlinked digest directory while pruning resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    const external = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-external-'));
    roots.push(root, external);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const digestPath = join(root, threadId, 'resources', 'a'.repeat(64));
    const externalFile = join(external, 'keep.txt');
    await mkdir(join(root, threadId, 'resources'), { recursive: true });
    await writeFile(externalFile, 'keep');
    await symlink(external, digestPath);

    await store.pruneUnreferencedResources(threadId, []);

    expect(await readFile(externalFile, 'utf8')).toBe('keep');
    await expect(stat(digestPath)).rejects.toThrow();
  });

  test('does not follow a symlinked Thread directory during startup cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    const external = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-external-'));
    roots.push(root, external);
    const threadId = uuidV7(1_720_000_000_000);
    const externalFile = join(external, '.staging', 'keep.txt');
    await mkdir(join(external, '.staging'));
    await writeFile(externalFile, 'keep');
    await symlink(external, join(root, threadId));

    await new ToolPayloadStore(root).initialize();

    expect(await readFile(externalFile, 'utf8')).toBe('keep');
  });

  test('rejects a managed resource replaced by a symbolic link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const ref = await store.writeResource(threadId, Buffer.from('secret'), 'text/plain', 'resource.txt');
    const resourcePath = join(root, threadId, 'resources', ref.id, ref.fileName);
    const replacementPath = join(root, 'replacement.txt');
    await writeFile(replacementPath, 'secret');
    await rm(resourcePath);
    await symlink(replacementPath, resourcePath);

    expect(await store.useResourcePath(threadId, ref, async (path) => path)).toBeNull();
    expect(await store.readResource(threadId, ref)).toBeNull();
  });

  test('rejects same-length corruption after a managed resource was verified', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const ref = await store.writeResource(threadId, Buffer.from('original'), 'text/plain', 'resource.txt');
    const resourcePath = join(root, threadId, 'resources', ref.id, ref.fileName);
    await writeFile(resourcePath, 'modified');

    expect(await store.useResourcePath(threadId, ref, async (path) => path)).toBeNull();
    expect(await store.readResource(threadId, ref)).toBeNull();
    await expect(store.writeResource(threadId, Buffer.from('original'), 'text/plain', 'resource.txt'))
      .rejects.toThrow('conflicts with an existing resource');
  });
});
