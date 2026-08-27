import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plainText, type DocumentProjection, type NodeProjection } from '../../src/core/types';
import {
  MAX_REFERENCED_RESOURCE_BYTES,
  admitReferencedResources,
} from '../../src/main/agent/capabilities/agentReferencedAssets';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function node(partial: Partial<NodeProjection> & { id: string }): NodeProjection {
  return {
    content: plainText(''),
    children: [],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    autoCollected: false,
    ...partial,
  } as NodeProjection;
}

function projection(nodes: NodeProjection[]): DocumentProjection {
  return { nodes, rootId: 'root', todayId: 'root' } as DocumentProjection;
}

describe('referenced resource admission', () => {
  test('uses the same attachment and image title precedence as the user view', async () => {
    const doc = projection([
      node({ id: 'root', type: 'outline', content: plainText('Root'), children: ['captioned', 'remote', 'alt'] }),
      node({
        id: 'captioned',
        type: 'image',
        parentId: 'root',
        content: plainText('Visible caption'),
        mediaUrl: 'https://example.test/captioned.png',
        mediaAlt: 'Alternative text',
      }),
      node({
        id: 'remote',
        type: 'image',
        parentId: 'root',
        mediaUrl: 'https://example.test/remote.png',
        mediaAlt: 'Remote alternative text',
      }),
      node({ id: 'alt', type: 'image', parentId: 'root', mediaAlt: 'Alternative only' }),
    ]);
    const result = await admitReferencedResources({
      projection: doc,
      references: [{ nodeId: 'captioned' }, { nodeId: 'remote' }, { nodeId: 'alt' }],
      writeResource: async () => { throw new Error('unexpected write'); },
    });

    expect(result?.payload.resources.map(({ title }) => title)).toEqual([
      'Visible caption',
      'https://example.test/remote.png',
      'Alternative only',
    ]);
  });

  test('snapshots every explicit Node and records typed missing resources', async () => {
    const doc = projection([
      node({ id: 'root', type: 'outline', content: plainText('Root'), children: ['note', 'missing-image'] }),
      node({ id: 'note', type: 'outline', parentId: 'root', content: plainText('Current argument'), description: 'Evidence' }),
      node({ id: 'missing-image', type: 'image', parentId: 'root', content: plainText('Diagram') }),
    ]);
    const result = await admitReferencedResources({
      projection: doc,
      references: [{ nodeId: 'note' }, { nodeId: 'missing-image' }, { nodeId: 'gone', note: 'Deleted' }],
      writeResource: async () => { throw new Error('unexpected write'); },
    });

    expect(result?.payload.resources).toMatchObject([
      {
        nodeId: 'note',
        title: 'Current argument',
        breadcrumb: [{ nodeId: 'root' }, { nodeId: 'note' }],
        content: 'Current argument - Evidence',
        resourceRef: null,
        unavailableReason: null,
      },
      { nodeId: 'missing-image', resourceRef: null, unavailableReason: 'missing' },
      { nodeId: 'gone', nodeType: 'unknown', title: 'Deleted', unavailableReason: 'missing' },
    ]);
  });

  test('resolves a private target title without exposing its id through a referenced resource', async () => {
    const privateTargetId = 'date:550e8400-e29b-41d4-a716-446655440000';
    const referenceNodeId = 'node:11111111-1111-4111-8111-111111111111';
    const doc = projection([
      node({ id: 'root', type: 'outline', content: plainText('Root'), children: [referenceNodeId] }),
      node({
        id: referenceNodeId,
        type: 'reference',
        parentId: 'root',
        targetId: privateTargetId,
      }),
      node({ id: privateTargetId, type: 'text', content: plainText('2026-08-26') }),
    ]);

    const result = await admitReferencedResources({
      projection: doc,
      references: [{ nodeId: referenceNodeId }],
      writeResource: async () => { throw new Error('unexpected write'); },
    });

    expect(result?.payload.resources[0]).toMatchObject({
      nodeId: referenceNodeId,
      title: '2026-08-26',
      content: '2026-08-26',
    });
    expect(JSON.stringify(result?.payload)).not.toContain(privateTargetId);
  });

  test('copies explicitly referenced asset bytes into a managed resource and inlines supported images', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-referenced-resource-'));
    roots.push(root);
    const path = join(root, 'diagram.png');
    const bytes = Buffer.from('image-bytes');
    await writeFile(path, bytes);
    const doc = projection([
      node({ id: 'root', type: 'outline', content: plainText('Root'), children: ['image', 'image-copy'] }),
      node({ id: 'image', type: 'image', parentId: 'root', assetId: 'asset-1', mediaAlt: 'Diagram' }),
      node({ id: 'image-copy', type: 'image', parentId: 'root', assetId: 'asset-1', mediaAlt: 'Diagram copy' }),
    ]);
    let writes = 0;
    const result = await admitReferencedResources({
      projection: doc,
      references: [{ nodeId: 'image' }, { nodeId: 'image' }, { nodeId: 'image-copy' }],
      resolveAsset: async () => ({ path, metadata: null }),
      writeResource: async (written, mimeType, fileName) => {
        writes += 1;
        return {
          created: true,
          ref: {
            id: createHash('sha256').update(written).digest('hex'),
            mimeType,
            byteLength: written.byteLength,
            fileName,
          },
        };
      },
    });

    expect(writes).toBe(1);
    expect(result?.payload.resources).toHaveLength(2);
    expect(result?.payload.resources[0]).toMatchObject({
      nodeId: 'image',
      title: 'Diagram',
      resourceRef: { mimeType: 'image/png', byteLength: bytes.byteLength, fileName: 'diagram.png' },
      inlineImage: true,
      unavailableReason: null,
    });
    expect(result?.payload.resources[1]).toMatchObject({
      nodeId: 'image-copy',
      title: 'Diagram copy',
      resourceRef: result?.payload.resources[0]?.resourceRef,
      inlineImage: false,
      unavailableReason: null,
    });
    expect(result?.resourceRefs).toHaveLength(1);
    expect(result?.createdResourceRefs).toEqual(result?.resourceRefs);
  });

  test('declares distinct typed dependencies for same-byte resources with different MIME types', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-referenced-resource-typed-'));
    roots.push(root);
    const path = join(root, 'shared.bin');
    const bytes = Buffer.from('shared-bytes');
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path, bytes);
    const doc = projection([
      node({ id: 'root', type: 'outline', content: plainText('Root'), children: ['first', 'second'] }),
      node({ id: 'first', type: 'attachment', parentId: 'root', assetId: 'asset-1' }),
      node({ id: 'second', type: 'attachment', parentId: 'root', assetId: 'asset-2' }),
    ]);
    let writes = 0;
    const result = await admitReferencedResources({
      projection: doc,
      references: [{ nodeId: 'first' }, { nodeId: 'second' }],
      resolveAsset: async (assetId) => ({
        path,
        metadata: {
          schemaVersion: 1,
          id: assetId,
          mimeType: assetId === 'asset-1' ? 'application/octet-stream' : 'application/pdf',
          byteSize: bytes.byteLength,
          sha256: digest,
          originalFilename: 'shared.bin',
          createdAt: 1,
        },
      }),
      writeResource: async (written, mimeType, fileName) => ({
        created: writes++ === 0,
        ref: {
          id: createHash('sha256').update(written).digest('hex'),
          mimeType,
          byteLength: written.byteLength,
          fileName,
        },
      }),
    });

    expect(writes).toBe(2);
    expect(result?.resourceRefs).toEqual([
      expect.objectContaining({ id: digest, mimeType: 'application/octet-stream', fileName: 'shared.bin' }),
      expect.objectContaining({ id: digest, mimeType: 'application/pdf', fileName: 'shared.bin' }),
    ]);
    expect(result?.createdResourceRefs).toEqual([result?.resourceRefs[0]]);
  });

  test('rejects symlinked and over-budget asset sources before copying bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-referenced-resource-integrity-'));
    roots.push(root);
    const targetPath = join(root, 'target.bin');
    const symlinkPath = join(root, 'linked.bin');
    await writeFile(targetPath, 'asset');
    await symlink(targetPath, symlinkPath);
    const doc = projection([
      node({ id: 'root', type: 'outline', content: plainText('Root'), children: ['linked', 'large'] }),
      node({ id: 'linked', type: 'attachment', parentId: 'root', assetId: 'asset-linked' }),
      node({ id: 'large', type: 'attachment', parentId: 'root', assetId: 'asset-large' }),
    ]);
    const result = await admitReferencedResources({
      projection: doc,
      references: [{ nodeId: 'linked' }, { nodeId: 'large' }],
      resolveAsset: async (assetId) => assetId === 'asset-linked'
        ? { path: symlinkPath, metadata: null }
        : {
            path: targetPath,
            metadata: {
              schemaVersion: 1,
              id: assetId,
              mimeType: 'application/octet-stream',
              byteSize: MAX_REFERENCED_RESOURCE_BYTES + 1,
              sha256: '0'.repeat(64),
              originalFilename: 'large.bin',
              createdAt: 1,
            },
          },
      writeResource: async () => { throw new Error('unexpected write'); },
    });

    expect(result?.payload.resources).toMatchObject([
      { nodeId: 'linked', resourceRef: null, unavailableReason: 'corrupt' },
      { nodeId: 'large', resourceRef: null, unavailableReason: 'quotaExceeded' },
    ]);
  });
});
