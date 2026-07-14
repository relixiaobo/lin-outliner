import { describe, expect, test } from 'bun:test';
import type { AgentRunDetailPayload, AssistantMessage, ToolResultMessage, Usage } from '../../src/core/agentTypes';
import {
  agentRunDetailToTranscriptRun,
  agentRunTranscriptHasActiveAssistantTurn,
  buildAgentRunToolResultMap,
  collectPendingAgentRunToolCallIds,
  parseAgentRunTranscript,
} from '../../src/renderer/ui/agent/agentRunTranscriptAdapter';

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function runDetail(patch: Partial<AgentRunDetailPayload> = {}): AgentRunDetailPayload {
  return {
    runId: 'run-1',
    conversationId: 'conversation-1',
    agentId: 'neva',
    title: 'Weather query',
    status: 'completed',
    runProfile: 'background',
    runProfileLabel: 'Background',
    context: 'issue',
    disposition: 'background',
    startedAt: 100,
    updatedAt: 350,
    completedAt: 350,
    ancestors: [],
    subRuns: [],
    verificationRuns: [],
    transcriptMessageCount: 3,
    ...patch,
  };
}

function assistant(content: AssistantMessage['content'], timestamp: number, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: EMPTY_USAGE,
    stopReason,
    timestamp,
  };
}

function toolResult(toolCallId: string, timestamp: number): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'weather_lookup',
    content: [{ type: 'text', text: 'Weather: sunny.' }],
    isError: false,
    timestamp,
  };
}

describe('agent run transcript adapter', () => {
  test('derives renderer facts from run transcript and run detail', () => {
    const messages = parseAgentRunTranscript([
      assistant([
        { type: 'thinking', text: 'Need current district weather.' },
        {
          type: 'toolCall',
          id: 'tool-1',
          name: 'weather_lookup',
          arguments: { city: 'Wuxi' },
        },
      ], 110),
      toolResult('tool-1', 120),
      assistant([{ type: 'text', text: 'Final weather summary.' }], 340),
      { role: 'unknown' },
    ]);

    const run = agentRunDetailToTranscriptRun(runDetail());
    const toolResults = buildAgentRunToolResultMap(messages);
    const pending = collectPendingAgentRunToolCallIds(messages, false);

    expect(messages).toHaveLength(3);
    expect(run.completedAt! - run.startedAt).toBe(250);
    expect(toolResults.get('tool-1')?.content[0]).toEqual({ type: 'text', text: 'Weather: sunny.' });
    expect(pending.size).toBe(0);
    expect(agentRunTranscriptHasActiveAssistantTurn(messages, false, pending)).toBe(false);
  });

  test('keeps a running assistant turn active while a tool result is pending', () => {
    const messages = parseAgentRunTranscript([
      assistant([
        {
          type: 'toolCall',
          id: 'tool-1',
          name: 'weather_lookup',
          arguments: { city: 'Wuxi' },
        },
      ], 110, null),
    ]);

    const pending = collectPendingAgentRunToolCallIds(messages, true);

    expect([...pending]).toEqual(['tool-1']);
    expect(agentRunTranscriptHasActiveAssistantTurn(messages, true, pending)).toBe(true);
  });
});
