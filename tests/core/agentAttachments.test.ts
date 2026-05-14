import { describe, expect, test } from 'bun:test';
import {
  parseAgentTextAttachmentBlock,
  serializeAgentTextAttachment,
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
});
