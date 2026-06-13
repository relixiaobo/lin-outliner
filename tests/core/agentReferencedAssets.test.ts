import { describe, expect, test } from 'bun:test';
import { plainText, type DocumentProjection, type NodeProjection } from '../../src/core/types';
import {
  buildReferencedFilesReminder,
  selectReferencedAssetNodes,
  type MaterializedReferencedFile,
} from '../../src/main/agentReferencedAssets';

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
  test('selects image and attachment nodes that carry an assetId', () => {
    const doc = projection([
      node({ id: 'img', type: 'image', assetId: 'asset-1', content: plainText('Diagram') }),
      node({ id: 'pdf', type: 'attachment', assetId: 'asset-2', mimeType: 'application/pdf', content: plainText('Report') }),
    ]);
    const selected = selectReferencedAssetNodes(doc, [
      { nodeId: 'img', title: 'Diagram' },
      { nodeId: 'pdf', title: 'Report' },
    ]);
    expect(selected).toEqual([
      { nodeId: 'img', title: 'Diagram', assetId: 'asset-1', nodeMimeType: undefined },
      { nodeId: 'pdf', title: 'Report', assetId: 'asset-2', nodeMimeType: 'application/pdf' },
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

  test('falls back to the node content when the reference has no title, and de-dupes', () => {
    const doc = projection([
      node({ id: 'img', type: 'image', assetId: 'asset-1', content: plainText('Stored title') }),
    ]);
    const selected = selectReferencedAssetNodes(doc, [
      { nodeId: 'img' },
      { nodeId: 'img', title: 'Stored title' },
    ]);
    expect(selected).toHaveLength(1);
    expect(selected[0].title).toBe('Stored title');
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
