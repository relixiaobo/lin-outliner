import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Usage,
} from '@earendil-works/pi-ai';
import { NativeAgentRuntime } from '../../src/main/agent/runtime/kernel/NativeAgentRuntime';
import type {
  ModelGateway,
  ModelGatewayRequest,
} from '../../src/main/agent/runtime/kernel/ModelGateway';
import { PiModelGateway } from '../../src/main/agent/runtime/kernel/ModelGateway';
import type {
  AgentEvent,
  AgentTool,
  KernelAgentOptions,
  Message,
} from '../../src/main/agent/runtime/kernel/types';

const GOLDEN = JSON.parse(readFileSync(
  new URL('./fixtures/nativeTurnKernel.golden.json', import.meta.url),
  'utf8',
)) as Record<string, string[]>;

const USAGE: Usage = {
  input: 3,
  output: 5,
  cacheRead: 2,
  cacheWrite: 0,
  totalTokens: 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MODEL: Model<Api> = {
  id: 'kernel-test',
  name: 'Kernel Test',
  provider: 'test',
  api: 'openai-completions',
  baseUrl: '',
  reasoning: true,
  input: ['text'],
  contextWindow: 128_000,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const USER: Message = { role: 'user', content: 'Run it', timestamp: 1 };

class ScriptedGateway implements ModelGateway {
  readonly requests: ModelGatewayRequest[] = [];

  constructor(private readonly scripts: Array<(
    request: ModelGatewayRequest,
  ) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>>) {}

  async stream(request: ModelGatewayRequest): Promise<AssistantMessageEventStream> {
    this.requests.push(request);
    const script = this.scripts.shift();
    if (!script) throw new Error('No scripted model response remains.');
    return await script(request);
  }
}

describe('native turn kernel parity', () => {
  test('orders gateway capture hooks and disables transport-owned retries', async () => {
    const order: string[] = [];
    let maxRetries: number | undefined;
    const message = assistant([]);
    const gateway = new PiModelGateway({
      onProviderContext: () => order.push('context'),
      onPayload: () => {
        order.push('payload');
      },
      onResponse: () => order.push('response'),
      streamSimple: (model, _context, options = {}) => {
        maxRetries = options.maxRetries;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(async () => {
          await options.onPayload?.({ model: model.id }, model);
          await options.onResponse?.({ status: 200, headers: {} }, model);
          stream.push({ type: 'done', reason: 'stop', message });
          stream.end(message);
        });
        return stream;
      },
    });

    const stream = await gateway.stream({
      model: MODEL,
      context: { systemPrompt: 'System', messages: [USER], tools: [] },
      options: { maxRetries: 9 },
    });
    for await (const _event of stream) { /* drain */ }

    expect(order).toEqual(['context', 'payload', 'response']);
    expect(maxRetries).toBe(0);
  });

  test('matches the golden text/thinking cadence and awaits listeners in order', async () => {
    const message = assistant([
      { type: 'thinking', thinking: 'plan' },
      { type: 'text', text: 'done' },
    ]);
    const gateway = new ScriptedGateway([() => deltaStream(message)]);
    const runtime = createRuntime(gateway);
    const events: AgentEvent[] = [];
    const listenerOrder: string[] = [];
    runtime.subscribe(async (event) => {
      await Promise.resolve();
      listenerOrder.push(`first:${event.type}`);
      events.push(event);
    });
    runtime.subscribe((event) => listenerOrder.push(`second:${event.type}`));

    await runtime.prompt(USER);

    expect(events.map(eventLabel)).toEqual(GOLDEN.textThinking);
    expect(listenerOrder.slice(0, 4)).toEqual([
      'first:agent_start',
      'second:agent_start',
      'first:turn_start',
      'second:turn_start',
    ]);
    expect(events.at(-1)?.type).toBe('agent_end');
  });

  test('prepares parallel calls in order, completes out of order, and emits results in source order', async () => {
    let releaseA: ((result: ReturnType<typeof toolResult>) => void) | undefined;
    const toolA = tool('a', undefined, () => new Promise((resolve) => { releaseA = resolve; }));
    const toolB = tool('b', undefined, async () => {
      queueMicrotask(() => releaseA?.(toolResult('A')));
      return toolResult('B');
    });
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([
        { type: 'toolCall', id: 'a', name: 'a', arguments: {} },
        { type: 'toolCall', id: 'b', name: 'b', arguments: {} },
      ], 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'complete' }])),
    ]);
    const runtime = createRuntime(gateway, { tools: [toolA, toolB] });
    const events: AgentEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.prompt(USER);

    expect(events.map(eventLabel)).toEqual(GOLDEN.parallelBatch);
  });

  test('downgrades a mixed batch to sequential and rejects truncated tool calls without execution', async () => {
    const executionOrder: string[] = [];
    const sequential = tool('sequential', 'sequential', async () => {
      executionOrder.push('sequential');
      return toolResult('one');
    });
    const parallel = tool('parallel', undefined, async () => {
      executionOrder.push('parallel');
      return toolResult('two');
    });
    const sequentialGateway = new ScriptedGateway([
      () => terminalStream(assistant([
        { type: 'toolCall', id: 'one', name: 'sequential', arguments: {} },
        { type: 'toolCall', id: 'two', name: 'parallel', arguments: {} },
      ], 'toolUse')),
      () => terminalStream(assistant([])),
    ]);
    const sequentialRuntime = createRuntime(sequentialGateway, { tools: [sequential, parallel] });
    const sequentialEvents: AgentEvent[] = [];
    sequentialRuntime.subscribe((event) => sequentialEvents.push(event));
    await sequentialRuntime.prompt(USER);

    expect(executionOrder).toEqual(['sequential', 'parallel']);
    expect(sequentialEvents.map(eventLabel).filter((label) => label.startsWith('tool_'))).toEqual([
      'tool_execution_start:one',
      'tool_execution_end:one',
      'tool_execution_start:two',
      'tool_execution_end:two',
    ]);

    let truncatedExecuted = false;
    const truncatedGateway = new ScriptedGateway([
      () => terminalStream(assistant([
        { type: 'toolCall', id: 'cut', name: 'cut', arguments: { partial: true } },
      ], 'length')),
      () => terminalStream(assistant([])),
    ]);
    const truncatedRuntime = createRuntime(truncatedGateway, {
      tools: [tool('cut', undefined, async () => {
        truncatedExecuted = true;
        return toolResult('bad');
      })],
    });
    const truncatedEvents: AgentEvent[] = [];
    truncatedRuntime.subscribe((event) => truncatedEvents.push(event));
    await truncatedRuntime.prompt(USER);

    expect(truncatedExecuted).toBe(false);
    const truncatedEnd = truncatedEvents.find((event) => (
      event.type === 'tool_execution_end' && event.toolCallId === 'cut'
    ));
    expect(truncatedEnd).toMatchObject({
      type: 'tool_execution_end',
      isError: true,
      result: { content: [{ text: expect.stringContaining('output token limit') }] },
    });
  });

  test('polls steering before the first call and after an in-flight call only', async () => {
    const controlled = controlledStream();
    const gateway = new ScriptedGateway([
      () => controlled.stream,
      () => terminalStream(assistant([{ type: 'text', text: 'after steer' }])),
    ]);
    const runtime = createRuntime(gateway);
    runtime.steer({ role: 'user', content: 'before', timestamp: 2 });
    const running = runtime.prompt(USER);
    await waitFor(() => gateway.requests.length === 1);
    runtime.steer({ role: 'user', content: 'during', timestamp: 3 });
    await expect(runtime.prompt(USER)).rejects.toThrow(
      'Agent is already processing a prompt. Use steer() to queue messages, or wait for completion.',
    );
    controlled.finish(assistant([{ type: 'text', text: 'first' }]));
    await running;

    expect(gateway.requests[0]?.context.messages.map(messageText)).toEqual(['Run it', 'before']);
    expect(gateway.requests[1]?.context.messages.map(messageText)).toEqual([
      'Run it',
      'before',
      'first',
      'during',
    ]);
  });

  test('settles as interrupted before a second provider call when the Turn budget is exhausted', async () => {
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([
        { type: 'toolCall', id: 'budget-call', name: 'budget-tool', arguments: {} },
      ], 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'must not run' }])),
    ]);
    const runtime = createRuntime(gateway, {
      tools: [tool('budget-tool')],
      remainingTokenBudget: () => 10,
      getTurnTokenUsage: () => gateway.requests.length * USAGE.totalTokens,
    });
    const events: AgentEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.prompt(USER);

    expect(gateway.requests).toHaveLength(1);
    expect(runtime.state.interruptionError).toBe(
      'Token budget exhausted mid-Turn (10 of 10 tokens)',
    );
    expect(events.at(-1)?.type).toBe('agent_end');
  });

  test('delivers one budget warning on the first 80 percent crossing', async () => {
    const notice = '[Budget notice] test';
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([
        { type: 'toolCall', id: 'warning-call-1', name: 'budget-tool', arguments: {} },
      ], 'toolUse')),
      () => terminalStream(assistant([
        { type: 'toolCall', id: 'warning-call-2', name: 'budget-tool', arguments: {} },
      ], 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'complete' }])),
    ]);
    let warnings = 0;
    let runtime!: NativeAgentRuntime;
    runtime = createRuntime(gateway, {
      tools: [tool('budget-tool')],
      remainingTokenBudget: () => 25,
      getTurnTokenUsage: () => 20,
      onBudgetWarning: async () => {
        warnings += 1;
        runtime.steer({ role: 'user', content: notice, timestamp: 3 });
      },
    });

    await runtime.prompt(USER);

    expect(gateway.requests).toHaveLength(3);
    expect(warnings).toBe(1);
    expect(gateway.requests[1]?.context.messages.map(messageText)).toContain(notice);
  });

  test('resolves API keys for every model call and preserves the configured fallback', async () => {
    let keyReads = 0;
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([
        { type: 'toolCall', id: 'key-call', name: 'key-tool', arguments: {} },
      ], 'toolUse')),
      () => terminalStream(assistant([])),
    ]);
    const runtime = createRuntime(gateway, {
      tools: [tool('key-tool')],
      getApiKey: async () => {
        keyReads += 1;
        return keyReads === 1 ? undefined : 'refreshed-key';
      },
      providerOptions: { apiKey: 'configured-key' },
    });

    await runtime.prompt(USER);

    expect(keyReads).toBe(2);
    expect(gateway.requests.map((request) => request.options.apiKey)).toEqual([
      'configured-key',
      'refreshed-key',
    ]);
  });

  test('keeps provider failures as full terminal messages and synthesizes loop exceptions', async () => {
    const providerFailure = assistant([{ type: 'text', text: 'partial' }], 'error', 'upstream failed');
    const failureGateway = new ScriptedGateway([() => errorStream(providerFailure)]);
    const failureRuntime = createRuntime(failureGateway);
    const providerEvents: AgentEvent[] = [];
    failureRuntime.subscribe((event) => providerEvents.push(event));
    await failureRuntime.prompt(USER);

    const terminal = providerEvents.findLast((event) => event.type === 'message_end');
    expect(terminal).toMatchObject({
      type: 'message_end',
      message: {
        content: [{ type: 'text', text: 'partial' }],
        usage: USAGE,
        stopReason: 'error',
        errorMessage: 'upstream failed',
      },
    });
    expect(failureRuntime.state.errorMessage).toBe('upstream failed');

    const throwGateway = new ScriptedGateway([]);
    const throwRuntime = createRuntime(throwGateway, {
      transformContext: async () => { throw new Error('projection failed'); },
    });
    const throwEvents: AgentEvent[] = [];
    throwRuntime.subscribe((event) => throwEvents.push(event));
    await throwRuntime.prompt(USER);

    expect(throwEvents.map(eventLabel)).toEqual(GOLDEN.loopFailure);
    expect(throwRuntime.state.errorMessage).toBe('projection failed');
    expect(throwEvents.at(-1)?.type).toBe('agent_end');
  });

  test('rejects all four deliberate parity-judge mutations', () => {
    const baseline: JudgeTrace = {
      starts: ['a', 'b'],
      results: ['a', 'b'],
      failureTail: ['message_start', 'message_end', 'turn_end', 'agent_end'],
      sequentialMaxActive: 1,
    };
    expect(parityJudge(baseline)).toBe(true);
    expect(parityJudge({ ...baseline, starts: ['b', 'a'] })).toBe(false);
    expect(parityJudge({ ...baseline, results: ['b', 'a'] })).toBe(false);
    expect(parityJudge({ ...baseline, failureTail: ['turn_end', 'agent_end'] })).toBe(false);
    expect(parityJudge({ ...baseline, sequentialMaxActive: 2 })).toBe(false);
  });
});

function createRuntime(
  gateway: ModelGateway,
  overrides: {
    tools?: AgentTool[];
    transformContext?: KernelAgentOptions['transformContext'];
    getApiKey?: KernelAgentOptions['getApiKey'];
    providerOptions?: KernelAgentOptions['providerOptions'];
    remainingTokenBudget?: KernelAgentOptions['remainingTokenBudget'];
    getTurnTokenUsage?: KernelAgentOptions['getTurnTokenUsage'];
    onBudgetWarning?: KernelAgentOptions['onBudgetWarning'];
  } = {},
): NativeAgentRuntime {
  return new NativeAgentRuntime({
    initialState: {
      systemPrompt: 'System',
      model: MODEL,
      thinkingLevel: 'high',
      tools: overrides.tools ?? [],
      messages: [],
    },
    gateway,
    transformContext: overrides.transformContext,
    getApiKey: overrides.getApiKey,
    providerOptions: overrides.providerOptions,
    remainingTokenBudget: overrides.remainingTokenBudget,
    getTurnTokenUsage: overrides.getTurnTokenUsage,
    onBudgetWarning: overrides.onBudgetWarning,
  });
}

function assistant(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
  errorMessage?: string,
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: USAGE,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 10,
  };
}

function terminalStream(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      stream.push({ type: 'error', reason: message.stopReason, error: message });
    } else {
      stream.push({ type: 'done', reason: message.stopReason, message });
    }
    stream.end(message);
  });
  return stream;
}

function errorStream(message: AssistantMessage): AssistantMessageEventStream {
  return terminalStream(message);
}

function deltaStream(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'thinking_start', contentIndex: 0, partial: message });
    stream.push({ type: 'thinking_delta', contentIndex: 0, delta: 'plan', partial: message });
    stream.push({ type: 'thinking_end', contentIndex: 0, content: 'plan', partial: message });
    stream.push({ type: 'text_start', contentIndex: 1, partial: message });
    stream.push({ type: 'text_delta', contentIndex: 1, delta: 'done', partial: message });
    stream.push({ type: 'text_end', contentIndex: 1, content: 'done', partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end(message);
  });
  return stream;
}

function controlledStream(): {
  stream: AssistantMessageEventStream;
  finish: (message: AssistantMessage) => void;
} {
  const stream = createAssistantMessageEventStream();
  return {
    stream,
    finish: (message) => {
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end(message);
    },
  };
}

function tool(
  name: string,
  executionMode?: 'sequential',
  execute: AgentTool['execute'] = async () => toolResult(name),
): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: false } as any,
    execute,
    ...(executionMode ? { executionMode } : {}),
  };
}

function toolResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: { text } };
}

function eventLabel(event: AgentEvent): string {
  if (event.type === 'message_update') return `${event.type}:${event.assistantMessageEvent.type}`;
  if (event.type === 'message_start' || event.type === 'message_end') {
    return event.message.role === 'toolResult'
      ? `${event.type}:${event.message.role}:${event.message.toolCallId}`
      : `${event.type}:${event.message.role}`;
  }
  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
    return `${event.type}:${event.toolCallId}`;
  }
  return event.type;
}

function messageText(message: Message): string {
  if (!('content' in message)) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => (
    part.type === 'text' ? part.text : ''
  )).join('');
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for kernel state.');
}

interface JudgeTrace {
  starts: string[];
  results: string[];
  failureTail: string[];
  sequentialMaxActive: number;
}

function parityJudge(trace: JudgeTrace): boolean {
  return JSON.stringify(trace.starts) === JSON.stringify(['a', 'b'])
    && JSON.stringify(trace.results) === JSON.stringify(['a', 'b'])
    && JSON.stringify(trace.failureTail) === JSON.stringify([
      'message_start',
      'message_end',
      'turn_end',
      'agent_end',
    ])
    && trace.sequentialMaxActive === 1;
}
