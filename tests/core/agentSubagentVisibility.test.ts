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

const { visibleSubagentResult } = await import('../../src/main/agentSubagents');
type AgentSubagentToolData = import('../../src/main/agentSubagents').AgentSubagentToolData;

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

  test('surfaces error and next-step instructions when present', () => {
    const data: AgentSubagentToolData = {
      status: 'async_launched',
      agent_id: 'agent_2',
      description: 'background work',
      prompt: 'Run in background.',
      subagent_type: 'general',
      context_mode: 'fresh',
      started_at: 1000,
      updated_at: 1000,
      transcript_message_count: 0,
      instructions: 'The agent is running in the background. Lin will notify you when it finishes.',
    };

    expect(visibleSubagentResult(data)).toEqual({
      status: 'async_launched',
      agent_id: 'agent_2',
      instructions: 'The agent is running in the background. Lin will notify you when it finishes.',
    });
  });
});
