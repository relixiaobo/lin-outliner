import { describe, expect, test } from 'bun:test';
import { systemReminder } from '../../src/core/agentAttachments';
import type { UserMessage } from '../../src/core/agentTypes';
import type { AgentMessageEntry } from '../../src/renderer/agent/runtime';
import { systemLineText } from '../../src/renderer/ui/agent/agentSystemLine';

function systemEntry(message: UserMessage): AgentMessageEntry {
  return {
    id: 'system-entry',
    kind: 'message',
    nodeId: 'system-message',
    message,
    branches: null,
    streaming: false,
    actor: { type: 'system' },
    runId: null,
    runDurationMs: null,
    runStartedAtMs: null,
    turnInterrupted: false,
  };
}

describe('agent system line text', () => {
  test('hides system reminder blocks while keeping visible Dream anchor text', () => {
    const message: UserMessage = {
      role: 'user',
      timestamp: 1,
      content: [
        { type: 'text', text: systemReminder('<memory-dream-run>\nprivate prompt\n</memory-dream-run>') },
        { type: 'text', text: 'Scheduled Dream · 2026-06-30 · 121 messages · 60031 chars' },
      ],
    };

    expect(systemLineText(systemEntry(message))).toBe(
      'Scheduled Dream · 2026-06-30 · 121 messages · 60031 chars',
    );
  });

  test('suppresses hidden-only system messages', () => {
    const message: UserMessage = {
      role: 'user',
      timestamp: 1,
      content: [{ type: 'text', text: systemReminder('Background-only prompt') }],
    };

    expect(systemLineText(systemEntry(message))).toBeNull();
  });
});
