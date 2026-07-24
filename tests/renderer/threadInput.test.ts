import { describe, expect, test } from 'bun:test';
import type { Turn } from '../../src/core/agent/protocol';
import { replaceUserContentText, turnUserContent } from '../../src/renderer/agent/threadInput';

describe('renderer Thread structured input', () => {
  const attachment = {
    type: 'attachment' as const,
    id: 'attachment-1',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 42,
    source: { kind: 'localFile' as const, path: '/workspace/report.pdf' },
  };
  const reference = { type: 'nodeReference' as const, nodeId: 'node-1', note: 'Research' };

  test('preserves attachments and Node references while editing message text', () => {
    expect(replaceUserContentText([
      { type: 'text', text: 'Original' },
      attachment,
      reference,
      { type: 'text', text: 'Follow-up text' },
    ], 'Edited')).toEqual([
      { type: 'text', text: 'Edited' },
      attachment,
      reference,
    ]);
  });

  test('collects attachment-only and structured user input for retry and regeneration', () => {
    const turn = {
      id: 'turn-1',
      items: [{
        type: 'userMessage',
        id: 'item-1',
        provenance: { originThreadId: 'thread-1', originTurnId: 'turn-1', originItemId: 'item-1' },
        clientId: null,
        content: [attachment, reference],
      }],
      itemsView: 'full',
      provenance: { originThreadId: 'thread-1', originTurnId: 'turn-1', trigger: { kind: 'user' } },
      status: 'failed',
      error: { message: 'failed' },
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    } satisfies Turn;

    expect(turnUserContent(turn)).toEqual([attachment, reference]);
  });
});
