import { afterEach, describe, expect, test } from 'bun:test';
import type { AssetMetadata } from '../../src/renderer/api/types';
import {
  canAddPreviewTargetToOutline,
  ingestPreviewTargetToAsset,
} from '../../src/renderer/ui/preview/previewIngest';
import { createImageArtifactReference } from '../../src/main/agent/imageArtifacts';

const resourceRef = {
  id: 'resource:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  mimeType: 'image/png',
  byteLength: 21,
  fileName: 'managed-image.png',
};

const asset: AssetMetadata = {
  schemaVersion: 1,
  id: 'asset-1',
  mimeType: resourceRef.mimeType,
  byteSize: resourceRef.byteLength,
  originalFilename: resourceRef.fileName,
  createdAt: 1,
};

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('preview ingest', () => {
  test('offers Add to outline for a managed image and sends only its typed identity', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
    (globalThis as { window?: unknown }).window = {
      lin: {
        invoke: (command: string, args?: Record<string, unknown>) => {
          calls.push({ command, args });
          return Promise.resolve(asset);
        },
      },
    };
    const target = {
      kind: 'local-file' as const,
      path: resourceRef.fileName,
      entryKind: 'file' as const,
      threadId: 'thread-1',
      resourceRef,
    };

    expect(canAddPreviewTargetToOutline(target)).toBe(true);
    expect(await ingestPreviewTargetToAsset(target)).toEqual(asset);
    expect(calls).toEqual([{
      command: 'ingest_thread_resource',
      args: { threadId: 'thread-1', resourceRef },
    }]);
  });

  test('does not offer or attempt ingest for an unscoped resource reference', async () => {
    const target = {
      kind: 'local-file' as const,
      path: resourceRef.fileName,
      entryKind: 'file' as const,
      resourceRef,
    };

    expect(canAddPreviewTargetToOutline(target)).toBe(false);
    expect(await ingestPreviewTargetToAsset(target)).toBeNull();
  });

  test('ingests an image artifact through its normalized Preview path', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
    (globalThis as { window?: unknown }).window = {
      lin: {
        invoke: (command: string, args?: Record<string, unknown>) => {
          calls.push({ command, args });
          return Promise.resolve(asset);
        },
      },
    };
    const artifactRef = createImageArtifactReference({
      createdAt: 1,
      retention: 'observationOnly',
      original: null,
      observation: resourceRef,
      sourceDimensions: { width: 1, height: 1 },
      observationDimensions: { width: 1, height: 1 },
    });
    const materializedPath = '/tmp/agent-scratch/provider-thread/image-artifact/image';
    const target = {
      kind: 'local-file' as const,
      path: materializedPath,
      entryKind: 'file' as const,
      threadId: 'thread-1',
      imageArtifactRef: artifactRef,
    };

    expect(canAddPreviewTargetToOutline(target)).toBe(true);
    expect(await ingestPreviewTargetToAsset(target)).toEqual(asset);
    expect(calls).toEqual([{
      command: 'ingest_local_file',
      args: { path: materializedPath },
    }]);
  });
});
