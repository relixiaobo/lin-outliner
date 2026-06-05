import { describe, expect, test } from 'bun:test';
import type { ToolCall, ToolResultMessage } from '../../src/core/agentTypes';
import { summarizeProcess } from '../../src/renderer/ui/agent/AgentProcessBlock';
import { getMessages } from '../../src/core/i18n';

const { process, toolCall: toolCallLabels, thinking } = getMessages('en').agent;
const thinkingLabel = thinking.thinking;

const readTool: ToolCall = {
  type: 'toolCall',
  id: 'tool-read',
  name: 'node_read',
  arguments: { nodeId: 'node-alpha' },
};

const searchTool: ToolCall = {
  type: 'toolCall',
  id: 'tool-search',
  name: 'node_search',
  arguments: { query: 'design system' },
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
  test('live + collapsed header shows the currently running tool', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map(),
      toolCalls: [readTool],
      turnActive: true,
      liveCollapsed: true,
      turnFailedWithoutProse: false,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Reading node "node-alpha"');
  });

  test('live + collapsed header previews the latest thought while still thinking', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Let me map the outline structure first',
      lastThinkingText: 'Let me map the outline structure first',
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map(),
      toolCalls: [],
      turnActive: true,
      liveCollapsed: true,
      turnFailedWithoutProse: false,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Let me map the outline structure first');
  });

  test('live + collapsed header falls back to the thinking label with no thought text yet', () => {
    expect(summarizeProcess({
      firstThinkingText: null,
      lastThinkingText: null,
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map(),
      toolCalls: [],
      turnActive: true,
      liveCollapsed: true,
      turnFailedWithoutProse: false,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe(thinkingLabel);
  });

  test('live + expanded header shows the static group summary, not the live tool', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map([[readTool.id, readResult]]),
      toolCalls: [readTool, searchTool],
      turnActive: true,
      liveCollapsed: false,
      turnFailedWithoutProse: false,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Thought · used 2 tools');
  });

  test('summarizes mixed completed process as one collapsed process row', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map([[readTool.id, readResult]]),
      toolCalls: [readTool, searchTool],
      turnActive: false,
      liveCollapsed: false,
      turnFailedWithoutProse: false,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Thought · used 2 tools');
  });

  test('summarizes solo completed tool by tool status', () => {
    expect(summarizeProcess({
      firstThinkingText: null,
      lastThinkingText: null,
      thinkingCount: 0,
      pendingToolCallIds: new Set(),
      results: new Map([[readTool.id, readResult]]),
      toolCalls: [readTool],
      turnActive: false,
      liveCollapsed: false,
      turnFailedWithoutProse: false,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Read node "node-alpha"');
  });

  test('keeps interrupted process distinct from completed prose', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map(),
      toolCalls: [readTool],
      turnActive: false,
      liveCollapsed: false,
      turnFailedWithoutProse: true,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Interrupted after thinking');
  });
});
