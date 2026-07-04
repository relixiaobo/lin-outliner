import { describe, expect, test } from 'bun:test';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Api,
  type Context,
  type Model,
  type Usage,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAbortSettledStreamFn, wrapStreamWithAbortSettling } from '../../src/main/agentStreamAbort';

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const MODEL: Model<Api> = {
  id: 'abort-test-model',
  name: 'Abort Test Model',
  provider: 'openai',
  api: 'openai-completions',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const CUSTOM_RESPONSES_MODEL: Model<Api> = {
  ...MODEL,
  id: 'gpt-5.5',
  provider: 'tenon-custom:openai',
  api: 'openai-responses',
  baseUrl: 'https://proxy.example.com/v1',
  reasoning: true,
};

const OPENAI_RESPONSES_MODEL: Model<Api> = {
  ...MODEL,
  id: 'gpt-5.5',
  provider: 'openai',
  api: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  reasoning: true,
};

describe('agent stream abort settling', () => {
  test('settles a silent stream immediately when aborted', async () => {
    const source = createAssistantMessageEventStream();
    const abortCtrl = new AbortController();
    const wrapped = wrapStreamWithAbortSettling(source, { abortCtrl, model: MODEL });
    const iterator = wrapped[Symbol.asyncIterator]();
    const next = iterator.next();

    abortCtrl.abort(new DOMException('Stopped', 'AbortError'));

    const event = await next;
    expect(event.value.type).toBe('error');
    if (event.value.type !== 'error') throw new Error('Expected error event.');
    expect(event.value.reason).toBe('aborted');
    expect(event.value.error.stopReason).toBe('aborted');
    await expect(wrapped.result()).resolves.toMatchObject({ stopReason: 'aborted' });
  });

  test('preserves the latest partial assistant message on abort', async () => {
    const source = createAssistantMessageEventStream();
    const abortCtrl = new AbortController();
    const wrapped = wrapStreamWithAbortSettling(source, { abortCtrl, model: MODEL });
    const partial = normalizeAssistant(fauxAssistantMessage(fauxText('partial text')));
    const iterator = wrapped[Symbol.asyncIterator]();

    source.push({ type: 'start', partial });
    const start = await iterator.next();
    expect(start.value.type).toBe('start');

    const next = iterator.next();
    abortCtrl.abort();
    const event = await next;

    expect(event.value.type).toBe('error');
    if (event.value.type !== 'error') throw new Error('Expected error event.');
    expect(JSON.stringify(event.value.error.content)).toContain('partial text');
    expect(event.value.error.stopReason).toBe('aborted');
  });

  test('settles even when the source stream function has not resolved yet', async () => {
    let receivedSignal: AbortSignal | undefined;
    const sourceFn = ((_model: Model<Api>, _context: Context, options) => {
      receivedSignal = options?.signal;
      return new Promise(() => undefined);
    }) as StreamFn;
    const streamFn = createAbortSettledStreamFn(sourceFn);
    const upstreamAbort = new AbortController();
    const stream = streamFn(MODEL, { messages: [], tools: [] }, { signal: upstreamAbort.signal });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();

    upstreamAbort.abort('user stop');

    const event = await next;
    expect(receivedSignal?.aborted).toBe(true);
    expect(event.value.type).toBe('error');
    if (event.value.type !== 'error') throw new Error('Expected error event.');
    expect(event.value.error.stopReason).toBe('aborted');
  });

  test('converts synchronous source stream failures into terminal error events', async () => {
    const streamFn = createAbortSettledStreamFn((() => {
      throw new Error('stream setup failed');
    }) as StreamFn);
    const stream = streamFn(MODEL, { messages: [], tools: [] });
    const iterator = stream[Symbol.asyncIterator]();
    const event = await iterator.next();

    expect(event.value.type).toBe('error');
    if (event.value.type !== 'error') throw new Error('Expected error event.');
    expect(event.value.error.stopReason).toBe('error');
    expect(event.value.error.errorMessage).toBe('stream setup failed');
  });

  test('retries thinking-only OpenAI Responses stream termination once', async () => {
    let attempts = 0;
    const streamFn = createAbortSettledStreamFn((() => {
      attempts += 1;
      const source = createAssistantMessageEventStream();
      const message = attempts === 1
        ? normalizeAssistant({
          ...fauxAssistantMessage([], {
            stopReason: 'error',
            errorMessage: 'OpenAI Responses stream ended before a terminal response event',
          }),
          content: [{ type: 'thinking', thinking: 'partial thinking' }],
        } as any, OPENAI_RESPONSES_MODEL)
        : normalizeAssistant(fauxAssistantMessage(fauxText('retry answer')), OPENAI_RESPONSES_MODEL);

      queueMicrotask(() => {
        source.push({ type: 'start', partial: message });
        if (attempts === 1) {
          source.push({ type: 'thinking_start', contentIndex: 0, partial: message });
          source.push({ type: 'thinking_delta', contentIndex: 0, delta: 'partial thinking', partial: message });
          source.push({ type: 'thinking_end', contentIndex: 0, content: 'partial thinking', partial: message });
          source.push({ type: 'error', reason: 'error', error: message });
          source.end(message);
          return;
        }
        source.push({ type: 'text_start', contentIndex: 0, partial: message });
        source.push({ type: 'text_delta', contentIndex: 0, delta: 'retry answer', partial: message });
        source.push({ type: 'text_end', contentIndex: 0, content: 'retry answer', partial: message });
        source.push({ type: 'done', reason: 'stop', message });
        source.end(message);
      });
      return source;
    }) as StreamFn);

    const stream = streamFn(OPENAI_RESPONSES_MODEL, { messages: [], tools: [] });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(attempts).toBe(2);
    expect(events.map((event) => event.type)).toEqual(['start', 'text_start', 'text_delta', 'text_end', 'done']);
    expect(JSON.stringify(events)).not.toContain('partial thinking');
    await expect(stream.result()).resolves.toMatchObject({ stopReason: 'stop' });
  });

  test('does not retry OpenAI Responses termination after material output starts', async () => {
    let attempts = 0;
    const streamFn = createAbortSettledStreamFn((() => {
      attempts += 1;
      const source = createAssistantMessageEventStream();
      const message = normalizeAssistant(fauxAssistantMessage(fauxText('partial answer'), {
        stopReason: 'error',
        errorMessage: 'OpenAI Responses stream ended before a terminal response event',
      }), OPENAI_RESPONSES_MODEL);

      queueMicrotask(() => {
        source.push({ type: 'start', partial: message });
        source.push({ type: 'text_start', contentIndex: 0, partial: message });
        source.push({ type: 'text_delta', contentIndex: 0, delta: 'partial answer', partial: message });
        source.push({ type: 'error', reason: 'error', error: message });
        source.end(message);
      });
      return source;
    }) as StreamFn);

    const stream = streamFn(OPENAI_RESPONSES_MODEL, { messages: [], tools: [] });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(attempts).toBe(1);
    expect(events.map((event) => event.type)).toEqual(['start', 'text_start', 'text_delta', 'error']);
    await expect(stream.result()).resolves.toMatchObject({ stopReason: 'error' });
  });

  test('salvages completed custom Responses tool calls when the stream terminates before response.completed', async () => {
    const source = createAssistantMessageEventStream();
    const abortCtrl = new AbortController();
    const wrapped = wrapStreamWithAbortSettling(source, { abortCtrl, model: CUSTOM_RESPONSES_MODEL });
    const toolCall = fauxToolCall('node_create', { parent_id: 'node:root', outline: '- Done' });
    const message = normalizeAssistant(
      fauxAssistantMessage([
        fauxText('I will update the node.'),
        toolCall,
      ], { stopReason: 'error', errorMessage: 'terminated' }),
      CUSTOM_RESPONSES_MODEL,
    );
    const iterator = wrapped[Symbol.asyncIterator]();

    source.push({ type: 'toolcall_end', contentIndex: 1, toolCall, partial: message });
    source.push({ type: 'error', reason: 'error', error: message });
    source.end(message);

    expect((await iterator.next()).value.type).toBe('toolcall_end');
    const event = await iterator.next();
    expect(event.value.type).toBe('done');
    if (event.value.type !== 'done') throw new Error('Expected done event.');
    expect(event.value.reason).toBe('toolUse');
    expect(event.value.message.stopReason).toBe('toolUse');
    expect(event.value.message.errorMessage).toBeUndefined();
    await expect(wrapped.result()).resolves.toMatchObject({ stopReason: 'toolUse' });
  });

  test('does not salvage custom Responses tool calls that never reached toolcall_end', async () => {
    const source = createAssistantMessageEventStream();
    const abortCtrl = new AbortController();
    const wrapped = wrapStreamWithAbortSettling(source, { abortCtrl, model: CUSTOM_RESPONSES_MODEL });
    const toolCall = fauxToolCall('bash', { command: 'echo hello' });
    const message = normalizeAssistant(
      fauxAssistantMessage([
        fauxText('Running command.'),
        toolCall,
      ], { stopReason: 'error', errorMessage: 'terminated' }),
      CUSTOM_RESPONSES_MODEL,
    );
    const iterator = wrapped[Symbol.asyncIterator]();

    source.push({ type: 'toolcall_start', contentIndex: 1, partial: message });
    source.push({ type: 'toolcall_delta', contentIndex: 1, delta: '{"command":"echo hello', partial: message });
    source.push({ type: 'error', reason: 'error', error: message });
    source.end(message);

    expect((await iterator.next()).value.type).toBe('toolcall_start');
    expect((await iterator.next()).value.type).toBe('toolcall_delta');
    const event = await iterator.next();
    expect(event.value.type).toBe('error');
    if (event.value.type !== 'error') throw new Error('Expected error event.');
    expect(event.value.error.stopReason).toBe('error');
    expect(event.value.error.errorMessage).toBe('terminated');
    await expect(wrapped.result()).resolves.toMatchObject({ stopReason: 'error' });
  });

  test('does not salvage terminated non-custom Responses errors', async () => {
    const source = createAssistantMessageEventStream();
    const abortCtrl = new AbortController();
    const wrapped = wrapStreamWithAbortSettling(source, { abortCtrl, model: MODEL });
    const message = normalizeAssistant(
      fauxAssistantMessage([
        fauxToolCall('node_create', { parent_id: 'node:root', outline: '- Done' }),
      ], { stopReason: 'error', errorMessage: 'terminated' }),
    );
    const iterator = wrapped[Symbol.asyncIterator]();

    source.push({ type: 'error', reason: 'error', error: message });
    source.end(message);

    const event = await iterator.next();
    expect(event.value.type).toBe('error');
    if (event.value.type !== 'error') throw new Error('Expected error event.');
    expect(event.value.error.stopReason).toBe('error');
  });
});

function normalizeAssistant(message: ReturnType<typeof fauxAssistantMessage>, model: Model<Api> = MODEL) {
  return {
    ...message,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: message.usage ?? EMPTY_USAGE,
    timestamp: message.timestamp ?? Date.now(),
  };
}
