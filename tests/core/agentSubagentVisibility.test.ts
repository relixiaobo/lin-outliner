import { describe, expect, mock, test } from 'bun:test';

// agentSubagents transitively imports modules that reach electron; mock it so the
// pure projection under test can be imported in the bun runtime.
mock.module('electron', () => ({
  app: { getPath: () => '/tmp/lin-subagent-visibility-test' },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  session: {
    fromPartition: () => ({ clearStorageData: async () => undefined }),
  },
}));

const { visibleSubagentResult, subagentToolResult } = await import('../../src/main/agentSubagents');
type AgentSubagentToolData = import('../../src/main/agentSubagents').AgentSubagentToolData;

function visibleEnvelope(result: ReturnType<typeof subagentToolResult>): Record<string, unknown> {
  const block = result.content[0];
  if (!block || block.type !== 'text') throw new Error('Expected text content');
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe('subagent model-visible projection', () => {
  test('keeps lifecycle status, id, result, and instructions; drops echoed launch args and telemetry', () => {
    const data: AgentSubagentToolData = {
      status: 'completed',
      agent_id: 'agent_1',
      name: 'researcher',
      description: 'research isolated',
      prompt: 'Find the answer.',
      subagent_type: 'researcher',
      context_mode: 'fresh',
      result: 'The answer is 42.',
      started_at: 1000,
      updated_at: 2000,
      completed_at: 2000,
      transcript_message_count: 7,
    };

    expect(visibleSubagentResult(data)).toEqual({
      status: 'completed',
      agent_id: 'agent_1',
      name: 'researcher',
      result: 'The answer is 42.',
    });
  });

  test('surfaces error and keeps instructions out of the data projection', () => {
    const data: AgentSubagentToolData = {
      status: 'failed',
      agent_id: 'agent_2',
      description: 'background work',
      prompt: 'Run in background.',
      subagent_type: 'general',
      context_mode: 'fresh',
      error: 'boom',
      started_at: 1000,
      updated_at: 1000,
      transcript_message_count: 0,
      instructions: 'Retry with a narrower task.',
    };

    expect(visibleSubagentResult(data)).toEqual({
      status: 'failed',
      agent_id: 'agent_2',
      error: 'boom',
    });
  });

  test('subagentToolResult lifts instructions to the envelope, not the data payload', () => {
    const data: AgentSubagentToolData = {
      status: 'async_launched',
      agent_id: 'agent_3',
      description: 'background work',
      prompt: 'Run in background.',
      subagent_type: 'general',
      context_mode: 'fresh',
      started_at: 1000,
      updated_at: 1000,
      transcript_message_count: 0,
      instructions: 'The agent is running in the background. Tenon will notify you when it finishes.',
    };

    const result = subagentToolResult('Agent', data);
    const visible = visibleEnvelope(result);

    expect(visible.instructions).toBe('The agent is running in the background. Tenon will notify you when it finishes.');
    expect((visible.data as Record<string, unknown>).instructions).toBeUndefined();
    expect(visible.data).toEqual({ status: 'async_launched', agent_id: 'agent_3' });
    // The full record still carries instructions on the envelope details.
    expect(result.details.instructions).toBe('The agent is running in the background. Tenon will notify you when it finishes.');
  });

  test('subagentToolResult omits the instructions field when the run has none', () => {
    const data: AgentSubagentToolData = {
      status: 'completed',
      agent_id: 'agent_4',
      description: 'done',
      prompt: 'Do it.',
      subagent_type: 'general',
      context_mode: 'fresh',
      result: 'done',
      started_at: 1000,
      updated_at: 2000,
      completed_at: 2000,
      transcript_message_count: 1,
    };

    const visible = visibleEnvelope(subagentToolResult('Agent', data));
    expect(visible.instructions).toBeUndefined();
    expect(visible.data).toEqual({ status: 'completed', agent_id: 'agent_4', result: 'done' });
  });
});
