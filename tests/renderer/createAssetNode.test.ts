import { describe, expect, spyOn, test } from 'bun:test';
import { api } from '../../src/renderer/api/client';
import { createAssetNode } from '../../src/renderer/ui/interactions/attachmentIngest';
import type { CommandRunner } from '../../src/renderer/ui/shared';
import type { AssetMetadata, CommandResult } from '../../src/renderer/api/types';

const imageAsset: AssetMetadata = {
  schemaVersion: 1,
  id: 'img1',
  mimeType: 'image/png',
  byteSize: 1024,
  sha256: '0'.repeat(64),
  createdAt: 1,
  originalFilename: 'shot.png',
  imageWidth: 200,
  imageHeight: 100,
};

const pdfAsset: AssetMetadata = {
  schemaVersion: 1,
  id: 'doc1',
  mimeType: 'application/pdf',
  byteSize: 4096,
  sha256: '1'.repeat(64),
  createdAt: 1,
  originalFilename: 'report.pdf',
  pdfPageCount: 3,
};

const commandResult: CommandResult = {
  update: {
    kind: 'delta',
    revision: 1,
    todayId: 'today',
    changedNodes: [],
    removedIds: [],
  },
};

// A runner that actually invokes the operation and records the options it was handed.
function passthroughRunner(seen: { options?: unknown }): CommandRunner {
  return async (operation, options) => {
    seen.options = options;
    return operation();
  };
}

describe('createAssetNode', () => {
  test('routes an image asset to the image intent with its pixel dims (no alt)', async () => {
    const createImageNode = spyOn(api, 'createImageNode').mockImplementation(async () => commandResult);
    try {
      await createAssetNode(passthroughRunner({}), 'parent', 2, imageAsset);
      expect(createImageNode.mock.calls).toEqual([[
        'parent',
        2,
        { assetId: 'img1', width: 200, height: 100, name: 'shot.png' },
      ]]);
    } finally {
      createImageNode.mockRestore();
    }
  });

  test('routes a non-image asset to the attachment intent with full metadata', async () => {
    const createAttachmentNode = spyOn(api, 'createAttachmentNode').mockImplementation(async () => commandResult);
    try {
      await createAssetNode(passthroughRunner({}), 'parent', null, pdfAsset);
      expect(createAttachmentNode.mock.calls).toEqual([[
        'parent',
        null,
        {
          assetId: 'doc1',
          mimeType: 'application/pdf',
          originalFilename: 'report.pdf',
          fileSize: 4096,
          pdfPageCount: 3,
        },
      ]]);
    } finally {
      createAttachmentNode.mockRestore();
    }
  });

  test('forwards the runner result, so a failed command (null) propagates to the caller', async () => {
    // useCommandRunner swallows a failed command into a null result; the ingest
    // bridge relies on that null reaching it to avoid a false "inserted".
    const failingRunner: CommandRunner = async () => null;
    expect(await createAssetNode(failingRunner, 'parent', null, imageAsset)).toBeNull();
  });

  test('forwards runner options (the bridge suppresses focus)', async () => {
    const createImageNode = spyOn(api, 'createImageNode').mockImplementation(async () => commandResult);
    try {
      const seen: { options?: unknown } = {};
      await createAssetNode(passthroughRunner(seen), 'parent', null, imageAsset, { applyFocus: false });
      expect(seen.options).toEqual({ applyFocus: false });
    } finally {
      createImageNode.mockRestore();
    }
  });
});
