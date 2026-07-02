import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, ToolCall } from '../../src/core/agentTypes';
import type { AgentRenderRunEntity } from '../../src/core/agentRenderProjection';
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

function run(id = 'run-1'): AgentRenderRunEntity {
  return {
    agentId: 'built-in:test:neva',
    anchor: { type: 'conversation', agentId: 'built-in:test:neva', conversationId: 'conversation-a' },
    context: 'full',
    conversationId: 'conversation-a',
    id,
    runProfile: 'default',
    runProfileLabel: 'Default',
    startedAt: 0,
    status: 'running',
    title: 'Sub-run',
    updatedAt: 0,
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
        streaming: false,
        text: 'Final answer',
        type: 'agentMessage',
      },
    ]);
  });

  test('adds a work divider for a direct text answer when run timing is known', () => {
    const turn = project(assistant([{ type: 'text', text: 'Final answer' }]), {
      workedForMs: 3_000,
    });

    expect(turn.finalMessages.map((item) => item.text)).toEqual(['Final answer']);
    expect(turn.process).toMatchObject({
      items: [],
      showWorkDivider: true,
      stopped: false,
      workedForMs: 3_000,
    });
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
    expect(turn.process?.showSummaryRow).toBe(false);
    expect(turn.process?.showWorkDivider).toBe(true);
    expect(turn.process?.workedForMs).toBe(3_000);
    expect(turn.process?.items.map((item) => item.type)).toEqual(['reasoning', 'toolCall']);
    expect(turn.process?.items.map((item) => item.id)).toEqual([
      'process:message-a:reasoning:0',
      'tool:tool-a',
    ]);
    expect(turn.process?.items[1]).toMatchObject({ outcome: 'completed' });
  });

  test('keeps a static summary row when a completed process has no run timing', () => {
    const turn = project(assistant([
      { type: 'thinking', thinking: 'Inspect the outline' },
      toolCall('tool-a'),
      { type: 'text', text: 'Done.' },
    ]), {
      toolCallOutcomes: new Map([['tool-a', 'completed']]),
    });

    expect(turn.finalMessages.map((item) => item.text)).toEqual(['Done.']);
    expect(turn.process).toMatchObject({
      answerStarted: true,
      showSummaryRow: true,
      showWorkDivider: false,
      workedForMs: null,
    });
  });

  test('keeps interim narration inside the process before the final answer', () => {
    const turn = project(assistant([
      { type: 'text', text: 'I will check first.' },
      toolCall('tool-a'),
      { type: 'text', text: 'The answer.' },
    ]));

    expect(turn.process?.items.map((item) => item.type)).toEqual(['agentMessage', 'toolCall']);
    expect(turn.process?.items[0]).toMatchObject({
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
      showSummaryRow: false,
      showWorkDivider: true,
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
      showSummaryRow: true,
      showWorkDivider: false,
      stopped: false,
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

  test('projects a stopped turn as a work divider instead of an interrupted process', () => {
    const turn = project(assistant([
      { type: 'thinking', thinking: 'Still checking' },
    ], {
      stopReason: 'aborted',
    }), {
      turnInterrupted: true,
      workedForMs: 7_000,
    });

    expect(turn.process).toMatchObject({
      showSummaryRow: false,
      showWorkDivider: true,
      stopped: true,
      surfaceResultlessProcess: false,
      turnFailedWithoutProse: false,
      workedForMs: 7_000,
    });
  });

  test('keeps channel child-run spawn tool calls in the inline process', () => {
    const turn = project(assistant([
      toolCall('child-tool'),
      { type: 'text', text: 'Follow-up answer' },
    ]), {
      subRunsByParentToolCallId: new Map([['child-tool', run()]]),
      isChannel: true,
    });

    expect(turn.process?.items.map((item) => item.type)).toEqual(['toolCall']);
    expect(turn.process?.items[0]).toMatchObject({
      id: 'tool:child-tool',
      subRun: run(),
      type: 'toolCall',
    });
    expect(turn.finalMessages.map((item) => item.text)).toEqual(['Follow-up answer']);
  });
});
