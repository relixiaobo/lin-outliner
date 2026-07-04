import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from '../../src/core/agentTypes';
import { buildAgentTranscriptRenderRows } from '../../src/renderer/ui/agent/agentTranscriptRows';

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage['content'], timestamp: number): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp,
  };
}

function toolResult(toolCallId: string, timestamp: number): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'skill',
    content: [{ type: 'text', text: 'Skill completed.' }],
    isError: false,
    timestamp,
  };
}

function hiddenUserMessage(timestamp: number): UserMessage {
  return {
    role: 'user',
    content: '<system-reminder>hidden notification context</system-reminder>',
    timestamp,
  };
}

describe('buildAgentTranscriptRenderRows', () => {
  test('coalesces assistant continuation across matching tool results', () => {
    const rows = buildAgentTranscriptRenderRows({
      messages: [
        assistantMessage([
          {
            type: 'toolCall',
            id: 'skill-1',
            name: 'skill',
            arguments: { skill: 'data-cleanup' },
          },
        ], 100),
        toolResult('skill-1', 101),
        assistantMessage([{ type: 'text', text: 'Import preflight complete.' }], 102),
      ],
      pendingToolCallIds: new Set<string>(),
    });

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.type).toBe('message');
    if (row.type !== 'message') throw new Error('expected message row');
    expect(row.entry.message.role).toBe('assistant');
    expect(row.entry.message.content.map((block) => block.type)).toEqual(['toolCall', 'text']);
    expect(row.turnPhase).toBe('idle');
  });

  test('hidden-only user messages split assistant turns without rendering a row', () => {
    const rows = buildAgentTranscriptRenderRows({
      messages: [
        assistantMessage([{ type: 'text', text: 'First response.' }], 100),
        hiddenUserMessage(101),
        assistantMessage([{ type: 'text', text: 'Background response.' }], 102),
      ],
      pendingToolCallIds: new Set<string>(),
    });

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.type === 'message')).toBe(true);
    expect(rows.map((row) => row.type === 'message' ? row.entry.message.role : null)).toEqual(['assistant', 'assistant']);
  });

  test('keeps unmatched tool results visible as orphan rows', () => {
    const rows = buildAgentTranscriptRenderRows({
      messages: [toolResult('orphan-tool', 100)],
      pendingToolCallIds: new Set<string>(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('orphan-tool-result');
  });
});
