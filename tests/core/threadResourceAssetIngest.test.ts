import { describe, expect, test } from 'bun:test';
import type { AssetMetadata } from '../../src/core/types';
import {
  ingestThreadResourceAsset,
  MAX_THREAD_RESOURCE_ASSET_INGEST_BYTES,
} from '../../src/main/threadResourceAssetIngest';

const resourceRef = {
  id: 'a'.repeat(64),
  mimeType: 'image/png',
  byteLength: 19,
  fileName: 'tool-output.png',
};

const asset: AssetMetadata = {
  schemaVersion: 1,
  id: 'asset-1',
  mimeType: 'image/png',
  byteSize: resourceRef.byteLength,
  sha256: resourceRef.id,
  originalFilename: resourceRef.fileName,
  createdAt: 1,
};

describe('Thread resource asset ingest', () => {
  test('resolves the typed reference through its owning Thread before ingesting', async () => {
    const resolved: unknown[] = [];
    const ingested: unknown[] = [];
    const bytes = Buffer.alloc(resourceRef.byteLength, 1);
    const result = await ingestThreadResourceAsset({
      threadId: 'thread-1',
      resourceRef,
    }, {
      readResource: async (threadId, ref) => {
        resolved.push({ threadId, ref });
        return bytes;
      },
      ingestResource: async (candidate, ref) => {
        ingested.push({ bytes: candidate, ref });
        return asset;
      },
    });

    expect(resolved).toEqual([{ threadId: 'thread-1', ref: resourceRef }]);
    expect(ingested).toEqual([{ bytes, ref: resourceRef }]);
    expect(result).toEqual(asset);
  });

  test('returns null without ingesting when ownership resolution fails', async () => {
    let ingested = false;
    const result = await ingestThreadResourceAsset({
      threadId: 'thread-1',
      resourceRef,
    }, {
      readResource: async () => null,
      ingestResource: async () => {
        ingested = true;
        return asset;
      },
    });

    expect(result).toBeNull();
    expect(ingested).toBe(false);
  });

  test('rejects ambiguous inputs and malformed references before resolution', async () => {
    let resolved = false;
    const dependencies = {
      readResource: async () => {
        resolved = true;
        return null;
      },
      ingestResource: async () => asset,
    };

    await expect(ingestThreadResourceAsset({
      threadId: 'thread-1',
      resourceRef,
      path: '/tmp/substituted.png',
    }, dependencies)).rejects.toThrow('accepts exactly threadId and resourceRef');
    await expect(ingestThreadResourceAsset({
      threadId: 'thread-1',
      resourceRef: { ...resourceRef, fileName: '../substituted.png' },
    }, dependencies)).rejects.toThrow('expected a safe base name');
    expect(resolved).toBe(false);
  });

  test('rejects oversized or length-mismatched resources without ingesting partial bytes', async () => {
    let ingested = false;
    const dependencies = {
      readResource: async () => Buffer.alloc(resourceRef.byteLength - 1),
      ingestResource: async () => {
        ingested = true;
        return asset;
      },
    };

    expect(await ingestThreadResourceAsset({
      threadId: 'thread-1',
      resourceRef,
    }, dependencies)).toBeNull();
    expect(await ingestThreadResourceAsset({
      threadId: 'thread-1',
      resourceRef: {
        ...resourceRef,
        byteLength: MAX_THREAD_RESOURCE_ASSET_INGEST_BYTES + 1,
      },
    }, dependencies)).toBeNull();
    expect(ingested).toBe(false);
  });
});
