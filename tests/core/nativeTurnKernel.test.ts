import { readFileSync } from 'node:fs';
import { describe, expect, spyOn, test } from 'bun:test';
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
import { persistToolCallAdmission } from '../../src/main/agent/runtime/toolCallHistory';
import {
  AGENT_MESSAGE_INPUT_SCHEMA,
  normalizeAgentMessageToolInput,
} from '../../src/core/agent/tools';
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
      'tool_call_admission:one',
      'tool_execution_start:one',
      'tool_execution_end:one',
      'tool_call_admission:two',
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
    expect(truncatedEvents.find((event) => event.type === 'tool_call_admission')).toMatchObject({
      decision: {
        execute: false,
        modelCall: { disposition: 'evidenceOnly', reason: 'truncatedArguments' },
      },
    });
    const truncatedEnd = truncatedEvents.find((event) => (
      event.type === 'tool_execution_end' && event.toolCallId === 'cut'
    ));
    expect(truncatedEnd).toMatchObject({
      type: 'tool_execution_end',
      isError: true,
      result: { content: [{ text: expect.stringContaining('output token limit') }] },
    });
  });

  test('stops admitting a truncated batch after cancellation', async () => {
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([
        { type: 'toolCall', id: 'cut-one', name: 'cut', arguments: { partial: true } },
        { type: 'toolCall', id: 'cut-two', name: 'cut', arguments: { partial: true } },
      ], 'length')),
    ]);
    const runtime = createRuntime(gateway, { tools: [tool('cut')] });
    const events: AgentEvent[] = [];
    runtime.subscribe((event) => {
      events.push(event);
      if (event.type === 'tool_call_admission' && event.toolCallId === 'cut-one') runtime.abort();
    });

    await runtime.prompt(USER);

    expect(events.filter((event) => event.type === 'tool_call_admission').map((event) => event.toolCallId))
      .toEqual(['cut-one']);
    expect(events.filter((event) => event.type === 'tool_execution_end').map((event) => event.toolCallId))
      .toEqual(['cut-one']);
    expect(JSON.stringify(runtime.state.messages)).not.toContain('cut-two');
  });

  test('replaces one schema-invalid bash call with correction evidence before the next request', async () => {
    let executed = false;
    const bash = parameterTool('bash', {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['command'],
    }, async () => {
      executed = true;
      return toolResult('must not execute');
    });
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([{
        type: 'toolCall',
        id: 'invalid-cwd',
        name: 'bash',
        arguments: { command: 'pwd', cwd: '/model-supplied' },
      }], 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'corrected' }])),
    ]);
    const runtime = createRuntime(gateway, { tools: [bash] });
    const events: AgentEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.prompt(USER);

    expect(executed).toBe(false);
    expect(gateway.requests).toHaveLength(2);
    const replay = gateway.requests[1]!.context.messages;
    expect(replay.some((message) => message.role === 'toolResult')).toBe(false);
    expect(replay.flatMap((message) => (
      typeof message.content === 'string' ? [] : message.content.filter((part) => part.type === 'toolCall')
    ))).toEqual([]);
    expect(replay.map(messageText).join('\n')).toContain('"reason":"invalidArguments"');
    expect(replay.map(messageText).join('\n')).toContain('"cwd":"/model-supplied"');
    expect(runtime.state.messages.map(messageText).join('\n'))
      .toContain('"identity":{"namespace":null,"name":"bash"}');
    expect(events.filter((event) => event.type === 'tool_call_admission')).toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          execute: false,
          modelCall: expect.objectContaining({ disposition: 'evidenceOnly', reason: 'invalidArguments' }),
        }),
      }),
    ]);
    expect(events.some((event) => event.type === 'tool_execution_start')).toBe(false);
  });

  test('admits exact nested JSON values after preparing arguments exactly once', async () => {
    const argumentsValue = {
      nullable: null,
      empty: '',
      zero: 0,
      disabled: false,
      items: [1, 2],
      nested: { label: 'kept' },
    };
    const executions: unknown[] = [];
    let preparations = 0;
    const exact = parameterTool('exact', {
      type: 'object',
      additionalProperties: false,
      properties: {
        nullable: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        optional: { type: 'string' },
        empty: { type: 'string' },
        zero: { type: 'number' },
        disabled: { type: 'boolean' },
        items: { type: 'array', items: { type: 'integer' } },
        nested: {
          type: 'object',
          additionalProperties: false,
          properties: { label: { type: 'string' } },
          required: ['label'],
        },
      },
      required: ['nullable', 'empty', 'zero', 'disabled', 'items', 'nested'],
    }, async (_id, args) => {
      executions.push(args);
      return toolResult('exact');
    });
    exact.prepareArguments = (args) => {
      preparations += 1;
      return args as never;
    };
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([{
        type: 'toolCall', id: 'exact-call', name: 'exact', arguments: argumentsValue,
      }], 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'done' }])),
    ]);
    const runtime = createRuntime(gateway, { tools: [exact] });

    await runtime.prompt(USER);

    expect(preparations).toBe(1);
    expect(executions).toEqual([argumentsValue]);
  });

  test('prepares Agent message summaries for execution without rewriting provider history', async () => {
    const longSummary = 'x'.repeat(201);
    const providerCalls = [
      { to: 'agent-one', message: 'First line\nSecond line' },
      { to: 'agent-two', summary: '   ', message: 'Blank fallback\nSecond line' },
      { to: 'agent-three', summary: longSummary, message: 'Explicit summary' },
    ];
    const executions: unknown[] = [];
    const messageTool = parameterTool(
      'agent_message',
      AGENT_MESSAGE_INPUT_SCHEMA as unknown as Record<string, unknown>,
      async (_id, args) => {
        executions.push(args);
        return toolResult('sent');
      },
    );
    messageTool.prepareArguments = normalizeAgentMessageToolInput;
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant(providerCalls.map((argumentsValue, index) => ({
        type: 'toolCall' as const,
        id: `message-${index + 1}`,
        name: 'agent_message',
        arguments: argumentsValue,
      })), 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'done' }])),
    ]);
    const admissions: Array<Extract<AgentEvent, { readonly type: 'tool_call_admission' }>> = [];
    const runtime = createRuntime(gateway, { tools: [messageTool] });
    runtime.subscribe((event) => {
      if (event.type === 'tool_call_admission') admissions.push(event);
    });

    await runtime.prompt(USER);

    expect(executions).toEqual([
      { ...providerCalls[0], summary: 'First line' },
      { ...providerCalls[1], summary: 'Blank fallback' },
      { ...providerCalls[2], summary: `${'x'.repeat(199)}…` },
    ]);
    expect(admissions.map((event) => event.decision.displayArguments)).toEqual(executions);
    expect(admissions.map((event) => (
      event.decision.modelCall.disposition === 'replayable'
        && event.decision.modelCall.arguments.storage === 'inline'
        ? event.decision.modelCall.arguments.value
        : null
    ))).toEqual(providerCalls);
    const replayedCalls = gateway.requests[1]!.context.messages.flatMap((message) => (
      message.role === 'assistant'
        ? message.content.filter((part) => part.type === 'toolCall').map((part) => part.arguments)
        : []
    ));
    expect(replayedCalls).toEqual(providerCalls);
  });

  test('isolates canonical history from mutations inside a tool handler', async () => {
    const providerArguments = {
      nested: { value: 'original' },
      removable: 'preserved',
    };
    const mutating = parameterTool('mutating', {
      type: 'object',
      additionalProperties: false,
      properties: {
        nested: {
          type: 'object',
          additionalProperties: false,
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        removable: { type: 'string' },
      },
      required: ['nested', 'removable'],
    }, async (_id, args) => {
      const mutable = args as typeof providerArguments;
      mutable.nested.value = 'mutated';
      delete (mutable as Partial<typeof providerArguments>).removable;
      return toolResult('mutated private execution copy');
    });
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([{
        type: 'toolCall', id: 'mutating-call', name: 'mutating', arguments: providerArguments,
      }], 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'done' }])),
    ]);
    const runtime = createRuntime(gateway, { tools: [mutating] });

    await runtime.prompt(USER);

    const replayedCalls = gateway.requests[1]!.context.messages.flatMap((message) => (
      message.role === 'assistant'
        ? message.content.filter((part) => part.type === 'toolCall')
        : []
    ));
    expect(providerArguments).toEqual({ nested: { value: 'original' }, removable: 'preserved' });
    expect(replayedCalls).toMatchObject([{
      id: 'mutating-call',
      name: 'mutating',
      arguments: { nested: { value: 'original' }, removable: 'preserved' },
    }]);
  });

  test('rejects wrong scalar, array, nested, and unknown-field types without conversion', async () => {
    let executions = 0;
    const schemas: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['string_value', { type: 'string' }, { value: null }],
      ['number_value', { type: 'number' }, { value: '1' }],
      ['boolean_value', { type: 'boolean' }, { value: 'false' }],
      ['null_value', { type: 'null' }, { value: 0 }],
      ['array_value', { type: 'array', items: { type: 'integer' } }, { value: ['1'] }],
      [
        'nested_value',
        {
          type: 'object',
          additionalProperties: false,
          properties: { label: { type: 'string' } },
          required: ['label'],
        },
        { value: { label: 'ok', extra: true } },
      ],
    ];
    const tools = schemas.map(([name, valueSchema]) => parameterTool(name, {
      type: 'object',
      additionalProperties: false,
      properties: { value: valueSchema },
      required: ['value'],
    }, async () => {
      executions += 1;
      return toolResult('must not execute');
    }));
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant(schemas.map(([name, , argumentsValue], index) => ({
        type: 'toolCall' as const,
        id: `wrong-${index}`,
        name,
        arguments: argumentsValue,
      })), 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'done' }])),
    ]);
    const runtime = createRuntime(gateway, { tools });
    const events: AgentEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.prompt(USER);

    expect(executions).toBe(0);
    expect(events.filter((event) => event.type === 'tool_call_admission')).toHaveLength(schemas.length);
    expect(events.filter((event) => event.type === 'tool_call_admission')).toEqual(
      Array.from({ length: schemas.length }, () => expect.objectContaining({
        decision: expect.objectContaining({
          execute: false,
          modelCall: expect.objectContaining({ reason: 'invalidArguments' }),
        }),
      })),
    );
  });

  test('quarantines only the resolved tool after its second identical rejection', async () => {
    const strict = parameterTool('strict', {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string' } },
      required: ['value'],
    }, async () => toolResult('must not execute'));
    const sibling = tool('sibling');
    const repeatedCall = (id: string) => assistant([{
      type: 'toolCall' as const,
      id,
      name: 'strict',
      arguments: { value: 1 },
    }], 'toolUse');
    const gateway = new ScriptedGateway([
      () => terminalStream(repeatedCall('repeat-one')),
      () => terminalStream(repeatedCall('repeat-two')),
      () => terminalStream(assistant([{ type: 'text', text: 'blocked' }])),
    ]);
    const runtime = createRuntime(gateway, { tools: [strict, sibling] });

    await runtime.prompt(USER);

    expect(gateway.requests.map((request) => request.context.tools.map((entry) => entry.name))).toEqual([
      ['strict', 'sibling'],
      ['strict', 'sibling'],
      ['sibling'],
    ]);
  });

  test('does not collide deterministic failures with different attempted arguments', async () => {
    const strict = parameterTool('strict', {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string' } },
      required: ['value'],
    }, async () => toolResult('must not execute'));
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([{
        type: 'toolCall', id: 'different-one', name: 'strict', arguments: { value: 1 },
      }], 'toolUse')),
      () => terminalStream(assistant([{
        type: 'toolCall', id: 'different-two', name: 'strict', arguments: { value: 2 },
      }], 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'done' }])),
    ]);
    const runtime = createRuntime(gateway, { tools: [strict] });

    await runtime.prompt(USER);

    expect(gateway.requests[2]?.context.tools.map((entry) => entry.name)).toEqual(['strict']);
  });

  test('does not collide identical failures after the exposed schema changes', async () => {
    const parameters = {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string' } },
      required: ['value'],
    };
    const strict = parameterTool('strict', parameters, async () => toolResult('must not execute'));
    const invalidCall = (id: string) => assistant([{
      type: 'toolCall' as const,
      id,
      name: 'strict',
      arguments: { value: 1 },
    }], 'toolUse');
    const gateway = new ScriptedGateway([
      () => terminalStream(invalidCall('schema-one')),
      () => {
        parameters.properties.value = { type: 'boolean' };
        return terminalStream(invalidCall('schema-two'));
      },
      () => terminalStream(assistant([{ type: 'text', text: 'done' }])),
    ]);
    const runtime = createRuntime(gateway, { tools: [strict] });

    await runtime.prompt(USER);

    expect(gateway.requests[2]?.context.tools.map((entry) => entry.name)).toEqual(['strict']);
  });

  test('recreates the quarantine guard for the next NativeAgentRuntime prompt', async () => {
    const strict = parameterTool('strict', {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string' } },
      required: ['value'],
    }, async () => toolResult('must not execute'));
    const repeatedCall = (id: string) => assistant([{
      type: 'toolCall' as const,
      id,
      name: 'strict',
      arguments: { value: 1 },
    }], 'toolUse');
    const gateway = new ScriptedGateway([
      () => terminalStream(repeatedCall('turn-one-a')),
      () => terminalStream(repeatedCall('turn-one-b')),
      () => terminalStream(assistant([{ type: 'text', text: 'turn one done' }])),
      () => terminalStream(assistant([{ type: 'text', text: 'turn two done' }])),
    ]);
    const runtime = createRuntime(gateway, { tools: [strict] });

    await runtime.prompt(USER);
    await runtime.prompt({ role: 'user', content: 'Again', timestamp: 2 });

    expect(gateway.requests[2]?.context.tools).toHaveLength(0);
    expect(gateway.requests[3]?.context.tools.map((entry) => entry.name)).toEqual(['strict']);
  });

  test('keeps a repeatedly truncated tool exposed so the model can re-issue a shorter call', async () => {
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([{
        type: 'toolCall', id: 'truncated-one', name: 'cut', arguments: { partial: true },
      }], 'length')),
      () => terminalStream(assistant([{
        type: 'toolCall', id: 'truncated-two', name: 'cut', arguments: { partial: true },
      }], 'length')),
      () => terminalStream(assistant([{ type: 'text', text: 'done' }])),
    ]);
    const runtime = createRuntime(gateway, { tools: [tool('cut')] });

    await runtime.prompt(USER);

    expect(gateway.requests[2]?.context.tools).toHaveLength(1);
  });

  test('still counts truncation toward the deterministic failure ceiling', async () => {
    const scripts = Array.from({ length: 8 }, (_, index) => () => terminalStream(assistant([{
      type: 'toolCall' as const,
      id: `truncated-${index}`,
      name: 'cut',
      arguments: { attempt: index },
    }], 'length')));
    scripts.push(() => terminalStream(assistant([{ type: 'text', text: 'done' }])));
    const gateway = new ScriptedGateway(scripts);
    const runtime = createRuntime(gateway, { tools: [tool('cut')] });

    await runtime.prompt(USER);

    expect(gateway.requests).toHaveLength(9);
    expect(gateway.requests.slice(0, 8).every((request) => request.context.tools.length === 1)).toBe(true);
    expect(gateway.requests[8]?.context.tools).toHaveLength(0);
  });

  test('makes one final tool-free request at the deterministic failure ceiling', async () => {
    const scripts = [() => terminalStream(assistant([{
      type: 'toolCall' as const,
      id: 'admitted-before-ceiling',
      name: 'available',
      arguments: {},
    }], 'toolUse')), ...Array.from({ length: 8 }, (_, index) => () => terminalStream(assistant([{
      type: 'toolCall' as const,
      id: `missing-${index}`,
      name: `missing_tool_${index}`,
      arguments: { attempt: index },
    }], 'toolUse')))];
    scripts.push(() => terminalStream(assistant([{
      type: 'toolCall',
      id: 'hallucinated-after-ceiling',
      name: 'available',
      arguments: {},
    }], 'toolUse')));
    const gateway = new ScriptedGateway(scripts);
    const runtime = createRuntime(gateway, { tools: [tool('available')] });

    await runtime.prompt(USER);

    expect(gateway.requests).toHaveLength(10);
    expect(gateway.requests.slice(0, 9).every((request) => request.context.tools.length === 1)).toBe(true);
    const finalRequest = gateway.requests[9]!;
    expect(finalRequest.context.tools).toHaveLength(0);
    expect(finalRequest.context.messages.some((message) => (
      message.role === 'assistant' && message.content.some((part) => (
        part.type === 'toolCall' && part.id === 'admitted-before-ceiling'
      ))
    ))).toBe(true);
    expect(finalRequest.context.messages.some((message) => (
      message.role === 'toolResult' && message.toolCallId === 'admitted-before-ceiling'
    ))).toBe(true);
    expect(JSON.stringify(runtime.state.messages)).toContain('hallucinated-after-ceiling');
    expect(JSON.stringify(runtime.state.messages)).toContain('unresolvedTool');
  });

  test('does not count admission persistence or tool execution failures as deterministic', async () => {
    const strict = parameterTool('strict', {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string' } },
      required: ['value'],
    }, async () => { throw new Error('transient execution failure'); });
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([{
        type: 'toolCall', id: 'persist-one', name: 'strict', arguments: { value: 1 },
      }], 'toolUse')),
      () => terminalStream(assistant([{
        type: 'toolCall', id: 'persist-two', name: 'strict', arguments: { value: 1 },
      }], 'toolUse')),
      () => terminalStream(assistant([{
        type: 'toolCall', id: 'execution-one', name: 'strict', arguments: { value: 'ok' },
      }], 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'done' }])),
    ]);
    let admissionAttempts = 0;
    const runtime = createRuntime(gateway, {
      tools: [strict],
      admitToolCall: (request) => {
        admissionAttempts += 1;
        if (request.outcome.type === 'rejected') throw new Error('persistence unavailable');
        return persistToolCallAdmission(request, async () => { throw new Error('not needed'); });
      },
    });

    await runtime.prompt(USER);

    expect(admissionAttempts).toBe(3);
    expect(gateway.requests.slice(0, 4).map((request) => request.context.tools.map((entry) => entry.name)))
      .toEqual([['strict'], ['strict'], ['strict'], ['strict']]);
    expect(JSON.stringify(runtime.state.messages)).toContain('transient execution failure');
  });

  test('does not let a rejected call id suppress a later admitted result with the same id', async () => {
    const reusedCallId = 'provider-reused-id';
    const executions: unknown[] = [];
    const strictTool = parameterTool('strict_tool', {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string' } },
      required: ['value'],
    }, async (_id, args) => {
      executions.push(args);
      return toolResult('later call completed');
    });
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([{
        type: 'toolCall',
        id: reusedCallId,
        name: 'strict_tool',
        arguments: { invalid: true },
      }], 'toolUse')),
      () => terminalStream(assistant([{
        type: 'toolCall',
        id: reusedCallId,
        name: 'strict_tool',
        arguments: { value: 'valid' },
      }], 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'done' }])),
    ]);
    const runtime = createRuntime(gateway, { tools: [strictTool] });

    await runtime.prompt(USER);

    expect(executions).toEqual([{ value: 'valid' }]);
    const canonicalCalls = runtime.state.messages.flatMap((message) => (
      message.role === 'assistant'
        ? message.content.filter((part) => part.type === 'toolCall')
        : []
    ));
    const results = runtime.state.messages.filter((message) => message.role === 'toolResult');
    expect(canonicalCalls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(canonicalCalls[0]?.id).not.toBe(reusedCallId);
    expect(results[0]?.role === 'toolResult' ? results[0].toolCallId : null).toBe(canonicalCalls[0]?.id);
    expect(JSON.stringify(runtime.state.messages)).toContain('later call completed');
  });

  test('heals duplicate ids within one mixed admission batch without losing the valid pair', async () => {
    const duplicatedId = 'same-batch-id';
    const executions: unknown[] = [];
    const strictTool = parameterTool('strict_tool', {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string' } },
      required: ['value'],
    }, async (_id, args) => {
      executions.push(args);
      return toolResult('valid pair completed');
    });
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([
        { type: 'toolCall', id: duplicatedId, name: 'strict_tool', arguments: { invalid: true } },
        { type: 'toolCall', id: duplicatedId, name: 'strict_tool', arguments: { value: 'valid' } },
      ], 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'done' }])),
    ]);
    const runtime = createRuntime(gateway, { tools: [strictTool] });
    const admissionIds: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === 'tool_call_admission') admissionIds.push(event.toolCallId);
    });

    await runtime.prompt(USER);

    expect(executions).toEqual([{ value: 'valid' }]);
    expect(admissionIds).toHaveLength(2);
    expect(new Set(admissionIds).size).toBe(2);
    const replay = gateway.requests[1]!.context.messages;
    const replayCalls = replay.flatMap((message) => (
      message.role === 'assistant'
        ? message.content.filter((part) => part.type === 'toolCall')
        : []
    ));
    const replayResults = replay.filter((message) => message.role === 'toolResult');
    expect(replay.map(messageText).join('\n')).toContain('"reason":"invalidArguments"');
    expect(replayCalls).toHaveLength(1);
    expect(replayResults).toHaveLength(1);
    expect(replayResults[0]?.role === 'toolResult' ? replayResults[0].toolCallId : null)
      .toBe(replayCalls[0]?.id);
  });

  test('executes a secret-bearing call once and keeps its raw arguments only in the live Turn exchange', async () => {
    const secret = 'abcdefghijklmnop';
    const command = `curl -H "Authorization: Bearer ${secret}" https://example.test`;
    const executedArguments: unknown[] = [];
    const bash = parameterTool('bash', {
      type: 'object',
      additionalProperties: false,
      properties: { command: { type: 'string' } },
      required: ['command'],
    }, async (_id, args) => {
      executedArguments.push(args);
      return toolResult('request completed');
    });
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([{
        type: 'toolCall', id: 'secret-call', name: 'bash', arguments: { command },
      }], 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'done' }])),
    ]);
    const runtime = createRuntime(gateway, { tools: [bash] });
    let admission: Extract<AgentEvent, { readonly type: 'tool_call_admission' }> | null = null;
    runtime.subscribe((event) => {
      if (event.type === 'tool_call_admission') admission = event;
    });

    await runtime.prompt(USER);

    expect(executedArguments).toEqual([{ command }]);
    const replay = gateway.requests[1]!.context.messages;
    const serializedReplay = JSON.stringify(replay);
    expect(serializedReplay).toContain(secret);
    expect(serializedReplay).not.toContain('redacted after execution');
    expect(replay.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult']);
    const replayAssistant = replay[1];
    expect(replayAssistant?.role).toBe('assistant');
    if (replayAssistant?.role !== 'assistant') throw new Error('Expected replay assistant message.');
    expect(replayAssistant.content.map((part) => part.type)).toEqual(['toolCall']);
    expect(admission).toMatchObject({
      decision: { modelCall: { disposition: 'redactedReplay' } },
    });
    expect(JSON.stringify(admission)).not.toContain(secret);
  });

  test('executes admitted arguments when their redacted placeholder fails exact replay validation', async () => {
    const secret = 'abcdefghijklmnop';
    const command = `curl -H "Authorization: Bearer ${secret}" https://example.test`;
    const executedArguments: unknown[] = [];
    const exactSecret = parameterTool('exact_secret', {
      type: 'object',
      additionalProperties: false,
      properties: { command: { type: 'string', const: command } },
      required: ['command'],
    }, async (_id, args) => {
      executedArguments.push(args);
      return toolResult('executed');
    });
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([{
        type: 'toolCall', id: 'exact-secret-call', name: 'exact_secret', arguments: { command },
      }], 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'done' }])),
    ]);
    const runtime = createRuntime(gateway, { tools: [exactSecret] });
    let admission: Extract<AgentEvent, { readonly type: 'tool_call_admission' }> | null = null;
    runtime.subscribe((event) => {
      if (event.type === 'tool_call_admission') admission = event;
    });

    await runtime.prompt(USER);

    expect(executedArguments).toEqual([{ command }]);
    expect(admission).toMatchObject({
      decision: {
        execute: true,
        modelCall: { disposition: 'evidenceOnly', reason: 'schemaIncompatible' },
      },
    });
    expect(JSON.stringify(admission)).not.toContain(secret);
  });

  test('keeps payload-backed history exact across NativeAgentRuntime prompts', async () => {
    const largeValue = 'x'.repeat(40_000);
    const largeTool = parameterTool('large_tool', {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string' } },
      required: ['value'],
    }, async () => toolResult('stored'));
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([{
        type: 'toolCall', id: 'large-call', name: 'large_tool', arguments: { value: largeValue },
      }], 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'first prompt complete' }])),
      () => terminalStream(assistant([{ type: 'text', text: 'second prompt complete' }])),
    ]);
    const runtime = createRuntime(gateway, {
      tools: [largeTool],
      admitToolCall: (request) => persistToolCallAdmission(request, async () => ({
        id: 'a'.repeat(64),
        mimeType: 'application/vnd.tenon.agent-context+json',
        byteLength: 40_200,
        schemaVersion: 1,
        kind: 'toolCallArguments',
      })),
    });

    await runtime.prompt(USER);
    await runtime.prompt({ role: 'user', content: 'Continue', timestamp: 2 });

    for (const request of [gateway.requests[1]!, gateway.requests[2]!]) {
      const replayed = request.context.messages.flatMap((message) => (
        typeof message.content === 'string'
          ? []
          : message.content.filter((part) => part.type === 'toolCall')
      ));
      expect(replayed).toMatchObject([{
        id: 'large-call',
        name: 'large_tool',
        arguments: { value: largeValue },
      }]);
      expect(JSON.stringify(replayed)).not.toContain('storedArguments');
      expect(JSON.stringify(replayed)).not.toContain('truncated');
    }
  });

  test('keeps cancellation after admission distinct from validation and skips every side effect', async () => {
    let executions = 0;
    const gateway = new ScriptedGateway([() => terminalStream(assistant([
      { type: 'toolCall', id: 'cancel-one', name: 'first', arguments: {} },
      { type: 'toolCall', id: 'cancel-two', name: 'second', arguments: {} },
    ], 'toolUse'))]);
    const runtime = createRuntime(gateway, {
      tools: [
        tool('first', undefined, async () => { executions += 1; return toolResult('first'); }),
        tool('second', undefined, async () => { executions += 1; return toolResult('second'); }),
      ],
    });
    const events: AgentEvent[] = [];
    runtime.subscribe((event) => {
      events.push(event);
      if (event.type === 'tool_call_admission' && event.toolCallId === 'cancel-one') runtime.abort();
    });

    await runtime.prompt(USER);

    expect(executions).toBe(0);
    expect(gateway.requests).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool_call_admission')).toMatchObject([
      { toolCallId: 'cancel-one', decision: { execute: true, modelCall: { disposition: 'replayable' } } },
    ]);
    expect(events.some((event) => event.type === 'tool_execution_start')).toBe(false);
    expect(events.filter((event) => event.type === 'tool_execution_end')).toMatchObject([
      { toolCallId: 'cancel-one', isError: true, result: { content: [{ text: 'Operation aborted' }] } },
    ]);
    expect(runtime.state.messages.flatMap((message) => (
      message.role === 'assistant'
        ? message.content.filter((part) => part.type === 'toolCall').map((part) => part.id)
        : []
    ))).toEqual(['cancel-one']);
    expect(JSON.stringify(runtime.state.messages)).not.toContain('invalidArguments');
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
      remainingTokenBudget: () => ({
        remaining: 4 - gateway.requests.length * USAGE.totalTokens,
        total: 10,
        used: 6 + gateway.requests.length * USAGE.totalTokens,
      }),
    });
    const events: AgentEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.prompt(USER);

    expect(gateway.requests).toHaveLength(1);
    expect(runtime.state.interruptionError).toEqual({
      code: 'subagent_budget_exhausted',
      message: 'Token budget exhausted mid-Turn (16 of 10 tokens)',
    });
    expect(events.filter((event) => event.type === 'turn_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'turn_end')).toHaveLength(1);
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
    const warnings: Array<{ remaining: number; total: number; used: number }> = [];
    let runtime!: NativeAgentRuntime;
    runtime = createRuntime(gateway, {
      tools: [tool('budget-tool')],
      remainingTokenBudget: () => ({
        remaining: gateway.requests.length === 0 ? 23 : 3,
        total: 25,
        used: gateway.requests.length === 0 ? 2 : 22,
      }),
      onBudgetWarning: async (actuals) => {
        warnings.push(actuals);
        runtime.steer({ role: 'user', content: notice, timestamp: 3 });
      },
    });

    await runtime.prompt(USER);

    expect(gateway.requests).toHaveLength(3);
    expect(warnings).toEqual([{ remaining: 3, total: 25, used: 22 }]);
    expect(gateway.requests[1]?.context.messages.map(messageText)).toContain(notice);
  });

  test('logs a budget warning delivery failure and continues the Turn', async () => {
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([
        { type: 'toolCall', id: 'warning-failure-call', name: 'budget-tool', arguments: {} },
      ], 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'complete without notice' }])),
    ]);
    const warningFailure = new Error('budget notice steering failed');
    const warningLog = spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = createRuntime(gateway, {
      tools: [tool('budget-tool')],
      remainingTokenBudget: () => ({
        remaining: gateway.requests.length === 0 ? 100 : 20,
        total: 100,
        used: gateway.requests.length === 0 ? 0 : 80,
      }),
      onBudgetWarning: async () => { throw warningFailure; },
    });

    try {
      await runtime.prompt(USER);
      expect(warningLog).toHaveBeenCalledTimes(1);
      expect(warningLog).toHaveBeenCalledWith(
        '[agent] Budget warning delivery failed: budget notice steering failed',
      );
    } finally {
      warningLog.mockRestore();
    }

    expect(gateway.requests).toHaveLength(2);
    expect(runtime.state.interruptionError).toBeUndefined();
    expect(runtime.state.errorMessage).toBeUndefined();
  });

  test('keeps a terminal answer completed and leaves racing steering undelivered at exhaustion', async () => {
    const controlled = controlledStream();
    const gateway = new ScriptedGateway([
      () => controlled.stream,
      () => terminalStream(assistant([{ type: 'text', text: 'must not run' }])),
    ]);
    const runtime = createRuntime(gateway, {
      remainingTokenBudget: () => ({
        remaining: 10 - gateway.requests.length * USAGE.totalTokens,
        total: 10,
        used: gateway.requests.length * USAGE.totalTokens,
      }),
    });
    let delivered = 0;
    const running = runtime.prompt(USER);
    await waitFor(() => gateway.requests.length === 1);
    runtime.steer(
      { role: 'user', content: 'racing steer', timestamp: 3 },
      () => { delivered += 1; },
    );
    controlled.finish(assistant([{ type: 'text', text: 'terminal answer' }]));

    await running;

    expect(gateway.requests).toHaveLength(1);
    expect(runtime.state.interruptionError).toBeUndefined();
    expect(delivered).toBe(0);
  });

  test('survives a binding denomination flip and still enforces the active cap', async () => {
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([
        { type: 'toolCall', id: 'flip-call-1', name: 'budget-tool', arguments: {} },
      ], 'toolUse')),
      () => terminalStream(assistant([
        { type: 'toolCall', id: 'flip-call-2', name: 'budget-tool', arguments: {} },
      ], 'toolUse')),
      () => terminalStream(assistant([
        { type: 'toolCall', id: 'flip-call-3', name: 'budget-tool', arguments: {} },
      ], 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'must not run' }])),
    ]);
    const snapshots = [
      { remaining: 10, total: 100, used: 90 },
      { remaining: 5, total: 20, used: 15 },
      { remaining: 0, total: 20, used: 20 },
    ];
    const runtime = createRuntime(gateway, {
      tools: [tool('budget-tool')],
      remainingTokenBudget: () => snapshots[Math.min(gateway.requests.length - 1, 2)]!,
    });

    await runtime.prompt(USER);

    expect(gateway.requests).toHaveLength(3);
    expect(runtime.state.interruptionError).toEqual({
      code: 'subagent_budget_exhausted',
      message: 'Token budget exhausted mid-Turn (20 of 20 tokens)',
    });
  });

  test('keeps a null budget port unlimited across provider calls', async () => {
    const gateway = new ScriptedGateway([
      () => terminalStream(assistant([
        { type: 'toolCall', id: 'unlimited-call', name: 'budget-tool', arguments: {} },
      ], 'toolUse')),
      () => terminalStream(assistant([{ type: 'text', text: 'complete' }])),
    ]);
    const runtime = createRuntime(gateway, {
      tools: [tool('budget-tool')],
      remainingTokenBudget: () => null,
    });

    await runtime.prompt(USER);

    expect(gateway.requests).toHaveLength(2);
    expect(runtime.state.interruptionError).toBeUndefined();
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
    admitToolCall?: KernelAgentOptions['admitToolCall'];
    remainingTokenBudget?: KernelAgentOptions['remainingTokenBudget'];
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
    admitToolCall: overrides.admitToolCall,
    remainingTokenBudget: overrides.remainingTokenBudget,
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

function parameterTool(
  name: string,
  parameters: Record<string, unknown>,
  execute: AgentTool['execute'],
): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: parameters as any,
    execute,
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
  if (
    event.type === 'tool_call_admission'
    || event.type === 'tool_execution_start'
    || event.type === 'tool_execution_end'
  ) {
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
