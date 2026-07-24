import { describe, expect, test } from 'bun:test';
import { threadPreviewFromContent } from '../../src/core/agent/threadPreview';

describe('Thread preview', () => {
  test('uses text before attachment and Node-reference fallbacks', () => {
    expect(threadPreviewFromContent([
      {
        type: 'attachment',
        id: 'attachment-1',
        name: 'fallback.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        source: { kind: 'asset', assetId: 'asset-1' },
      },
      { type: 'nodeReference', nodeId: 'node-1', note: 'Node fallback' },
      { type: 'text', text: '  Primary\nrequest  ' },
    ])).toBe('Primary request');
    expect(threadPreviewFromContent([{
      type: 'attachment',
      id: 'attachment-1',
      name: 'fallback.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      source: { kind: 'asset', assetId: 'asset-1' },
    }])).toBe('fallback.pdf');
    expect(threadPreviewFromContent([
      { type: 'nodeReference', nodeId: 'node-1', note: '  Node\n fallback  ' },
    ])).toBe('Node fallback');
  });

  test('keeps the complete preview within its persistence bound', () => {
    const preview = threadPreviewFromContent([{ type: 'text', text: 'x'.repeat(400) }]);
    expect(preview).toHaveLength(200);
    expect(preview.endsWith('...')).toBe(true);
  });
});
