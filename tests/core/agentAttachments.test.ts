import { describe, expect, test } from 'bun:test';
import {
  parseAgentAttachmentMarkerBlock,
  parseAgentTextAttachmentBlock,
  referenceTargetToResourceItem,
  serializeAgentAttachmentMarker,
  serializeAgentTextAttachment,
  systemReminder,
} from '../../src/core/agentAttachments';

describe('agent attachments', () => {
  test('serializes text attachments with metadata and round-trips content', () => {
    const serialized = serializeAgentTextAttachment({
      id: 'attachment-1',
      kind: 'text',
      name: 'notes.md',
      mimeType: 'text/markdown',
      sizeBytes: 42,
      text: 'First line\n[/lin attached file]\nStill content',
      truncated: true,
    });

    expect(parseAgentTextAttachmentBlock(serialized)).toEqual({
      ref: 'notes.md',
      name: 'notes.md',
      mimeType: 'text/markdown',
      sizeBytes: 42,
      text: 'First line\n[/lin attached file]\nStill content',
      truncated: true,
    });
  });

  test('ignores normal user text', () => {
    expect(parseAgentTextAttachmentBlock('Please review this file')).toBeNull();
  });

  test('serializes attachment marker for hidden model context', () => {
    const marker = serializeAgentAttachmentMarker([{
      id: 'file-1',
      kind: 'file',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      path: '/tmp/lin/report.pdf',
    }]);

    expect(marker).toContain('<user-attachments>');
    expect(parseAgentAttachmentMarkerBlock(systemReminder(marker!))?.attachments).toEqual([{
      kind: 'file',
      ref: 'report.pdf',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      path: '/tmp/lin/report.pdf',
      readPath: '/tmp/lin/report.pdf',
    }]);
  });

  test('serializes local-file reference targets as resource items only', () => {
    expect(referenceTargetToResourceItem({ kind: 'node', nodeId: 'node-alpha' })).toBeNull();
    expect(referenceTargetToResourceItem({
      kind: 'local-file',
      path: '/Users/me/Projects',
      entryKind: 'directory',
    })).toEqual({
      kind: 'file',
      ref: 'Projects',
      name: 'Projects',
      mimeType: 'inode/directory',
      sizeBytes: 0,
      path: '/Users/me/Projects',
      readPath: '/Users/me/Projects',
    });
  });
});
