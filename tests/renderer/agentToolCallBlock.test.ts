import { describe, expect, test } from 'bun:test';
import type { ToolCall } from '../../src/core/agentTypes';
import { getToolCallStatus, getToolIcon, summarizeToolCall } from '../../src/renderer/ui/agent/AgentToolCallBlock';
import { BrainIcon, NodeCreateToolIcon } from '../../src/renderer/ui/icons';
import { getMessages } from '../../src/core/i18n';

const labels = getMessages('en').agent.toolCall;

function recallToolCall(args: Record<string, unknown>): ToolCall {
  return {
    type: 'toolCall',
    id: 'tool-recall',
    name: 'recall',
    arguments: args,
  };
}

function dreamToolCall(args: Record<string, unknown>): ToolCall {
  return {
    type: 'toolCall',
    id: 'tool-dream',
    name: 'dream',
    arguments: args,
  };
}

function fileWriteToolCall(args: Record<string, unknown>): ToolCall {
  return {
    type: 'toolCall',
    id: 'tool-file-write',
    name: 'file_write',
    arguments: args,
  };
}

describe('agent tool call block', () => {
  test('marks only runtime-reported tool ids as pending while a turn is active', () => {
    expect(getToolCallStatus('tool-running', undefined, new Set(['tool-running']), true)).toBe('pending');
    expect(getToolCallStatus('tool-stale', undefined, new Set(['tool-running']), false)).toBe('error');
    expect(getToolCallStatus('tool-finishing', undefined, new Set(), true)).toBe('pending');
    expect(getToolCallStatus('tool-idle', undefined, new Set(), false)).toBe('error');
  });

  test('uses memory icon and summarizes recall', () => {
    expect(getToolIcon(recallToolCall({ query: 'preferences' }))).toBe(BrainIcon);
    expect(summarizeToolCall(recallToolCall({ query: 'preferences' }), 'pending', labels)).toBe('Recalling memory "preferences"');
    expect(summarizeToolCall(recallToolCall({ query: 'preferences' }), 'done', labels)).toBe('Recalled memory "preferences"');
    expect(summarizeToolCall(recallToolCall({ query: 'preferences' }), 'error', labels)).toBe('Failed to recall memory "preferences"');
  });

  test('uses memory icon and summarizes Dream', () => {
    expect(getToolIcon(dreamToolCall({}))).toBe(BrainIcon);
    expect(summarizeToolCall(dreamToolCall({}), 'pending', labels)).toBe('Dreaming memory');
    expect(summarizeToolCall(dreamToolCall({}), 'done', labels)).toBe('Dreamed memory');
    expect(summarizeToolCall(dreamToolCall({}), 'error', labels)).toBe('Failed to dream memory');
  });

  test('summarizes file_write with the path the model passed (as every tool does)', () => {
    const call = fileWriteToolCall({ file_path: 'reports/report.md', content: '...' });
    expect(getToolIcon(call)).toBe(NodeCreateToolIcon);
    expect(summarizeToolCall(call, 'pending', labels)).toBe('Writing file "reports/report.md"');
    expect(summarizeToolCall(call, 'done', labels)).toBe('Wrote file "reports/report.md"');
    expect(summarizeToolCall(call, 'error', labels)).toBe('Failed to write file "reports/report.md"');
  });
});
