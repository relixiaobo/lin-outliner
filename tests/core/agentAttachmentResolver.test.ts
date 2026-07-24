import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentResolver } from '../../src/main/agent/tools/attachments';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AttachmentResolver', () => {
  test('normalizes local files, assets, and non-image inline data to stable readable paths', async () => {
    const workdir = await temporaryRoot('tenon-attachment-workdir-');
    const scratchRoot = await temporaryRoot('tenon-attachment-scratch-');
    const externalRoot = await temporaryRoot('tenon-attachment-source-');
    const localPath = join(externalRoot, 'local.txt');
    const assetPath = join(externalRoot, 'asset.pdf');
    await writeFile(localPath, 'local contents');
    await writeFile(assetPath, 'asset contents');
    const resolver = new AttachmentResolver({
      scratchRoot,
      resolveAssetPath: async (assetId) => assetId === 'asset-1' ? assetPath : null,
    });

    const resolved = await resolver.resolve([
      attachment('local', 'local.txt', 'text/plain', { kind: 'localFile', path: localPath }),
      attachment('asset', 'asset.pdf', 'application/pdf', { kind: 'asset', assetId: 'asset-1' }),
      attachment('inline', 'inline.txt', 'text/plain', {
        kind: 'inline',
        dataBase64: Buffer.from('inline contents').toString('base64'),
      }),
      attachment('image', 'image.png', 'image/png', { kind: 'inline', dataBase64: 'aW1hZ2U=' }),
    ], { threadId: '018f0f24-7b2e-7a3f-8a4b-123456789abc', cwd: workdir });

    const scratchRealPath = await realpath(scratchRoot);
    for (const [index, expected] of ['local contents', 'asset contents', 'inline contents'].entries()) {
      const part = resolved[index];
      expect(part?.type).toBe('attachment');
      if (part?.type !== 'attachment' || part.source.kind !== 'localFile') throw new Error('Expected localFile attachment');
      expect((await realpath(part.source.path)).startsWith(scratchRealPath)).toBe(true);
      expect(await readFile(part.source.path, 'utf8')).toBe(expected);
    }
    expect(resolved[3]).toMatchObject({ source: { kind: 'inline', dataBase64: 'aW1hZ2U=' } });
  });

  test('fails closed when an asset no longer exists', async () => {
    const workdir = await temporaryRoot('tenon-attachment-workdir-');
    const scratchRoot = await temporaryRoot('tenon-attachment-scratch-');
    const resolver = new AttachmentResolver({ scratchRoot, resolveAssetPath: async () => null });

    await expect(resolver.resolve([
      attachment('missing', 'missing.pdf', 'application/pdf', { kind: 'asset', assetId: 'missing' }),
    ], { threadId: '018f0f24-7b2e-7a3f-8a4b-123456789abc', cwd: workdir }))
      .rejects.toThrow('Attachment asset was not found');
  });
});

function attachment(
  id: string,
  name: string,
  mimeType: string,
  source:
    | { readonly kind: 'asset'; readonly assetId: string }
    | { readonly kind: 'localFile'; readonly path: string }
    | { readonly kind: 'inline'; readonly dataBase64: string },
) {
  return { type: 'attachment' as const, id, name, mimeType, sizeBytes: 32, source };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
