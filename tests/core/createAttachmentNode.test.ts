import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';

function mustFocus<T extends { focus?: { nodeId: string } }>(outcome: T) {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

describe('Core.createAttachmentNode', () => {
  test('creates an attachment node carrying asset metadata', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createAttachmentNode(libraryId, null, {
      assetId: 'asset-pdf',
      mimeType: 'application/pdf',
      originalFilename: 'Report.pdf',
      fileSize: 4096,
      thumbnailAssetId: 'asset-thumb',
      pdfPageCount: 3,
    }));

    const node = core.projection().nodes.find((entry) => entry.id === id);
    expect(node).toMatchObject({
      type: 'attachment',
      parentId: libraryId,
      assetId: 'asset-pdf',
      mimeType: 'application/pdf',
      originalFilename: 'Report.pdf',
      fileSize: 4096,
      thumbnailAssetId: 'asset-thumb',
      pdfPageCount: 3,
    });
  });

  test('persists attachment fields through Loro serialization', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createAttachmentNode(libraryId, null, {
      assetId: 'asset-audio',
      mimeType: 'audio/wav',
      originalFilename: 'memo.wav',
      fileSize: 128,
      audioDurationMs: 1000,
    }));

    const restored = Core.fromState(Core.deserializeState(core.serializeState()));
    const node = restored.projection().nodes.find((entry) => entry.id === id);
    expect(node).toMatchObject({
      type: 'attachment',
      assetId: 'asset-audio',
      mimeType: 'audio/wav',
      originalFilename: 'memo.wav',
      fileSize: 128,
      audioDurationMs: 1000,
    });
  });

  test('rejects image MIME types so images stay on the image node path', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    expect(() => core.createAttachmentNode(libraryId, null, {
      assetId: 'asset-image',
      mimeType: 'image/png',
      originalFilename: 'shot.png',
      fileSize: 24,
    })).toThrow(/image assets/);
  });

  test('rejects missing required metadata and invalid derived metadata', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    expect(() => core.createAttachmentNode(libraryId, null, {
      assetId: '',
      mimeType: 'application/pdf',
      originalFilename: 'report.pdf',
      fileSize: 1,
    })).toThrow(/assetId/);
    expect(() => core.createAttachmentNode(libraryId, null, {
      assetId: 'asset-pdf',
      mimeType: 'not a mime',
      originalFilename: 'report.pdf',
      fileSize: 1,
    })).toThrow(/MIME/);
    expect(() => core.createAttachmentNode(libraryId, null, {
      assetId: 'asset-pdf',
      mimeType: 'application/pdf',
      originalFilename: 'report.pdf',
      fileSize: -1,
    })).toThrow(/fileSize/);
    expect(() => core.createAttachmentNode(libraryId, null, {
      assetId: 'asset-pdf',
      mimeType: 'application/pdf',
      originalFilename: 'report.pdf',
      fileSize: 1,
      pdfPageCount: 0,
    })).toThrow(/positive integer/);
  });
});
