import { describe, expect, test } from 'bun:test';
import type { ToolCall, ToolResultMessage } from '../../src/core/agentTypes';
import { summarizeProcess } from '../../src/renderer/ui/agent/AgentProcessBlock';

const readTool: ToolCall = {
  type: 'toolCall',
  id: 'tool-read',
  name: 'node_read',
  arguments: { nodeId: 'node-alpha' },
};

const readResult: ToolResultMessage = {
  role: 'toolResult',
  toolCallId: 'tool-read',
  toolName: 'node_read',
  content: [{ type: 'text', text: 'Alpha' }],
  isError: false,
  timestamp: 0,
};

describe('agent process summary', () => {
  test('keeps live unsealed process summary compact', () => {
    expect(summarizeProcess({
      firstThinkingText: null,
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map(),
      toolCalls: [readTool],
      sealed: false,
      turnActive: true,
      turnFailedWithoutProse: false,
    })).toBe('Working...');
  });

  test('summarizes mixed completed process as one collapsed process row', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map([[readTool.id, readResult]]),
      toolCalls: [readTool, { ...readTool, id: 'tool-search', name: 'node_search', arguments: { query: 'design system' } }],
      sealed: true,
      turnActive: false,
      turnFailedWithoutProse: false,
    })).toBe('Thought · used 2 tools');
  });

  test('summarizes solo completed tool by tool status', () => {
    expect(summarizeProcess({
      firstThinkingText: null,
      thinkingCount: 0,
      pendingToolCallIds: new Set(),
      results: new Map([[readTool.id, readResult]]),
      toolCalls: [readTool],
      sealed: true,
      turnActive: false,
      turnFailedWithoutProse: false,
    })).toBe('Read node "node-alpha"');
  });

  test('keeps interrupted process distinct from completed prose', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map(),
      toolCalls: [readTool],
      sealed: false,
      turnActive: false,
      turnFailedWithoutProse: true,
    })).toBe('Interrupted after thinking');
  });
});
