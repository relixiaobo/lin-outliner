import { afterEach, describe, expect, test } from 'bun:test';
import { createAssetNode } from '../../src/renderer/ui/interactions/attachmentIngest';
import type { CommandRunner } from '../../src/renderer/ui/shared';
import type { AssetMetadata } from '../../src/renderer/api/types';

// createAssetNode wraps api.create{Image,Attachment}Node, which call
// window.lin.invoke; stub it to capture the command + args without a real bridge.
interface InvokeCall {
  command: string;
  args: Record<string, unknown> | undefined;
}

function stubBridge(): InvokeCall[] {
  const calls: InvokeCall[] = [];
  (globalThis as { window?: unknown }).window = {
    lin: {
      invoke: (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return Promise.resolve({ update: { kind: 'delta' }, focus: null });
      },
    },
  };
  return calls;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const imageAsset: AssetMetadata = {
  id: 'img1',
  mimeType: 'image/png',
  byteSize: 1024,
  createdAt: 1,
  originalFilename: 'shot.png',
  imageWidth: 200,
  imageHeight: 100,
};

const pdfAsset: AssetMetadata = {
  id: 'doc1',
  mimeType: 'application/pdf',
  byteSize: 4096,
  createdAt: 1,
  originalFilename: 'report.pdf',
  pdfPageCount: 3,
};

// A runner that actually invokes the operation, so the api -> window.lin.invoke
// path is exercised; records the options it was handed.
function passthroughRunner(seen: { options?: unknown }): CommandRunner {
  return async (operation, options) => {
    seen.options = options;
    return operation();
  };
}

describe('createAssetNode', () => {
  test('routes an image asset to create_image_node with its pixel dims (no alt)', async () => {
    const calls = stubBridge();
    await createAssetNode(passthroughRunner({}), 'parent', 2, imageAsset);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('create_image_node');
    expect(calls[0]!.args).toEqual({ parentId: 'parent', index: 2, assetId: 'img1', width: 200, height: 100 });
  });

  test('routes a non-image asset to create_attachment_node with full metadata', async () => {
    const calls = stubBridge();
    await createAssetNode(passthroughRunner({}), 'parent', null, pdfAsset);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('create_attachment_node');
    expect(calls[0]!.args).toMatchObject({
      parentId: 'parent',
      index: null,
      assetId: 'doc1',
      mimeType: 'application/pdf',
      originalFilename: 'report.pdf',
      pdfPageCount: 3,
    });
  });

  test('forwards the runner result, so a failed command (null) propagates to the caller', async () => {
    // useCommandRunner swallows a failed command into a null result; the ingest
    // bridge relies on that null reaching it to avoid a false "inserted".
    const failingRunner: CommandRunner = async () => null;
    expect(await createAssetNode(failingRunner, 'parent', null, imageAsset)).toBeNull();
  });

  test('forwards runner options (the bridge suppresses focus)', async () => {
    stubBridge();
    const seen: { options?: unknown } = {};
    await createAssetNode(passthroughRunner(seen), 'parent', null, imageAsset, { applyFocus: false });
    expect(seen.options).toEqual({ applyFocus: false });
  });
});
