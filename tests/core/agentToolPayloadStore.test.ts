import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS,
  ThreadResourceQuotaError,
  ToolPayloadStore,
  measureToolPayloadImage,
} from '../../src/main/agent/persistence/ToolPayloadStore';
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
  test('rejects invalid and oversized base64 before decoding image bytes', () => {
    const oversized = 'A'.repeat(MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS + 4);

    expect(measureToolPayloadImage(oversized)).toEqual({ ok: false, reason: 'imageByteLimit' });
    expect(measureToolPayloadImage('not base64!')).toEqual({ ok: false, reason: 'invalidBase64' });
    expect(measureToolPayloadImage(Buffer.from('bytes').toString('base64')))
      .toEqual({ ok: true, byteLength: 5 });
  });

  test('round-trips content-addressed text output and rejects invalid digests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const output = await store.writeText(threadId, 'tool-call', 'full output', 'text/plain', 'Tool output');
    const outputId = output.id;

    expect(await store.readTextReference(threadId, output)).toBe('full output');
    expect(await store.readTextReferencePrefix(threadId, output, 4)).toEqual({
      textPrefix: 'full',
      truncated: true,
    });
    expect(await store.readTextReferencePrefix(threadId, output, 20)).toEqual({
      textPrefix: 'full output',
      truncated: false,
    });
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

  test('keeps verified large text projections within the requested character prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const threadId = uuidV7(1_720_000_000_000);
    const text = `${'a'.repeat(2 * 1024 * 1024)}tail`;
    const output = await store.writeText(threadId, 'tool-call', text, 'text/plain', 'Large tool output');

    const projection = await store.readTextReferencePrefix(threadId, output, 4_000);

    expect(projection).toEqual({
      textPrefix: 'a'.repeat(4_000),
      truncated: true,
    });
    expect(projection?.textPrefix.length).toBe(4_000);
  });

  test('verifies complete text references during reads, copies, and reconciliation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    const external = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-external-'));
    roots.push(root, external);
    const store = new ToolPayloadStore(root, { maxThreadBytes: 10_000 });
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

  test('owns verified internal text across projection, fork copy, pruning, corruption, and source deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root);
    const sourceThreadId = uuidV7(1_720_000_000_000);
    const targetThreadId = uuidV7(1_720_000_000_001);
    const text = 'quotes: " slash: \\ newline:\n Unicode:界'.repeat(2_000);
    const retained = await store.writeInternalText(sourceThreadId, text);
    const duplicate = await store.writeInternalText(sourceThreadId, text);
    const orphan = await store.writeInternalText(sourceThreadId, 'orphan');
    await expect(store.writeInternalText(sourceThreadId, '\ud800'))
      .rejects.toThrow('well-formed Unicode');

    expect(duplicate).toEqual(retained);
    expect(await store.readInternalText(sourceThreadId, retained)).toBe(text);
    expect(await store.readInternalTextProjection(sourceThreadId, retained, 37)).toEqual({
      textPrefix: text.slice(0, 37),
      textChars: text.length,
      jsonStringChars: JSON.stringify(text).length,
    });
    const supplementaryText = `\ud83d\ude00${'x'.repeat(1_100_000)}`;
    const supplementary = await store.writeInternalText(sourceThreadId, supplementaryText);
    expect(await store.readInternalTextProjection(sourceThreadId, supplementary, 1)).toEqual({
      textPrefix: '',
      textChars: supplementaryText.length,
      jsonStringChars: JSON.stringify(supplementaryText).length,
    });
    expect(await store.copyInternalTextToThread(sourceThreadId, targetThreadId, retained)).toBe(true);
    await store.pruneUnreferencedInternalText(sourceThreadId, [retained]);
    expect(await store.readInternalText(sourceThreadId, retained)).toBe(text);
    expect(await store.readInternalText(sourceThreadId, orphan)).toBeNull();

    await store.deleteThread(sourceThreadId);
    expect(await store.readInternalText(targetThreadId, retained)).toBe(text);
    const targetPath = join(root, targetThreadId, 'internal-text', `${retained.id}.txt`);
    await writeFile(targetPath, Buffer.alloc(retained.byteLength, 0x78));
    expect(await store.readInternalText(targetThreadId, retained)).toBeNull();
    expect(await store.readInternalTextProjection(targetThreadId, retained, 32)).toBeNull();
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

    await store.pruneUnreferencedContexts(threadId, [retained], []);
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
    const store = new ToolPayloadStore(root, { maxThreadBytes: 10_000 });
    const sourceThreadId = uuidV7(1_720_000_000_000);
    const targetThreadId = uuidV7(1_720_000_000_001);
    const ref = await store.writeContext(sourceThreadId, turnEnvironmentPayload());
    await store.writeInternalText(targetThreadId, 'x'.repeat(10_001 - ref.byteLength));
    await expect(store.copyContextToThread(sourceThreadId, targetThreadId, ref))
      .rejects.toThrow('Thread storage quota');

    const unsafeThreadId = uuidV7(1_720_000_000_002);
    const externalFile = join(external, 'keep.json');
    await writeFile(externalFile, '{"keep":true}');
    await mkdir(join(root, unsafeThreadId), { recursive: true });
    await symlink(external, join(root, unsafeThreadId, 'context'));
    await store.pruneUnreferencedContexts(unsafeThreadId, [], []);
    expect(await readFile(externalFile, 'utf8')).toBe('{"keep":true}');
    await expect(store.writeContext(unsafeThreadId, turnEnvironmentPayload()))
      .rejects.toThrow();
  });

  test('accounts internal text against the Thread quota for writes and fork copies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-tool-payloads-'));
    roots.push(root);
    const store = new ToolPayloadStore(root, { maxThreadBytes: 40 });
    const targetThreadId = uuidV7(1_720_000_000_000);
    const sourceThreadId = uuidV7(1_720_000_000_001);

    await store.writeInternalText(targetThreadId, 'a'.repeat(24));
    await expect(store.writeInternalText(targetThreadId, 'b'.repeat(17)))
      .rejects.toBeInstanceOf(ThreadResourceQuotaError);

    const sourceRef = await store.writeInternalText(sourceThreadId, 'c'.repeat(17));
    await expect(store.copyInternalTextToThread(sourceThreadId, targetThreadId, sourceRef))
      .rejects.toBeInstanceOf(ThreadResourceQuotaError);
    expect(await store.readInternalText(targetThreadId, sourceRef)).toBeNull();
  });
});
