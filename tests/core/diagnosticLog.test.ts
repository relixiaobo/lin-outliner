import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diagnosticSourceLabel, type DiagnosticExportArtifact } from '../../src/core/errorObservability';
import { DiagnosticLogStore } from '../../src/main/diagnosticLog';

const roots: string[] = [];

async function createStore(): Promise<{ store: DiagnosticLogStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-diagnostics-'));
  roots.push(root);
  return { store: new DiagnosticLogStore(root), root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DiagnosticLogStore', () => {
  test('deduplicates repeated reports by fingerprint', async () => {
    const { store } = await createStore();
    await store.reportError({
      domain: 'dream',
      severity: 'warn',
      code: 'provider-400',
      message: 'Provider returned HTTP 400 for run 1234567890',
      context: { providerId: 'openai', statusCode: 400 },
    });
    await store.reportError({
      domain: 'dream',
      severity: 'warn',
      code: 'provider-400',
      message: 'Provider returned HTTP 400 for run 9876543210',
      context: { providerId: 'openai', statusCode: 400 },
    });

    const records = await store.readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.count).toBe(2);
    expect(records[0]!.context?.providerId).toBe('openai');

    const rawLines = (await readFile(store.logPath, 'utf8')).trim().split('\n');
    expect(rawLines).toHaveLength(1);
  });

  test('scrubs context to the diagnostics allow-list before writing', async () => {
    const { store } = await createStore();
    await store.reportError({
      domain: 'provider',
      severity: 'error',
      message: 'Failed request with private content',
      context: {
        conversationId: 'conv-1',
        statusCode: 400,
        providerId: 'anthropic',
        source: '/Users/example/Tenon/src/preload/index.ts?cache=private',
        prompt: 'do not store this',
        apiKey: 'secret',
      } as never,
      error: new TypeError('Bad request'),
    });

    const [record] = await store.readRecords();
    expect(record?.context).toEqual({
      conversationId: 'conv-1',
      statusCode: 400,
      providerId: 'anthropic',
      source: 'index.ts',
      errorMessage: 'Bad request',
      errorName: 'TypeError',
      stackHash: expect.any(String),
    });
    expect(JSON.stringify(record)).not.toContain('do not store this');
    expect(JSON.stringify(record)).not.toContain('secret');
    expect(JSON.stringify(record)).not.toContain('/Users/example');
  });

  test('normalizes diagnostic source labels without storing local paths', () => {
    expect(diagnosticSourceLabel('file:///Users/example/Tenon/out/renderer/index.html')).toBe('file://local');
    expect(diagnosticSourceLabel('http://127.0.0.1:5174/src/preload/index.ts?t=secret')).toBe('http://127.0.0.1:5174');
    expect(diagnosticSourceLabel('/Users/example/Tenon/src/preload/index.ts?cache=private')).toBe('index.ts');
  });

  test('keeps the aggregate log bounded and exports environment metadata', async () => {
    const { store, root } = await createStore();
    for (let index = 0; index < 205; index += 1) {
      await store.reportError({
        domain: 'command',
        severity: 'error',
        code: `command-${index}`,
        message: `Command failed ${index}`,
        context: { nodeId: `node-${index}` },
      });
    }

    const records = await store.readRecords();
    expect(records).toHaveLength(200);
    expect(records.some((record) => record.code === 'command-204')).toBe(true);
    expect(records.some((record) => record.code === 'command-0')).toBe(false);

    const exportPath = path.join(root, 'export.json');
    await store.writeExport(exportPath, {
      appVersion: '0.1.0',
      platform: 'darwin',
      arch: 'arm64',
      electron: '42.0.0',
      chrome: '142.0.0',
      node: '25.0.0',
      providerId: 'openai',
    });
    const artifact = JSON.parse(await readFile(exportPath, 'utf8')) as DiagnosticExportArtifact;
    expect(artifact.v).toBe(1);
    expect(artifact.environment.providerId).toBe('openai');
    expect(artifact.records).toHaveLength(200);
  });
});
