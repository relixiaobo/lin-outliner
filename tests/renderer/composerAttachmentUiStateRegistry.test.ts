import { describe, expect, test } from 'bun:test';
import { ComposerAttachmentUiStateRegistry } from '../../src/renderer/agent/composerAttachmentUiStateRegistry';

describe('Composer attachment UI state registry', () => {
  test('keeps a canonical preview lease alive across fresh recalled attachment identities', () => {
    const revoked: string[] = [];
    const registry = new ComposerAttachmentUiStateRegistry((previewUrl) => revoked.push(previewUrl));

    registry.patch('canonical-attachment', {
      previewUrl: 'blob:history-image',
      sourceKey: 'path:/tmp/history.png',
      textExcerpt: 'renderer-only draft metadata',
    });
    registry.rememberCanonicalPreview('canonical-attachment');

    expect(registry.previewUrls.size).toBe(0);
    expect(registry.sourceKeys.size).toBe(0);
    expect(registry.textExcerpts.size).toBe(0);
    expect(registry.canonicalPreviewFor('canonical-attachment')).toBe('blob:history-image');
    expect(revoked).toEqual([]);

    registry.mount([{
      attachmentId: 'fresh-draft-attachment',
      previewUrl: registry.canonicalPreviewFor('canonical-attachment')!,
    }]);
    expect(registry.previewUrls.get('fresh-draft-attachment')).toBe('blob:history-image');

    registry.reconcileCanonical(new Set());
    expect(revoked).toEqual([]);
    registry.releaseDraft('fresh-draft-attachment');
    expect(revoked).toEqual(['blob:history-image']);
  });

  test('captures hidden-slot metadata and revokes shared preview URLs once', () => {
    const revoked: string[] = [];
    const registry = new ComposerAttachmentUiStateRegistry((previewUrl) => revoked.push(previewUrl));
    registry.patch('visible', {
      previewUrl: 'blob:shared-image',
      sourceKey: 'payload:opaque',
      textExcerpt: 'Pasted content',
    });
    registry.mount([{ attachmentId: 'hidden', previewUrl: 'blob:shared-image' }]);

    expect(registry.capture(['visible'])).toEqual([{
      attachmentId: 'visible',
      previewUrl: 'blob:shared-image',
      sourceKey: 'payload:opaque',
      textExcerpt: 'Pasted content',
    }]);

    registry.releaseDraft('visible');
    expect(revoked).toEqual([]);
    registry.clear();
    expect(revoked).toEqual(['blob:shared-image']);
  });
});
