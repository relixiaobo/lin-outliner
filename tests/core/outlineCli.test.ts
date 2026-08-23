import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Value } from 'typebox/value';
import { runOutlineCli } from '../../src/outline/cli';
import {
  OUTLINE_APP_VERSION,
  OUTLINE_CAPABILITIES,
  OUTLINE_PROTOCOL_VERSION,
  OutlineResponseSchema,
  OutlineStreamRecordSchema,
  canonicalSha256,
  type ChangeSet,
  type Diff,
} from '../../src/outline/contract';
import { OutlineRuntimeServer } from '../../src/outline/runtime/server';

const roots: string[] = [];
const cliEntry = fileURLToPath(new URL('../../src/outline/cli/entry.ts', import.meta.url));

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('outline CLI', () => {
  test('emits exactly one versioned JSON envelope for a local command without starting Runtime', async () => {
    const root = await makeRoot();
    const output = captureIo();

    expect(await runOutlineCli(['--json', 'version'], { runtimeRoot: root, io: output.io })).toBe(0);
    expect(output.stderr).toBe('');
    expect(output.stdout.endsWith('\n')).toBe(true);
    expect(output.stdout.trim().split('\n')).toHaveLength(1);
    const response = JSON.parse(output.stdout) as unknown;
    expect(Value.Check(OutlineResponseSchema, response)).toBe(true);
    expect(response).toMatchObject({
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      ok: true,
      command: 'version',
      data: { appVersion: OUTLINE_APP_VERSION, protocolMajors: [OUTLINE_PROTOCOL_VERSION] },
    });
    expect(await readdir(root)).toEqual([]);
  });

  test('reports absent status without starting Runtime', async () => {
    const root = await makeRoot();
    const output = captureIo();

    expect(await runOutlineCli(['--json', 'status'], { runtimeRoot: root, io: output.io })).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: true, command: 'status', data: { running: false } });
    expect(await readdir(root)).toEqual([]);
  });

  test('serves exact named public and command schemas locally', async () => {
    const root = await makeRoot();
    const selector = captureIo();
    const porcelain = captureIo();

    expect(await runOutlineCli(['--json', 'schema', 'Selector'], { runtimeRoot: root, io: selector.io })).toBe(0);
    expect(JSON.parse(selector.stdout).data.$defs.Selector.$id).toBe('Selector');
    expect(await runOutlineCli(['--json', 'schema', 'done', 'set'], { runtimeRoot: root, io: porcelain.io })).toBe(0);
    expect(JSON.parse(porcelain.stdout).data).toHaveProperty('request');
    expect(JSON.parse(porcelain.stdout).data).toHaveProperty('result');
    expect(await readdir(root)).toEqual([]);
  });

  test('maps argv and protocol failures to stable JSON error envelopes and exit codes', async () => {
    const root = await makeRoot();
    const protocol = captureIo();
    const usage = captureIo();

    expect(await runOutlineCli(['--json', '--protocol', '2', 'version'], {
      runtimeRoot: root,
      io: protocol.io,
    })).toBe(6);
    expect(JSON.parse(protocol.stdout)).toMatchObject({
      ok: false,
      error: { code: 'protocol_incompatible', category: 'protocol' },
    });
    expect(protocol.stderr).toBe('');

    expect(await runOutlineCli(['--json', 'version', 'extra'], { runtimeRoot: root, io: usage.io })).toBe(2);
    expect(JSON.parse(usage.stdout)).toMatchObject({
      ok: false,
      command: 'version',
      error: { code: 'invalid_input', category: 'usage' },
    });
  });

  test('compares bundled and live capability registries through one Runtime client', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const output = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'capabilities', '--runtime'], {
        runtimeRoot: root,
        io: output.io,
      })).toBe(0);
      expect(JSON.parse(output.stdout).data).toHaveLength(OUTLINE_CAPABILITIES.length);
    } finally {
      await runtime.stop();
    }
  });

  test('forwards history commands and preserves unavailable errors under no-start', async () => {
    const runningRoot = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root: runningRoot, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const log = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'log', '--limit', '10'], {
        runtimeRoot: runningRoot,
        io: log.io,
      })).toBe(0);
      expect(JSON.parse(log.stdout)).toMatchObject({ ok: true, command: 'log', data: [] });
    } finally {
      await runtime.stop();
    }

    const absentRoot = await makeRoot();
    const absent = captureIo();
    expect(await runOutlineCli(['--json', '--no-start', 'log'], {
      runtimeRoot: absentRoot,
      io: absent.io,
    })).toBe(5);
    expect(JSON.parse(absent.stdout)).toMatchObject({
      ok: false,
      command: 'log',
      error: { code: 'runtime_unavailable', category: 'unavailable' },
    });
  });

  test('reads structured input from stdin only when explicitly requested', async () => {
    const root = await makeRoot();
    const explicit = captureIo('{not json');
    const missing = captureIo('{not json');

    expect(await runOutlineCli(['--json', '--no-start', 'diff', '--input', '-'], {
      runtimeRoot: root,
      io: explicit.io,
    })).toBe(2);
    expect(explicit.stdinReads).toBe(1);
    expect(JSON.parse(explicit.stdout).error.code).toBe('invalid_input');

    expect(await runOutlineCli(['--json', '--no-start', 'diff'], {
      runtimeRoot: root,
      io: missing.io,
    })).toBe(2);
    expect(missing.stdinReads).toBe(0);
  });

  test('runs read, Diff, apply, and streaming export through the public CLI grammar', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const changeSet = createTodayChangeSet('CLI searchable result');
      const preview = captureIo(JSON.stringify(changeSet));
      expect(await runOutlineCli(['--json', '--no-start', 'diff', '--input', '-'], {
        runtimeRoot: root,
        io: preview.io,
      })).toBe(0);
      const diff = JSON.parse(preview.stdout).data as Diff;
      expect(diff.kind).toBe('outline.diff');

      const applied = captureIo(JSON.stringify(diff));
      expect(await runOutlineCli(['--json', '--no-start', 'apply', '--input', '-'], {
        runtimeRoot: root,
        io: applied.io,
      })).toBe(0);
      const operation = JSON.parse(applied.stdout).data;
      expect(operation).toMatchObject({ kind: 'outline.operation', origin: 'external-client' });

      const jsonFind = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'find', 'CLI searchable result'], {
        runtimeRoot: root,
        io: jsonFind.io,
      })).toBe(0);
      const foundNodes = JSON.parse(jsonFind.stdout).data.nodes;
      expect(foundNodes).toContainEqual(expect.objectContaining({ text: 'CLI searchable result' }));

      const humanFind = captureIo();
      expect(await runOutlineCli(['--no-start', 'find', 'CLI searchable result'], {
        runtimeRoot: root,
        io: humanFind.io,
      })).toBe(0);
      expect(JSON.parse(humanFind.stdout).nodes).toEqual(foundNodes);

      const nodeId = diff.bindings.created?.[0];
      const shown = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'show', nodeId!], {
        runtimeRoot: root,
        io: shown.io,
      })).toBe(0);
      expect(JSON.parse(shown.stdout).data.nodes[0]).toMatchObject({ id: nodeId });

      const streamed = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'export', '@today', '--format', 'jsonl', '--depth', '1', '--limit', '100',
      ], { runtimeRoot: root, io: streamed.io })).toBe(0);
      const records = streamed.stdout.trim().split('\n').map((line) => JSON.parse(line) as unknown);
      expect(records.every((record) => Value.Check(OutlineStreamRecordSchema, record))).toBe(true);
      expect(records).toContainEqual(expect.objectContaining({ type: 'data', data: expect.objectContaining({ id: nodeId }) }));

      const markdownPath = path.join(root, 'today.md');
      const exported = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'export', '@today', '--format', 'markdown', '--depth', '1', '--output', markdownPath,
      ], { runtimeRoot: root, io: exported.io })).toBe(0);
      expect(JSON.parse(exported.stdout).data.path).toBe(markdownPath);
      expect(await readFile(markdownPath, 'utf8')).toContain('CLI searchable result');
    } finally {
      await runtime.stop();
    }
  });

  test('validates JSONL ChangeSet framing and writes a reviewed Diff atomically', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const changeSet = createTodayChangeSet('JSONL framed input');
      const { operations, ...header } = changeSet;
      const input = [
        JSON.stringify(header),
        ...operations.map((operation) => JSON.stringify({ operation })),
        JSON.stringify({ operationCount: operations.length, sha256: canonicalSha256(changeSet) }),
        '',
      ].join('\n');
      const outputPath = path.join(root, 'reviewed.diff.json');
      const output = captureIo(input);
      expect(await runOutlineCli([
        '--json', '--no-start', 'diff', '--input', '-', '--input-format', 'jsonl', '--output', outputPath,
      ], { runtimeRoot: root, io: output.io })).toBe(0);
      expect(JSON.parse(output.stdout).data).toMatchObject({ path: outputPath, sha256: expect.any(String) });
      expect((JSON.parse(await readFile(outputPath, 'utf8')) as Diff).kind).toBe('outline.diff');

      const corrupted = captureIo(input.replace(canonicalSha256(changeSet), '0'.repeat(64)));
      expect(await runOutlineCli([
        '--json', '--no-start', 'diff', '--input', '-', '--input-format', 'jsonl',
      ], { runtimeRoot: root, io: corrupted.io })).toBe(2);
      expect(JSON.parse(corrupted.stdout).error.message).toContain('SHA-256');
    } finally {
      await runtime.stop();
    }
  });

  test('streams asset ingest, show, and verified export through the Runtime', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const sourcePath = path.join(root, 'source.txt');
      const sourceBytes = Buffer.from('asset path bytes');
      await writeFile(sourcePath, sourceBytes);
      const ingested = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'asset', 'ingest', sourcePath], {
        runtimeRoot: root,
        io: ingested.io,
      })).toBe(0);
      const lease = JSON.parse(ingested.stdout).data;
      expect(lease.leaseId).toMatch(/^lease:/);
      expect(lease.assetId).toMatch(/^asset:/);
      expect(lease.metadata).toMatchObject({ byteSize: sourceBytes.byteLength, mimeType: 'text/plain' });

      const shown = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'asset', 'show', lease.assetId], {
        runtimeRoot: root,
        io: shown.io,
      })).toBe(0);
      expect(JSON.parse(shown.stdout).data).toMatchObject({
        kind: 'outline.asset',
        assetId: lease.assetId,
        metadata: { sha256: lease.metadata.sha256 },
      });

      const outputPath = path.join(root, 'exported.txt');
      const exported = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'asset', 'export', lease.assetId, '--output', outputPath,
      ], { runtimeRoot: root, io: exported.io })).toBe(0);
      expect(JSON.parse(exported.stdout).data).toMatchObject({
        path: outputPath,
        byteCount: sourceBytes.byteLength,
        sha256: lease.metadata.sha256,
      });
      expect(await readFile(outputPath)).toEqual(sourceBytes);

      const stdinBytes = Buffer.from([0, 1, 2, 3, 255]);
      const stdinIngest = captureIo(stdinBytes);
      expect(await runOutlineCli(['--json', '--no-start', 'asset', 'ingest', '-'], {
        runtimeRoot: root,
        io: stdinIngest.io,
      })).toBe(0);
      const stdinLease = JSON.parse(stdinIngest.stdout).data;
      expect(stdinLease.metadata.byteSize).toBe(stdinBytes.byteLength);
      expect(stdinIngest.stdinReads).toBe(1);

      const stdoutExport = captureIo();
      expect(await runOutlineCli([
        '--no-start', 'asset', 'export', stdinLease.assetId, '--output', '-',
      ], { runtimeRoot: root, io: stdoutExport.io })).toBe(0);
      expect(stdoutExport.binaryStdout).toEqual(stdinBytes);
      expect(stdoutExport.stdout).toBe('');
    } finally {
      await runtime.stop();
    }
  });

  test('runs the real entry as a thin local process with clean stdout', async () => {
    const root = await makeRoot();
    const child = Bun.spawn([process.execPath, cliEntry, '--json', 'version'], {
      env: { ...process.env, TENON_OUTLINE_RUNTIME_ROOT: root },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, command: 'version' });
    expect(await readdir(root)).toEqual([]);
  });

  test('keeps the app version constant aligned with package metadata', async () => {
    const packageJson = JSON.parse(await readFile(
      fileURLToPath(new URL('../../package.json', import.meta.url)),
      'utf8',
    )) as { version: string };
    expect(OUTLINE_APP_VERSION).toBe(packageJson.version);
  });
});

function captureIo(stdin: string | Uint8Array = '') {
  let stdout = '';
  const binaryStdout: Buffer[] = [];
  let stderr = '';
  let stdinReads = 0;
  const stdinBuffer = typeof stdin === 'string' ? Buffer.from(stdin) : Buffer.from(stdin);
  return {
    io: {
      stdout: (value: string) => { stdout += value; },
      stdoutBytes: (value: Uint8Array) => { binaryStdout.push(Buffer.from(value)); },
      stderr: (value: string) => { stderr += value; },
      readStdin: async () => {
        stdinReads += 1;
        return stdinBuffer.toString('utf8');
      },
      stdinBytes: () => (async function* () {
        stdinReads += 1;
        yield stdinBuffer;
      })(),
    },
    get stdout() { return stdout; },
    get binaryStdout() { return Buffer.concat(binaryStdout); },
    get stderr() { return stderr; },
    get stdinReads() { return stdinReads; },
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-outline-cli-'));
  roots.push(root);
  return root;
}

function createTodayChangeSet(text: string): ChangeSet {
  return {
    protocolVersion: 1,
    kind: 'outline.changeset',
    operations: [{
      op: 'create',
      parents: {
        target: { selector: { by: 'alias', alias: 'today' }, cardinality: 'one' },
      },
      nodes: [{ content: { text, marks: [], inlineRefs: [] }, children: [] }],
      bind: 'created',
    }],
  };
}
