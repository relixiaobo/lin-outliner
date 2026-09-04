import { describe, expect, test } from 'bun:test';
import Type from 'typebox';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Usage,
} from '@earendil-works/pi-ai';
import { MODEL_TOOL_CATALOG } from '../../src/core/agent/tools';
import { InternalDelegateRunner } from '../../src/delegate/runners/internal';
import type {
  ModelGateway,
  ModelGatewayRequest,
} from '../../src/main/agent/runtime/kernel/ModelGateway';
import type {
  AgentTool,
  Api,
  Message,
} from '../../src/main/agent/runtime/kernel/types';

const USAGE: Usage = {
  input: 3,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 8,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};

const MODEL: Model<Api> = {
  id: 'delegate-test',
  name: 'Delegate Test',
  provider: 'test',
  api: 'openai-completions',
  baseUrl: '',
  reasoning: true,
  input: ['text'],
  contextWindow: 128_000,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const PROMPT: Message = { role: 'user', content: 'Inspect the task.', timestamp: 1 };

describe('InternalDelegateRunner', () => {
  test('reuses the native kernel with the delegated tool ceiling and brokered credentials', async () => {
    const gateway = new ScriptedGateway([async () => terminalStream(assistant('Complete.'))]);
    const runner = new InternalDelegateRunner();
    const result = await runner.run(runInput(gateway, {
      tools: [tool('file_read'), tool('task_status')],
      providerOptions: { apiKey: 'must-not-pass' } as never,
      getApiKey: async () => 'brokered-key',
    }));

    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.context.tools.map((entry) => entry.name)).toEqual(['file_read']);
    expect(gateway.requests[0]?.options.apiKey).toBe('brokered-key');
    expect(result).toMatchObject({
      outcome: 'succeeded',
      text: 'Complete.',
      error: null,
      partialEvidence: false,
      usage: { state: 'known', inputTokens: 3, outputTokens: 5, costUsd: 0.03 },
    });
  });

  test('removes provider options credentials when the Host broker has no key', async () => {
    const gateway = new ScriptedGateway([async () => terminalStream(assistant('Complete.'))]);
    const runner = new InternalDelegateRunner();
    await runner.run(runInput(gateway, {
      providerOptions: { apiKey: 'must-not-pass' } as never,
      getApiKey: async () => undefined,
    }));

    expect(gateway.requests[0]?.options.apiKey).toBeUndefined();
  });

  test('denies background Bash before its implementation executes', async () => {
    let executions = 0;
    const bash: AgentTool = {
      name: 'bash',
      label: 'Bash',
      description: 'Run a shell command.',
      parameters: Type.Object({
        command: Type.String(),
        run_in_background: Type.Boolean(),
      }, { additionalProperties: false }),
      execute: async () => {
        executions += 1;
        return { kind: 'tenon', outcome: { ok: true }, content: [], details: {} };
      },
    };
    const gateway = new ScriptedGateway([
      async () => terminalStream(assistantToolCall('bash', {
        command: 'printf delegated',
        run_in_background: true,
      })),
      async () => terminalStream(assistant('Stayed foreground.')),
    ]);
    const runner = new InternalDelegateRunner();
    const result = await runner.run(runInput(gateway, { tools: [bash] }));

    expect(executions).toBe(0);
    expect(gateway.requests).toHaveLength(2);
    expect(result.outcome).toBe('succeeded');
    expect(result.messages.some((message) => message.role === 'toolResult'
      && message.content.some((part) => part.type === 'text'
        && part.text.includes('delegation_tool_unavailable')))).toBe(true);
  });

  test('preserves a root capability block inside the delegated runtime', async () => {
    let executions = 0;
    const fetch: AgentTool = {
      ...tool('web_fetch', () => { executions += 1; }),
      parameters: Type.Object({ url: Type.String() }, { additionalProperties: false }),
    };
    const gateway = new ScriptedGateway([
      async () => terminalStream(assistantToolCall('web_fetch', { url: 'https://example.test' })),
      async () => terminalStream(assistant('Reported the refusal.')),
    ]);
    const runner = new InternalDelegateRunner();
    const result = await runner.run(runInput(gateway, {
      tools: [fetch],
      capabilityConfig: { blocks: ['Action(web.fetch)'] },
    }));

    expect(executions).toBe(0);
    expect(result.messages.some((message) => message.role === 'toolResult'
      && message.content.some((part) => part.type === 'text'
        && part.text.includes('delegation_tool_unavailable')))).toBe(true);
  });

  test('accepts steering only while the Session is active and delivers it at a kernel boundary', async () => {
    let releaseFirst: ((stream: AssistantMessageEventStream) => void) | undefined;
    const first = new Promise<AssistantMessageEventStream>((resolve) => { releaseFirst = resolve; });
    const gateway = new ScriptedGateway([
      async () => await first,
      async () => terminalStream(assistant('Updated result.')),
    ]);
    const runner = new InternalDelegateRunner();
    let delivered = 0;
    const running = runner.run(runInput(gateway));
    await waitUntil(() => gateway.requests.length === 1);

    expect(runner.isActive('session-one')).toBe(true);
    expect(runner.send(
      'session-one',
      { role: 'user', content: 'Include the newly reported race.', timestamp: 2 },
      () => { delivered += 1; },
    )).toBe(true);
    releaseFirst?.(terminalStream(assistant('Initial result.')));
    const result = await running;

    expect(delivered).toBe(1);
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[1]?.context.messages).toContainEqual({
      role: 'user',
      content: 'Include the newly reported race.',
      timestamp: 2,
    });
    expect(result.text).toBe('Updated result.');
    expect(runner.isActive('session-one')).toBe(false);
    expect(runner.send('session-one', PROMPT)).toBe(false);
  });

  test('rejects a second active execution for the same Session', async () => {
    let releaseFirst: ((stream: AssistantMessageEventStream) => void) | undefined;
    const first = new Promise<AssistantMessageEventStream>((resolve) => { releaseFirst = resolve; });
    const gateway = new ScriptedGateway([async () => await first]);
    const runner = new InternalDelegateRunner();
    const running = runner.run(runInput(gateway));
    await waitUntil(() => gateway.requests.length === 1);

    await expect(runner.run(runInput(new ScriptedGateway([]))))
      .rejects.toThrow('Session is already active');
    releaseFirst?.(terminalStream(assistant('Complete.')));
    await running;
  });

  test('propagates a Session stop into the active provider request', async () => {
    const gateway = new ScriptedGateway([async (request) => {
      const stream = createAssistantMessageEventStream();
      request.options.signal?.addEventListener('abort', () => {
        const cancelled = { ...assistant(''), stopReason: 'aborted' as const, errorMessage: 'Stopped.' };
        stream.push({ type: 'error', reason: 'aborted', error: cancelled });
        stream.end(cancelled);
      }, { once: true });
      return stream;
    }]);
    const runner = new InternalDelegateRunner();
    const running = runner.run(runInput(gateway));
    await waitUntil(() => gateway.requests.length === 1);

    expect(runner.stop('session-one')).toBe(true);
    expect(await running).toMatchObject({
      outcome: 'cancelled',
      error: expect.stringContaining('aborted'),
    });
    expect(runner.stop('session-one')).toBe(false);
  });
});

class ScriptedGateway implements ModelGateway {
  readonly requests: ModelGatewayRequest[] = [];

  constructor(private readonly scripts: Array<(
    request: ModelGatewayRequest,
  ) => Promise<AssistantMessageEventStream>>) {}

  async stream(request: ModelGatewayRequest): Promise<AssistantMessageEventStream> {
    this.requests.push(request);
    const script = this.scripts.shift();
    if (!script) throw new Error('No scripted Delegate response remains.');
    return await script(request);
  }
}

function runInput(
  gateway: ModelGateway,
  overrides: Partial<Parameters<InternalDelegateRunner['run']>[0]> = {},
): Parameters<InternalDelegateRunner['run']>[0] {
  return {
    sessionId: 'session-one',
    systemPrompt: 'Complete only the delegated task.',
    model: MODEL,
    thinkingLevel: 'medium',
    history: [],
    prompt: PROMPT,
    tools: [],
    toolRegistry: MODEL_TOOL_CATALOG,
    toolPolicy: { profile: 'general', access: 'workspace-write' },
    workspaceRoot: process.cwd(),
    gateway,
    getApiKey: async () => undefined,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function tool(name: string, onExecute?: () => void): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      onExecute?.();
      return { kind: 'tenon', outcome: { ok: true }, content: [], details: {} };
    },
  };
}

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: USAGE,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function assistantToolCall(name: string, args: Record<string, unknown>): AssistantMessage {
  return {
    ...assistant(''),
    content: [{ type: 'toolCall', id: `${name}-call`, name, arguments: args }],
    stopReason: 'toolUse',
  };
}

function terminalStream(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: 'done', reason: message.stopReason, message });
    stream.end(message);
  });
  return stream;
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for Internal Delegate Runner state.');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
