import { describe, expect, test } from 'bun:test';
import type { EffectiveThreadConfiguration } from '../../src/core/agent/configuration';
import type { JsonValue } from '../../src/core/agent/protocol';
import type { ThreadService } from '../../src/main/agent/ThreadService';
import {
  createLocalTools,
  stopBackgroundShellTask,
} from '../../src/main/agent/capabilities/agentLocalTools';
import { ToolRuntime } from '../../src/main/agent/runtime/ToolRuntime';
import type { AgentTool } from '../../src/main/agent/runtime/kernel/types';
import type { TurnExecutionContext } from '../../src/main/agent/runtime/types';

describe('unified task_stop dispatcher', () => {
  test('rejects an ID owned by both an Agent and a shell task', async () => {
    const shellId = await startBackgroundShell();
    const calls: string[] = [];
    const agentResult = {
      message: `Successfully stopped task: ${shellId} (Inspect runtime)`,
      task_id: shellId,
      task_type: 'local_agent',
      command: 'Inspect runtime',
    } as const;
    const tools = await runtimeTools(async (_threadId, _turnId, taskId) => {
      calls.push(taskId);
      return agentResult;
    }, true);

    try {
      await expect(executeTaskStop(tools, { task_id: shellId, shell_id: 'ignored-shell-id' }))
        .rejects.toThrow(`Task ID is ambiguous between an Agent and shell task: ${shellId}`);
      expect(calls).toEqual([]);

      const shell = await stopBackgroundShellTask(shellId);
      expect(shell).toMatchObject({ task_id: shellId, status: 'stopped' });
    } finally {
      await stopBackgroundShellTask(shellId).catch(() => null);
    }
  });

  test('gives task_id precedence over deprecated shell_id', async () => {
    const calls: string[] = [];
    const tools = await runtimeTools(async (_threadId, _turnId, taskId) => {
      calls.push(taskId);
      return {
        message: `Successfully stopped task: ${taskId} (Inspect runtime)`,
        task_id: taskId,
        task_type: 'local_agent',
        command: 'Inspect runtime',
      };
    }, true);

    const result = await executeTaskStop(tools, {
      task_id: 'agent-task-id',
      shell_id: 'ignored-shell-id',
    });
    expect(calls).toEqual(['agent-task-id']);
    expect(result.details).toMatchObject({ task_id: 'agent-task-id', task_type: 'local_agent' });
  });

  test('falls back to the shell owner and returns the canonical stop fields', async () => {
    const shellId = await startBackgroundShell();
    const calls: string[] = [];
    const tools = await runtimeTools(async (_threadId, _turnId, taskId) => {
      calls.push(taskId);
      return null;
    });

    const result = await executeTaskStop(tools, { task_id: shellId });
    expect(calls).toEqual([shellId]);
    expect(result.details).toMatchObject({
      ok: true,
      tool: 'task_stop',
      data: {
        message: expect.stringContaining(`Successfully stopped task: ${shellId}`),
        task_id: shellId,
        task_type: 'bash',
        command: 'sleep 30',
      },
    });
    expect(result.details).toHaveProperty('capabilityAudit');
  });

  test('uses shell_id only when task_id is absent', async () => {
    const shellId = await startBackgroundShell();
    const calls: string[] = [];
    const tools = await runtimeTools(async (_threadId, _turnId, taskId) => {
      calls.push(taskId);
      return null;
    });

    const result = await executeTaskStop(tools, { shell_id: shellId });
    expect(calls).toEqual([shellId]);
    expect(result.details).toMatchObject({
      ok: true,
      data: { task_id: shellId, task_type: 'bash' },
    });
  });

  test('uses a non-empty trimmed ID and does not let an empty task_id mask shell_id', async () => {
    const shellId = await startBackgroundShell();
    const tools = await runtimeTools(async () => null);

    const result = await executeTaskStop(tools, { task_id: '   ', shell_id: `  ${shellId}  ` });
    expect(result.details).toMatchObject({
      ok: true,
      data: { task_id: shellId, task_type: 'bash' },
    });
  });

  test('preserves exact validation, missing-task, and terminal-state errors', async () => {
    const tools = await runtimeTools(async () => null);
    await expect(executeTaskStop(tools, {})).rejects.toThrow('Missing required parameter: task_id');
    await expect(executeTaskStop(tools, { task_id: 'missing-task' }))
      .rejects.toThrow('No task found with ID: missing-task');

    const shellId = await startBackgroundShell();
    await stopBackgroundShellTask(shellId, CONTEXT.thread.id);
    const terminal = await executeTaskStop(tools, { task_id: shellId });
    expect(terminal.details).toMatchObject({
      ok: false,
      error: {
        code: 'task_not_running',
        recoverable: true,
      },
    });
    expect(terminal.content).toEqual([expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('task_not_running'),
    })]);
  });

  test('does not expose or stop a background shell owned by another Thread', async () => {
    const shellId = await startBackgroundShell('00000000-0000-7000-8000-000000000099');
    const tools = await runtimeTools(async () => null);

    await expect(executeTaskStop(tools, { task_id: shellId }))
      .rejects.toThrow(`No task found with ID: ${shellId}`);
    expect(await stopBackgroundShellTask(shellId, '00000000-0000-7000-8000-000000000099'))
      .toMatchObject({ task_id: shellId, status: 'stopped' });
  });

  test('does not fall through to shell when an Agent finishes during stop', async () => {
    const agentId = 'terminal-agent-id';
    const tools = await runtimeTools(async (_threadId, _turnId, taskId) => {
      throw new Error(`Task ${taskId} is not running (status: completed)`);
    }, true);

    await expect(executeTaskStop(tools, { task_id: agentId }))
      .rejects.toThrow(`Task ${agentId} is not running (status: completed)`);
  });

  test('exposes one canonical task_stop and no bash_stop alias', async () => {
    const tools = await runtimeTools(async () => null);
    expect(tools.filter((tool) => tool.name === 'task_stop')).toHaveLength(1);
    expect(tools.some((tool) => tool.name === 'bash_stop')).toBe(false);
  });
});

const CONFIGURATION: EffectiveThreadConfiguration = {
  profileName: 'task-stop-test',
  developerInstructions: [],
  model: 'test-model',
  reasoningEffort: 'medium',
  tools: ['task_stop'],
  skills: [],
  preloadedSkills: [],
  plugins: [],
  mcpServers: [],
};

const CONTEXT = {
  thread: {
    id: '00000000-0000-7000-8000-000000000001',
    parentThreadId: null,
    cwd: process.cwd(),
  },
  turn: { id: '00000000-0000-7000-8000-000000000002' },
  configuration: CONFIGURATION,
} as unknown as TurnExecutionContext;

async function runtimeTools(
  stopAgentTask: (threadId: string, turnId: string, taskId: string) => Promise<JsonValue | null>,
  agentOwnsTask = false,
): Promise<readonly AgentTool[]> {
  const service = {
    collaborationToolContributions: async () => [],
    extensionToolContributions: async () => [],
    notifyToolStarted: async () => undefined,
    notifyToolCompleted: async () => undefined,
    hasAgentTask: () => agentOwnsTask,
    stopAgentTask,
  } as unknown as ThreadService;
  return new ToolRuntime(service, {
    capabilityTools: () => [],
    capabilityConfig: { blocks: [] },
  }).createTools(CONTEXT);
}

async function executeTaskStop(tools: readonly AgentTool[], params: unknown) {
  const tool = tools.find((candidate) => candidate.name === 'task_stop');
  if (!tool) throw new Error('task_stop was not exposed');
  return tool.execute('task-stop-call', params as never);
}

async function startBackgroundShell(threadId = CONTEXT.thread.id): Promise<string> {
  const bash = createLocalTools({ localRoot: process.cwd(), threadId })
    .find((tool) => tool.name === 'bash');
  if (!bash) throw new Error('bash was not exposed');
  const result = await bash.execute('bash-call', {
    command: 'sleep 30',
    run_in_background: true,
  });
  const details = result.details as {
    readonly data?: { readonly backgroundTaskId?: string };
  };
  const taskId = details.data?.backgroundTaskId;
  if (!taskId) throw new Error('bash did not return a background task ID');
  return taskId;
}
