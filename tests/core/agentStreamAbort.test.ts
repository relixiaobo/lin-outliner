import { describe, expect, test } from 'bun:test';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
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
});

function normalizeAssistant(message: ReturnType<typeof fauxAssistantMessage>) {
  return {
    ...message,
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: message.usage ?? EMPTY_USAGE,
    timestamp: message.timestamp ?? Date.now(),
  };
}
