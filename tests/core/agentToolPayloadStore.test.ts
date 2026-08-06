import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS,
  ThreadResourceQuotaError,
  ToolPayloadStore,
  measureToolPayloadImage,
} from '../../src/main/agent/persistence/ToolPayloadStore';
import { MAX_THREAD_MANAGED_ATTACHMENT_BYTES } from '../../src/core/agentAttachmentLimits';
import { uuidV7 } from '../../src/main/agent/uuid';
import { createImageArtifactReference } from '../../src/main/agent/imageArtifacts';

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
    todayNodeTitle: null,
  } as const;
}

function turnDiagnosticsPayload(contextEpochId = 'initial') {
  return {
    schemaVersion: 1,
    contextEpochId,
    cacheAffinity: 'a'.repeat(64),
    configuration: {
      profileName: 'default',
      developerInstructions: [],
      model: 'test-model',
      reasoningEffort: 'medium',
      tools: [],
      skills: [],
      plugins: [],
      mcpServers: [],
    },
    stablePrompt: null,
    toolSchemas: [],
    runtime: {
      provider: 'openai',
      model: 'test-model',
      api: 'openai-responses',
      configuredBaseUrl: 'https://api.openai.com/v1',
      transportSelection: 'auto',
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      thinkingLevel: 'medium',
      timeoutMs: null,
      maxRetries: null,
      maxRetryDelayMs: 60_000,
      cacheRetention: 'short',
      toolExecution: 'parallel',
      steeringMode: 'all',
    },
    canonicalMessages: [],
    requestFragments: [],
    providerCalls: [],
    activities: [{
      type: 'acceptedInput',
      source: 'initial',
      acceptedAt: 0,
      itemIds: ['input-item'],
      consumedByCallIndex: null,
    }],
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

    const first = await store.writeImageWithStatus(threadId, bytes.toString('base64'), 'image/png');
    const second = await store.writeImageWithStatus(threadId, bytes.toString('base64'), 'image/png');
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.ref).toEqual(second.ref);
    expect(first.ref).toMatchObject({ mimeType: 'image/png', fileName: 'tool-output.png' });
    expect(await store.readResource(threadId, first.ref)).toEqual(bytes);

    await store.deleteThread(threadId);
    expect(await store.readResource(threadId, first.ref)).toBeNull();
  });

  test('rejects invalid and oversized base64 before writing image bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const oversized = 'A'.repeat(MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS + 4);

    expect(measureToolPayloadImage(oversized)).toEqual({ ok: false, reason: 'imageByteLimit' });
    expect(measureToolPayloadImage('not base64!')).toEqual({ ok: false, reason: 'invalidBase64' });
    await expect(store.writeImage(threadId, oversized, 'image/png'))
      .rejects.toThrow('imageByteLimit');
    await expect(store.writeImage(threadId, 'not base64!', 'image/png'))
      .rejects.toThrow('invalidBase64');
    await expect(store.writeImage(threadId, Buffer.from('bytes').toString('base64'), 'text/plain'))
      .rejects.toThrow('MIME type must be an image');
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

  test('owns Turn diagnostics across fork copy, pruning, and source deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const sourceThreadId = uuidV7(1_720_000_000_000);
    const targetThreadId = uuidV7(1_720_000_000_001);
    const conflictThreadId = uuidV7(1_720_000_000_002);
    const retainedPayload = turnDiagnosticsPayload();
    const retained = await store.writeTurnDiagnostics(sourceThreadId, retainedPayload);
    const orphan = await store.writeTurnDiagnostics(sourceThreadId, turnDiagnosticsPayload('reset-1'));

    expect(await store.readTurnDiagnostics(sourceThreadId, retained)).toEqual(retainedPayload);
    expect(await store.copyTurnDiagnosticsToThread(sourceThreadId, targetThreadId, retained)).toBe(true);
    await store.deleteThread(sourceThreadId);
    expect(await store.readTurnDiagnostics(targetThreadId, retained)).toEqual(retainedPayload);

    const conflictDirectory = join(root, conflictThreadId, 'turn-diagnostics');
    await mkdir(conflictDirectory, { recursive: true });
    await writeFile(join(conflictDirectory, `${retained.id}.json`), 'x'.repeat(retained.byteLength));
    await expect(store.copyTurnDiagnosticsToThread(targetThreadId, conflictThreadId, retained))
      .rejects.toThrow('conflict with existing bytes');

    const secondOrphan = await store.writeTurnDiagnostics(targetThreadId, turnDiagnosticsPayload('reset-2'));
    await store.pruneUnreferencedTurnDiagnostics(targetThreadId, [retained]);
    expect(await store.readTurnDiagnostics(targetThreadId, retained)).toEqual(retainedPayload);
    expect(await store.readTurnDiagnostics(targetThreadId, secondOrphan)).toBeNull();
    expect(await store.readTurnDiagnostics(targetThreadId, orphan)).toBeNull();
  });

  test('rejects diagnostics pools whose content addresses do not match their values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const payload = turnDiagnosticsPayload();

    await expect(store.writeTurnDiagnostics(threadId, {
      ...payload,
      canonicalMessages: [{ id: 'b'.repeat(64), estimatedTokens: 1, value: { role: 'user' } }],
    })).rejects.toThrow('message digest does not match');
    await expect(store.writeTurnDiagnostics(threadId, {
      ...payload,
      requestFragments: [{ id: 'c'.repeat(64), value: { role: 'user' } }],
    })).rejects.toThrow('fragment digest does not match');
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

  test('stores generated originals outside the bounded tool-image transport limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 1, 1);

    const original = await store.writeResource(threadId, bytes, 'image/png', 'generated-original.png');

    expect(original.byteLength).toBe(bytes.byteLength);
    await expect(store.writeImage(threadId, bytes.toString('base64'), 'image/png'))
      .rejects.toThrow('imageByteLimit');
  });

  test('reclaims old tiered originals above the soft watermark while preserving durable renditions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const now = 10_000;
    const store = retentionTestStore(root, now);
    const threadId = uuidV7(1_720_000_000_000);
    const tieredOriginal = await store.writeResource(threadId, Buffer.alloc(12, 1), 'image/png', 'tiered.png');
    const tieredObservation = await store.writeResource(threadId, Buffer.alloc(5, 2), 'image/png', 'tiered-observation.png');
    const durableOriginal = await store.writeResource(threadId, Buffer.alloc(10, 3), 'image/png', 'durable.png');
    const durableObservation = await store.writeResource(threadId, Buffer.alloc(5, 4), 'image/png', 'durable-observation.png');
    store.setImageRetentionInventoryProvider(() => ({
      artifacts: [
        imageArtifact('tiered', tieredOriginal, tieredObservation, now - 2_000),
        imageArtifact('durable', durableOriginal, durableObservation, now - 2_000),
      ],
      protectedResources: [],
    }));

    const trigger = await store.writeResource(threadId, Buffer.from([5]), 'application/octet-stream', 'trigger.bin');

    expect(await store.readResource(threadId, tieredOriginal)).toBeNull();
    expect(await store.readResource(threadId, tieredObservation)).not.toBeNull();
    expect(await store.readResource(threadId, durableOriginal)).not.toBeNull();
    expect(await store.readResource(threadId, durableObservation)).not.toBeNull();
    expect(await store.readResource(threadId, trigger)).toEqual(Buffer.from([5]));
  });

  test('uses hard-pressure order: tiered originals, then least-recently-used observations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const now = 10_000;
    const store = retentionTestStore(root, now);
    const threadId = uuidV7(1_720_000_000_000);
    const protectedResource = await store.writeResource(threadId, Buffer.alloc(19, 1), 'application/octet-stream', 'protected.bin');
    const tieredOriginal = await store.writeResource(threadId, Buffer.alloc(5, 2), 'image/png', 'tiered.png');
    const oldObservation = await store.writeResource(threadId, Buffer.alloc(8, 3), 'image/png', 'old.png');
    const recentObservation = await store.writeResource(threadId, Buffer.alloc(8, 4), 'image/png', 'recent.png');
    await setResourceAccessTime(root, threadId, oldObservation, 1_000);
    await setResourceAccessTime(root, threadId, recentObservation, 2_000);
    store.setImageRetentionInventoryProvider(() => ({
      artifacts: [
        imageArtifact('tiered', tieredOriginal, recentObservation, now - 500),
        observationOnlyArtifact(oldObservation, now - 500),
      ],
      protectedResources: [protectedResource],
    }));

    const incoming = await store.writeResource(threadId, Buffer.alloc(10, 5), 'application/octet-stream', 'incoming.bin');

    expect(await store.readResource(threadId, tieredOriginal)).toBeNull();
    expect(await store.readResource(threadId, oldObservation)).toBeNull();
    expect(await store.readResource(threadId, recentObservation)).not.toBeNull();
    expect(await store.readResource(threadId, protectedResource)).not.toBeNull();
    expect(await store.readResource(threadId, incoming)).not.toBeNull();
  });

  test('persists rendition access time without changing resource bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const now = Date.now() + 60_000;
    const store = retentionTestStore(root, now, 0);
    const threadId = uuidV7(1_720_000_000_000);
    const ref = await store.writeResource(threadId, Buffer.from('observation'), 'image/png', 'observation.png');
    await setResourceAccessTime(root, threadId, ref, now - 30_000);

    await store.useResourcePath(threadId, ref, async () => undefined);

    const file = await stat(resourcePath(root, threadId, ref));
    expect(file.atimeMs).toBeCloseTo(now, -2);
    expect(await store.readResource(threadId, ref)).toEqual(Buffer.from('observation'));
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

  test('applies a typed Thread quota error to direct resource writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const existingPath = join(root, threadId, 'resources', 'a'.repeat(64), 'existing.bin');
    await mkdir(join(root, threadId, 'resources', 'a'.repeat(64)), { recursive: true });
    await writeFile(existingPath, '');
    await truncate(existingPath, MAX_THREAD_MANAGED_ATTACHMENT_BYTES - 1);

    await expect(store.writeResource(threadId, Buffer.from('xx'), 'application/octet-stream', 'next.bin'))
      .rejects.toBeInstanceOf(ThreadResourceQuotaError);
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

function retentionTestStore(
  root: string,
  now: number,
  resourceAccessTouchIntervalMs = 60 * 60 * 1000,
): ToolPayloadStore {
  return new ToolPayloadStore(root, {
    now: () => now,
    imageRetention: {
      targetBytes: 20,
      softBytes: 30,
      hardBytes: 40,
      minOriginalAgeMs: 1_000,
    },
    resourceAccessTouchIntervalMs,
  });
}

function imageArtifact(
  retention: 'durable' | 'tiered',
  original: Awaited<ReturnType<ToolPayloadStore['writeResource']>>,
  observation: Awaited<ReturnType<ToolPayloadStore['writeResource']>>,
  createdAt: number,
) {
  return createImageArtifactReference({
    createdAt,
    retention,
    original: { kind: 'threadPayload', ref: original },
    observation,
    sourceDimensions: { width: 2, height: 2 },
    observationDimensions: { width: 1, height: 1 },
  });
}

function observationOnlyArtifact(
  observation: Awaited<ReturnType<ToolPayloadStore['writeResource']>>,
  createdAt: number,
) {
  return createImageArtifactReference({
    createdAt,
    retention: 'observationOnly',
    original: null,
    observation,
    sourceDimensions: { width: 1, height: 1 },
    observationDimensions: { width: 1, height: 1 },
  });
}

function resourcePath(
  root: string,
  threadId: string,
  ref: Awaited<ReturnType<ToolPayloadStore['writeResource']>>,
): string {
  return join(root, threadId, 'resources', ref.id, ref.fileName);
}

async function setResourceAccessTime(
  root: string,
  threadId: string,
  ref: Awaited<ReturnType<ToolPayloadStore['writeResource']>>,
  atimeMs: number,
): Promise<void> {
  const path = resourcePath(root, threadId, ref);
  const file = await stat(path);
  await utimes(path, new Date(atimeMs), file.mtime);
}
