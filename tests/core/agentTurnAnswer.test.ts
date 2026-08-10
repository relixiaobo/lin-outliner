import { describe, expect, test } from 'bun:test';
import type { ThreadItem } from '../../src/core/agent/protocol';
import { turnTerminalAnswer } from '../../src/core/agent/turnAnswer';

describe('Turn terminal answer', () => {
  test('excludes commentary and interrupted attempts from the completed answer', () => {
    expect(turnTerminalAnswer([
      message('commentary', 'Checking.'),
      message('interrupted', 'Partial answer.'),
      message('final_answer', 'Complete answer.'),
    ])).toBe('Complete answer.');
  });
});

function message(
  phase: Extract<ThreadItem, { type: 'agentMessage' }>['phase'],
  text: string,
): Extract<ThreadItem, { type: 'agentMessage' }> {
  return {
    type: 'agentMessage',
    id: `message-${phase ?? 'legacy'}`,
    provenance: {
      originThreadId: 'thread',
      originTurnId: 'turn',
      originItemId: `message-${phase ?? 'legacy'}`,
    },
    text,
    phase,
    memoryCitation: null,
  };
}
