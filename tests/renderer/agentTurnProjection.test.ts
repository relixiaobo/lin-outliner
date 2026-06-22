import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, ToolCall } from '../../src/core/agentTypes';
import { projectAssistantTurn } from '../../src/renderer/ui/agent/agentTurnProjection';

function assistant(content: AssistantMessage['content'], extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    content,
    role: 'assistant',
    timestamp: 0,
    ...extra,
  };
}

function toolCall(id = 'tool-a'): ToolCall {
  return {
    arguments: { query: 'alpha' },
    id,
    name: 'web_search',
    type: 'toolCall',
  };
}

function project(message: AssistantMessage, overrides: Partial<Parameters<typeof projectAssistantTurn>[0]> = {}) {
  return projectAssistantTurn({
    contentKey: 'message-a',
    isChannel: false,
    message,
    runStartedAtMs: null,
    streaming: false,
    turnActive: false,
    turnInterrupted: false,
    workedForMs: null,
    ...overrides,
  });
}

describe('projectAssistantTurn', () => {
  test('renders a direct text answer without a process projection', () => {
    const turn = project(assistant([{ type: 'text', text: 'Final answer' }]));

    expect(turn.process).toBeNull();
    expect(turn.finalMessages).toEqual([
      {
        id: 'process:message-a:final:0',
        phase: 'final',
        sourceIndex: 0,
        streaming: false,
        text: 'Final answer',
        type: 'agentMessage',
      },
    ]);
  });

  test('partitions process items from trailing final answer prose', () => {
    const turn = project(assistant([
      { type: 'thinking', thinking: 'Inspect the outline' },
      toolCall('tool-a'),
      { type: 'text', text: 'Done.' },
    ]), {
      toolCallOutcomes: new Map([['tool-a', 'completed']]),
      workedForMs: 3_000,
    });

    expect(turn.finalMessages.map((item) => item.text)).toEqual(['Done.']);
    expect(turn.process?.answerStarted).toBe(true);
    expect(turn.process?.sealed).toBe(true);
    expect(turn.process?.workedForMs).toBe(3_000);
    expect(turn.process?.items.map((item) => item.type)).toEqual(['reasoning', 'toolCall']);
    expect(turn.process?.items.map((item) => item.id)).toEqual([
      'process:message-a:reasoning:0',
      'tool:tool-a',
    ]);
    expect(turn.process?.items[1]).toMatchObject({ outcome: 'completed' });
  });

  test('keeps interim narration inside the process before the final answer', () => {
    const turn = project(assistant([
      { type: 'text', text: 'I will check first.' },
      toolCall('tool-a'),
      { type: 'text', text: 'The answer.' },
    ]));

    expect(turn.process?.items.map((item) => item.type)).toEqual(['agentMessage', 'toolCall']);
    expect(turn.process?.items[0]).toMatchObject({
      phase: 'process',
      sourceIndex: 0,
      text: 'I will check first.',
      type: 'agentMessage',
    });
    expect(turn.finalMessages.map((item) => item.text)).toEqual(['The answer.']);
  });

  test('creates an empty process projection for an active tool-free turn', () => {
    const turn = project(assistant([{ type: 'text', text: 'Streaming answer' }]), {
      runStartedAtMs: 10,
      streaming: true,
      turnActive: true,
    });

    expect(turn.process).toMatchObject({
      answerStarted: true,
      id: 'process:message-a',
      items: [],
      liveStartedAtMs: 10,
      sealed: false,
    });
    expect(turn.finalMessages[0]).toMatchObject({
      streaming: true,
      text: 'Streaming answer',
    });
  });

  test('surfaces a sealed resultless non-channel process without marking it interrupted', () => {
    const turn = project(assistant([toolCall('tool-a')]), {
      workedForMs: 5_000,
    });

    expect(turn.finalMessages).toEqual([]);
    expect(turn.process).toMatchObject({
      answerStarted: false,
      sealed: false,
      surfaceResultlessProcess: true,
      turnFailedWithoutProse: false,
      workedForMs: 5_000,
    });
  });

  test('marks a settled interrupted resultless process separately from clean resultless work', () => {
    const turn = project(assistant([
      { type: 'thinking', thinking: 'Still checking' },
    ]), {
      turnInterrupted: true,
    });

    expect(turn.process).toMatchObject({
      surfaceResultlessProcess: true,
      turnFailedWithoutProse: true,
    });
  });

  test('drops channel child-run spawn tool calls from the inline process', () => {
    const turn = project(assistant([
      toolCall('child-tool'),
      { type: 'text', text: 'Follow-up answer' },
    ]), {
      childRunsByParentToolCallId: new Map([['child-tool', { id: 'child-run' } as never]]),
      isChannel: true,
    });

    expect(turn.process).toBeNull();
    expect(turn.finalMessages.map((item) => item.text)).toEqual(['Follow-up answer']);
  });
});
