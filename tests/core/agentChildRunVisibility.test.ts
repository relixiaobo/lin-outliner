import { describe, expect, mock, test } from 'bun:test';

// agentDelegation transitively imports modules that reach electron; mock it so the
// pure projection under test can be imported in the bun runtime.
mock.module('electron', () => ({
  app: { getPath: () => '/tmp/lin-child run-visibility-test' },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  session: {
    fromPartition: () => ({ clearStorageData: async () => undefined }),
  },
}));

const { visibleChildRunResult, delegateToolResult } = await import('../../src/main/agentDelegation');
type AgentDelegateToolData = import('../../src/main/agentDelegation').AgentDelegateToolData;

function visibleEnvelope(result: ReturnType<typeof delegateToolResult>): Record<string, unknown> {
  const block = result.content[0];
  if (!block || block.type !== 'text') throw new Error('Expected text content');
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe('child run model-visible projection', () => {
  test('keeps lifecycle status, id, result, and instructions; drops echoed launch args and telemetry', () => {
    const data: AgentDelegateToolData = {
      status: 'completed',
      agent_id: 'agent_1',
      name: 'researcher',
      description: 'research isolated',
      prompt: 'Find the answer.',
      agent_type: 'researcher',
      context_mode: 'fresh',
      result: 'The answer is 42.',
      started_at: 1000,
      updated_at: 2000,
      completed_at: 2000,
      transcript_message_count: 7,
    };

    expect(visibleChildRunResult(data)).toEqual({
      status: 'completed',
      agent_id: 'agent_1',
      name: 'researcher',
      result: 'The answer is 42.',
    });
  });

  test('surfaces error and keeps instructions out of the data projection', () => {
    const data: AgentDelegateToolData = {
      status: 'failed',
      agent_id: 'agent_2',
      description: 'background work',
      prompt: 'Run in background.',
      agent_type: 'general',
      context_mode: 'fresh',
      error: 'boom',
      started_at: 1000,
      updated_at: 1000,
      transcript_message_count: 0,
      instructions: 'Retry with a narrower task.',
    };

    expect(visibleChildRunResult(data)).toEqual({
      status: 'failed',
      agent_id: 'agent_2',
      error: 'boom',
    });
  });

  test('delegateToolResult lifts instructions to the envelope, not the data payload', () => {
    const data: AgentDelegateToolData = {
      status: 'async_launched',
      agent_id: 'agent_3',
      description: 'background work',
      prompt: 'Run in background.',
      agent_type: 'general',
      context_mode: 'fresh',
      started_at: 1000,
      updated_at: 1000,
      transcript_message_count: 0,
      instructions: 'The agent is running in the background. Tenon will notify you when it finishes.',
    };

    const result = delegateToolResult('Agent', data);
    const visible = visibleEnvelope(result);

    expect(visible.instructions).toBe('The agent is running in the background. Tenon will notify you when it finishes.');
    expect((visible.data as Record<string, unknown>).instructions).toBeUndefined();
    expect(visible.data).toEqual({ status: 'async_launched', agent_id: 'agent_3' });
    // The full record still carries instructions on the envelope details.
    expect(result.details.instructions).toBe('The agent is running in the background. Tenon will notify you when it finishes.');
  });

  test('delegateToolResult omits the instructions field when the run has none', () => {
    const data: AgentDelegateToolData = {
      status: 'completed',
      agent_id: 'agent_4',
      description: 'done',
      prompt: 'Do it.',
      agent_type: 'general',
      context_mode: 'fresh',
      result: 'done',
      started_at: 1000,
      updated_at: 2000,
      completed_at: 2000,
      transcript_message_count: 1,
    };

    const visible = visibleEnvelope(delegateToolResult('Agent', data));
    expect(visible.instructions).toBeUndefined();
    expect(visible.data).toEqual({ status: 'completed', agent_id: 'agent_4', result: 'done' });
  });
});
