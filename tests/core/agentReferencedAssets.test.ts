import { describe, expect, test } from 'bun:test';
import { plainText, type DocumentProjection, type NodeProjection } from '../../src/core/types';
import {
  buildReferencedFilesReminder,
  selectReferencedAssetNodes,
  type MaterializedReferencedFile,
} from '../../src/main/agent/capabilities/agentReferencedAssets';

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

describe('selectReferencedAssetNodes', () => {
  test('selects image and attachment nodes that carry an assetId, with type-specific fields', () => {
    const doc = projection([
      node({ id: 'img', type: 'image', assetId: 'asset-1', mediaAlt: 'A diagram', content: plainText('Diagram') }),
      node({ id: 'pdf', type: 'attachment', assetId: 'asset-2', mimeType: 'application/pdf', originalFilename: 'report.pdf', fileSize: 4096, content: plainText('Report') }),
    ]);
    const selected = selectReferencedAssetNodes(doc, [
      { nodeId: 'img', title: 'Diagram' },
      { nodeId: 'pdf', title: 'Report' },
    ]);
    expect(selected).toEqual([
      { nodeId: 'img', assetId: 'asset-1', isImageNode: true, title: 'Diagram' },
      { nodeId: 'pdf', assetId: 'asset-2', isImageNode: false, title: 'Report', nodeMimeType: 'application/pdf', nodeFileName: 'report.pdf', nodeFileSize: 4096 },
    ]);
  });

  test('drops references to non-asset nodes and asset nodes without an assetId', () => {
    const doc = projection([
      node({ id: 'text', content: plainText('Just text') }),
      node({ id: 'img-empty', type: 'image', content: plainText('No bytes') }),
      node({ id: 'img', type: 'image', assetId: 'asset-1', content: plainText('Diagram') }),
    ]);
    const selected = selectReferencedAssetNodes(doc, [
      { nodeId: 'text', title: 'Just text' },
      { nodeId: 'img-empty', title: 'No bytes' },
      { nodeId: 'missing', title: 'Gone' },
      { nodeId: 'img', title: 'Diagram' },
    ]);
    expect(selected.map((s) => s.nodeId)).toEqual(['img']);
  });

  test('de-dupes by assetId — the same node twice, or two nodes sharing one asset', () => {
    const doc = projection([
      node({ id: 'img-a', type: 'image', assetId: 'shared', content: plainText('Copy A') }),
      node({ id: 'img-b', type: 'image', assetId: 'shared', content: plainText('Copy B') }),
    ]);
    const selected = selectReferencedAssetNodes(doc, [
      { nodeId: 'img-a', title: 'Copy A' },
      { nodeId: 'img-a', title: 'Copy A' },
      { nodeId: 'img-b', title: 'Copy B' },
    ]);
    expect(selected).toHaveLength(1);
    expect(selected[0].nodeId).toBe('img-a');
  });

  test('with no ref title: image falls back to mediaAlt; attachment prefers display text over the stale originalFilename', () => {
    const doc = projection([
      node({ id: 'img', type: 'image', assetId: 'asset-1', mediaAlt: 'line one\nline two', content: plainText('Stored') }),
      // The attachment title prefers the node's current display text over originalFilename
      // (the immutable import-time name, which goes stale after a node-page rename).
      node({ id: 'pdf', type: 'attachment', assetId: 'asset-2', originalFilename: 'report.pdf', content: plainText('Renamed') }),
      // …falling back to originalFilename only when there is no display text.
      node({ id: 'raw', type: 'attachment', assetId: 'asset-3', originalFilename: 'raw.bin', content: plainText('') }),
    ]);
    const selected = selectReferencedAssetNodes(doc, [{ nodeId: 'img' }, { nodeId: 'pdf' }, { nodeId: 'raw' }]);
    expect(selected[0].title).toBe('line one line two');
    expect(selected[1].title).toBe('Renamed');
    expect(selected[2].title).toBe('raw.bin');
  });

  test('returns empty for empty or missing inputs', () => {
    const doc = projection([node({ id: 'img', type: 'image', assetId: 'asset-1' })]);
    expect(selectReferencedAssetNodes(doc, undefined)).toEqual([]);
    expect(selectReferencedAssetNodes(doc, [])).toEqual([]);
  });
});

describe('buildReferencedFilesReminder', () => {
  test('returns null when there are no files', () => {
    expect(buildReferencedFilesReminder([])).toBeNull();
  });

  test('lists each file with its scratch path and flags inline images', () => {
    const files: MaterializedReferencedFile[] = [
      { nodeId: 'img', title: 'Diagram', mimeType: 'image/png', sizeBytes: 1234, path: '/scratch/a-diagram.png', inlineImage: true },
      { nodeId: 'pdf', title: 'Report', mimeType: 'application/pdf', sizeBytes: 0, path: '/scratch/b-report.pdf', inlineImage: false },
    ];
    const reminder = buildReferencedFilesReminder(files)!;
    expect(reminder).toContain('<referenced-files>');
    expect(reminder).toContain('use file_read');
    expect(reminder).toContain('node_id="img"');
    expect(reminder).toContain('path="/scratch/a-diagram.png"');
    expect(reminder).toContain('mime="image/png"');
    expect(reminder).toContain('size_bytes="1234"');
    expect(reminder).toContain('inline_image="true"');
    // size_bytes is omitted when unknown (0), and the pdf is not flagged inline.
    expect(reminder).toContain('path="/scratch/b-report.pdf"');
    expect(reminder).not.toContain('size_bytes="0"');
    expect(reminder.match(/inline_image="true"/g)).toHaveLength(1);
  });

  test('escapes attribute values', () => {
    const reminder = buildReferencedFilesReminder([
      { nodeId: 'n', title: 'A & B "quoted"', mimeType: 'image/png', sizeBytes: 1, path: '/s/<x>.png', inlineImage: false },
    ])!;
    expect(reminder).toContain('title="A &amp; B &quot;quoted&quot;"');
    expect(reminder).toContain('path="/s/&lt;x&gt;.png"');
  });
});
