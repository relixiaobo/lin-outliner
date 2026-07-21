import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diagnosticSourceLabel, type DiagnosticExportArtifact } from '../../src/core/errorObservability';
import { DiagnosticLogStore } from '../../src/main/diagnosticLog';

const roots: string[] = [];
const stores: DiagnosticLogStore[] = [];

async function createStore(): Promise<{ store: DiagnosticLogStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-diagnostics-'));
  roots.push(root);
  const store = new DiagnosticLogStore(root);
  stores.push(store);
  return { store, root };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.flushNow({ reason: 'test-cleanup' }).catch(() => undefined)));
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

    await store.flushNow({ reason: 'test' });
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
    expect(records.some((record) => record.fingerprint === 'diagnostic-logger-overflow')).toBe(true);

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

  test('readRecords observes unflushed memory before reveal flushes the log file', async () => {
    const { store } = await createStore();
    await store.reportError({
      domain: 'render',
      severity: 'fatal',
      code: 'window-error',
      message: 'Renderer crashed',
      context: { source: 'renderer.js' },
    });

    expect(await store.readRecords()).toMatchObject([{
      count: 1,
      domain: 'render',
      code: 'window-error',
      message: 'Renderer crashed',
    }]);
    await expect(readFile(store.logPath, 'utf8')).rejects.toThrow();

    await expect(store.ensureLogFile()).resolves.toBe(store.logPath);
    const rawLines = (await readFile(store.logPath, 'utf8')).trim().split('\n');
    expect(rawLines).toHaveLength(1);
  });

  test('ensureLogFile rejects when the explicit reveal flush cannot write pending diagnostics', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-diagnostics-blocked-'));
    roots.push(root);
    const blockedUserData = path.join(root, 'userData-file');
    await writeFile(blockedUserData, 'not a directory');
    const store = new DiagnosticLogStore(blockedUserData);
    const originalConsoleError = console.error;

    try {
      console.error = () => undefined;
      await store.reportError({
        domain: 'render',
        severity: 'fatal',
        code: 'window-error',
        message: 'Renderer crashed before reveal',
      });

      await expect(store.ensureLogFile()).rejects.toThrow(/ENOTDIR|not a directory/i);
      expect(store.getCountersForTests().dirtyFingerprints).toBe(1);
      expect(store.getCountersForTests().lastFlushError).toMatch(/ENOTDIR|not a directory/i);
    } finally {
      console.error = originalConsoleError;
      const internals = store as unknown as { flushTimer: ReturnType<typeof setTimeout> | null };
      if (internals.flushTimer) {
        clearTimeout(internals.flushTimer);
        internals.flushTimer = null;
      }
    }
  });

  test('coalesces same-fingerprint storms into one dirty aggregate before flushing', async () => {
    const { store } = await createStore();
    for (let index = 0; index < 100; index += 1) {
      await store.reportError({
        domain: 'provider',
        severity: 'error',
        code: 'provider-timeout',
        message: `Provider timeout for request ${1234567890 + index}`,
        context: { providerId: 'openai', attempt: index },
      });
    }

    const [record] = await store.readRecords();
    expect(record?.count).toBe(100);
    expect(store.getCountersForTests()).toMatchObject({
      enqueuedReports: 100,
      dirtyFingerprints: 1,
      flushCount: 0,
    });

    await store.flushNow({ reason: 'test' });
    expect(store.getCountersForTests()).toMatchObject({ dirtyFingerprints: 0, flushCount: 1 });
    const rawLines = (await readFile(store.logPath, 'utf8')).trim().split('\n');
    expect(rawLines).toHaveLength(1);
  });

  test('writeExport includes pending in-memory diagnostics', async () => {
    const { store, root } = await createStore();
    await store.reportError({
      domain: 'runtime',
      severity: 'error',
      code: 'export-pending',
      message: 'Pending diagnostic',
    });

    const exportPath = path.join(root, 'pending-export.json');
    await store.writeExport(exportPath, {
      appVersion: '0.1.0',
      platform: 'darwin',
      arch: 'arm64',
      electron: '42.0.0',
      chrome: '142.0.0',
      node: '25.0.0',
      providerId: null,
    });

    const artifact = JSON.parse(await readFile(exportPath, 'utf8')) as DiagnosticExportArtifact;
    expect(artifact.records).toMatchObject([{ code: 'export-pending', message: 'Pending diagnostic' }]);
  });
});
