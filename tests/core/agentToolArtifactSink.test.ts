import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ThreadResourceReference } from '../../src/core/agent/protocol';
import {
  MAX_TOOL_ARTIFACT_BYTES,
  ToolArtifactAdmissionError,
  createToolArtifactSink,
} from '../../src/main/agent/runtime/ToolArtifactSink';
import type { TurnExecutionContext } from '../../src/main/agent/runtime/types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function resourceRef(bytes: Uint8Array, mimeType: string, fileName: string): ThreadResourceReference {
  return {
    id: createHash('sha256').update(bytes).digest('hex'),
    mimeType,
    byteLength: bytes.byteLength,
    fileName,
  };
}

function sinkContext(input: {
  persist?: TurnExecutionContext['persistOutputResource'];
  resolve?: TurnExecutionContext['resolveResourceObservationPath'];
} = {}): TurnExecutionContext {
  return {
    persistOutputResource: input.persist ?? (async (bytes, mimeType, fileName) => (
      resourceRef(bytes, mimeType, fileName)
    )),
    resolveResourceObservationPath: input.resolve ?? (async (ref) => `/scratch/${ref.fileName}`),
  } as unknown as TurnExecutionContext;
}

describe('ToolArtifactSink', () => {
  test('persists bytes and files with verified metadata and current readable paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-tool-artifact-sink-'));
    roots.push(root);
    const sourcePath = path.join(root, 'report.txt');
    await writeFile(sourcePath, 'file bytes');
    const persisted: Array<{ bytes: Buffer; mimeType: string; fileName: string }> = [];
    const sink = createToolArtifactSink(sinkContext({
      persist: async (bytes, mimeType, fileName) => {
        persisted.push({ bytes: Buffer.from(bytes), mimeType, fileName });
        return resourceRef(bytes, mimeType, fileName);
      },
      resolve: async (ref) => path.join(root, 'materialized', ref.fileName),
    }));

    const fromBytes = await sink.persistBytes({
      bytes: Buffer.from('direct bytes'),
      mimeType: 'application/octet-stream',
      fileName: 'direct.bin',
    });
    const fromFile = await sink.persistFile({
      path: sourcePath,
      mimeType: 'text/plain',
      fileName: 'report.txt',
    });

    expect(persisted).toEqual([
      { bytes: Buffer.from('direct bytes'), mimeType: 'application/octet-stream', fileName: 'direct.bin' },
      { bytes: Buffer.from('file bytes'), mimeType: 'text/plain', fileName: 'report.txt' },
    ]);
    expect(fromBytes).toEqual({
      ref: resourceRef(Buffer.from('direct bytes'), 'application/octet-stream', 'direct.bin'),
      readablePath: path.join(root, 'materialized', 'direct.bin'),
    });
    expect(fromFile).toEqual({
      ref: resourceRef(Buffer.from('file bytes'), 'text/plain', 'report.txt'),
      readablePath: path.join(root, 'materialized', 'report.txt'),
    });
  });

  test('keeps a durable reference when current materialization is unavailable', async () => {
    const bytes = Buffer.from('stored');
    const sink = createToolArtifactSink(sinkContext({
      resolve: async () => { throw new Error('scratch unavailable'); },
    }));

    expect(await sink.persistBytes({ bytes, mimeType: 'text/plain', fileName: 'stored.txt' })).toEqual({
      ref: resourceRef(bytes, 'text/plain', 'stored.txt'),
      readablePath: null,
    });
  });

  test('rejects oversized, unsafe, and non-regular artifact sources before storage', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-tool-artifact-reject-'));
    roots.push(root);
    const oversizedPath = path.join(root, 'oversized.bin');
    const targetPath = path.join(root, 'target.txt');
    const symlinkPath = path.join(root, 'link.txt');
    const directoryPath = path.join(root, 'directory');
    await Promise.all([
      writeFile(oversizedPath, ''),
      writeFile(targetPath, 'target'),
      mkdir(directoryPath),
    ]);
    await truncate(oversizedPath, MAX_TOOL_ARTIFACT_BYTES + 1);
    if (process.platform !== 'win32') await symlink(targetPath, symlinkPath);
    let persistCalls = 0;
    const sink = createToolArtifactSink(sinkContext({
      persist: async (bytes, mimeType, fileName) => {
        persistCalls += 1;
        return resourceRef(bytes, mimeType, fileName);
      },
    }));

    await expect(sink.persistBytes({
      bytes: new Uint8Array(MAX_TOOL_ARTIFACT_BYTES + 1),
      mimeType: 'application/octet-stream',
      fileName: 'oversized.bin',
    })).rejects.toMatchObject({ code: 'artifact_too_large' });
    await expect(sink.persistBytes({
      bytes: Buffer.from('unsafe'),
      mimeType: 'text/plain',
      fileName: '../unsafe name.txt',
    })).rejects.toMatchObject({ code: 'artifact_metadata_invalid' });
    await expect(sink.persistBytes({
      bytes: Buffer.from('missing MIME'),
      mimeType: '   ',
      fileName: 'missing-mime.txt',
    })).rejects.toMatchObject({ code: 'artifact_metadata_invalid' });
    await expect(sink.persistBytes({
      bytes: Buffer.from('unsafe MIME'),
      mimeType: 'text/plain\ncontent-disposition=unsafe',
      fileName: 'unsafe-mime.txt',
    })).rejects.toMatchObject({ code: 'artifact_metadata_invalid' });
    await expect(sink.persistFile({
      path: oversizedPath,
      mimeType: 'application/octet-stream',
      fileName: 'oversized.bin',
    })).rejects.toMatchObject({ code: 'artifact_too_large' });
    await expect(sink.persistFile({
      path: directoryPath,
      mimeType: 'application/octet-stream',
      fileName: 'directory.bin',
    })).rejects.toMatchObject({ code: 'artifact_source_invalid' });
    if (process.platform !== 'win32') {
      await expect(sink.persistFile({
        path: symlinkPath,
        mimeType: 'text/plain',
        fileName: 'link.txt',
      })).rejects.toMatchObject({ code: 'artifact_source_invalid' });
    }
    expect(persistCalls).toBe(0);
  });

  test('stabilizes store rejection and rejects a mismatched durable digest', async () => {
    const bytes = Buffer.from('canonical bytes');
    const rejected = createToolArtifactSink(sinkContext({
      persist: async () => {
        throw Object.assign(new Error('write failed at /canonical/payload/store'), {
          name: 'ThreadResourceQuotaError',
        });
      },
    }));
    await expect(rejected.persistBytes({
      bytes,
      mimeType: 'text/plain',
      fileName: 'canonical.txt',
    })).rejects.toEqual(new ToolArtifactAdmissionError(
      'artifact_store_invalid',
      'Tool artifact storage quota is exhausted.',
    ));

    let materializeCalls = 0;
    const mismatched = createToolArtifactSink(sinkContext({
      persist: async (_bytes, mimeType, fileName) => ({
        id: '0'.repeat(64),
        mimeType,
        byteLength: bytes.byteLength,
        fileName,
      }),
      resolve: async () => {
        materializeCalls += 1;
        return '/should-not-materialize';
      },
    }));
    await expect(mismatched.persistBytes({
      bytes,
      mimeType: 'text/plain',
      fileName: 'canonical.txt',
    })).rejects.toEqual(new ToolArtifactAdmissionError(
      'artifact_store_invalid',
      'Tool artifact storage returned metadata that does not match the admitted bytes.',
    ));
    expect(materializeCalls).toBe(0);
  });
});
