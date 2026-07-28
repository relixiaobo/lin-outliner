import { describe, expect, test } from 'bun:test';
import type { Api, AssistantMessage, Message, Model, ToolResultMessage } from '@earendil-works/pi-ai';
import {
  ContextCapacityError,
  ContextCompactionRequiredError,
  planContextBudget,
} from '../../src/main/agent/context/ContextBudgetPlanner';

const model = {
  id: 'budget-test',
  name: 'Budget Test',
  api: 'openai-responses',
  provider: 'openai',
  baseUrl: 'https://example.test',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 2_000,
  maxTokens: 200,
} as Model<Api>;

describe('context budget planner', () => {
  test('returns the original append-only context when it fits', () => {
    const messages = [user('first'), assistantText('answer'), user('current')];
    const plan = planContextBudget({
      model,
      systemPrompt: 'Stable prompt',
      tools: [],
      messages,
      protectedFromMessageIndex: 2,
    });

    expect(plan.messages).toBe(messages);
    expect(plan.estimatedInputTokens).toBeLessThanOrEqual(plan.inputTokenLimit);
    expect(plan.reservedOutputTokens).toBe(200);
  });

  test('requires canonical compaction instead of silently dropping old messages', () => {
    const messages = [
      user('a'.repeat(3_000)),
      user('b'.repeat(3_000)),
      user('current'),
    ];

    expect(() => planContextBudget({
      model,
      systemPrompt: 'Stable prompt',
      tools: [],
      messages,
      protectedFromMessageIndex: 2,
    })).toThrow(ContextCompactionRequiredError);
    try {
      planContextBudget({
        model,
        systemPrompt: 'Stable prompt',
        tools: [],
        messages,
        protectedFromMessageIndex: 2,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ContextCompactionRequiredError);
      expect((error as ContextCompactionRequiredError).retainFromMessageIndex).toBe(1);
    }
  });

  test('never selects a partial assistant tool-call/result unit', () => {
    const messages: Message[] = [
      user('old'.repeat(600)),
      assistantToolCall('call-1'),
      toolResult('call-1', 'result'.repeat(1_000)),
      user('current'),
    ];

    try {
      planContextBudget({
        model,
        systemPrompt: 'Stable prompt',
        tools: [],
        messages,
        protectedFromMessageIndex: 3,
      });
      throw new Error('Expected compaction to be required.');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextCompactionRequiredError);
      expect((error as ContextCompactionRequiredError).retainFromMessageIndex).toBe(3);
    }
  });

  test('fails explicitly when mandatory active input cannot fit', () => {
    expect(() => planContextBudget({
      model,
      systemPrompt: 'Stable prompt',
      tools: [],
      messages: [user('x'.repeat(10_000))],
      protectedFromMessageIndex: 0,
    })).toThrow(ContextCapacityError);
  });

  test('rejects orphaned and incomplete tool history', () => {
    expect(() => planContextBudget({
      model,
      systemPrompt: '',
      tools: [],
      messages: [toolResult('orphan', 'result')],
      protectedFromMessageIndex: 0,
    })).toThrow('orphaned tool result');
    expect(() => planContextBudget({
      model,
      systemPrompt: '',
      tools: [],
      messages: [assistantToolCall('missing')],
      protectedFromMessageIndex: 0,
    })).toThrow('incomplete tool exchange');
  });
});

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 };
}

function assistantText(text: string): AssistantMessage {
  return assistant([{ type: 'text', text }], 'stop');
}

function assistantToolCall(id: string): AssistantMessage {
  return assistant([{ type: 'toolCall', id, name: 'file_read', arguments: { path: '/tmp/a' } }], 'toolUse');
}

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'openai',
    model: 'budget-test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1,
  };
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'file_read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 1,
  };
}
