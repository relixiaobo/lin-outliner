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
  test('maps an image asset to an ordinary Source-backed Node', async () => {
    const createSourceNode = spyOn(api, 'createSourceNode').mockImplementation(async () => commandResult);
    try {
      await createAssetNode(passthroughRunner({}), 'parent', 2, imageAsset);
      expect(createSourceNode.mock.calls).toEqual([[
        'parent',
        2,
        { assetId: 'img1', name: 'shot.png' },
      ]]);
    } finally {
      createSourceNode.mockRestore();
    }
  });

  test('maps a document asset to the same ordinary Source-backed Node shape', async () => {
    const createSourceNode = spyOn(api, 'createSourceNode').mockImplementation(async () => commandResult);
    try {
      await createAssetNode(passthroughRunner({}), 'parent', null, pdfAsset);
      expect(createSourceNode.mock.calls).toEqual([[
        'parent',
        null,
        { assetId: 'doc1', name: 'report.pdf' },
      ]]);
    } finally {
      createSourceNode.mockRestore();
    }
  });

  test('forwards the runner result, so a failed command (null) propagates to the caller', async () => {
    // useCommandRunner swallows a failed command into a null result; the ingest
    // bridge relies on that null reaching it to avoid a false "inserted".
    const failingRunner: CommandRunner = async () => null;
    expect(await createAssetNode(failingRunner, 'parent', null, imageAsset)).toBeNull();
  });

  test('forwards runner options (the bridge suppresses focus)', async () => {
    const createSourceNode = spyOn(api, 'createSourceNode').mockImplementation(async () => commandResult);
    try {
      const seen: { options?: unknown } = {};
      await createAssetNode(passthroughRunner(seen), 'parent', null, imageAsset, { applyFocus: false });
      expect(seen.options).toEqual({ applyFocus: false });
    } finally {
      createSourceNode.mockRestore();
    }
  });
});
