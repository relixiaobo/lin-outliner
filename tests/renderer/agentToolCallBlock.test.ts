import { describe, expect, test } from 'bun:test';
import type { ToolCall } from '../../src/core/agentTypes';
import { getToolIcon, summarizeToolCall } from '../../src/renderer/ui/agent/AgentToolCallBlock';
import { BrainIcon } from '../../src/renderer/ui/icons';
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

describe('agent tool call block', () => {
  test('uses memory icon and summarizes recall', () => {
    expect(getToolIcon(recallToolCall({ query: 'preferences' }))).toBe(BrainIcon);
    expect(summarizeToolCall(recallToolCall({ query: 'preferences' }), 'pending', labels)).toBe('Recalling memory "preferences"');
    expect(summarizeToolCall(recallToolCall({ query: 'preferences' }), 'done', labels)).toBe('Recalled memory "preferences"');
    expect(summarizeToolCall(recallToolCall({ query: 'preferences' }), 'error', labels)).toBe('Failed to recall memory "preferences"');
  });

  test('uses memory icon and summarizes Dream', () => {
    expect(getToolIcon(dreamToolCall({ reason: 'test Dream' }))).toBe(BrainIcon);
    expect(summarizeToolCall(dreamToolCall({ reason: 'test Dream' }), 'pending', labels)).toBe('Dreaming memory "test Dream"');
    expect(summarizeToolCall(dreamToolCall({ reason: 'test Dream' }), 'done', labels)).toBe('Dreamed memory "test Dream"');
    expect(summarizeToolCall(dreamToolCall({ reason: 'test Dream' }), 'error', labels)).toBe('Failed to dream memory "test Dream"');
  });
});
