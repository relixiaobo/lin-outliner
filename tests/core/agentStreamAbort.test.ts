import { describe, expect, test } from 'bun:test';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Api,
  type Context,
  type Model,
  type Usage,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAbortSettledStreamFn,
  isRetryableResponsesRequestError,
  responsesRequestRetryDelayMs,
  wrapStreamWithAbortSettling,
} from '../../src/main/agentStreamAbort';

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

  test('retries custom OpenAI Responses 524 failures four times and succeeds on the fifth attempt', async () => {
    let attempts = 0;
    const retryCounts: number[] = [];
    const retryEvents: Array<{
      phase: 'retrying' | 'cleared';
      kind: 'request' | 'stream';
      attempt: number;
      maxRetries: number;
    }> = [];
    const streamFn = createAbortSettledStreamFn((() => {
      attempts += 1;
      return attempts <= 4
        ? errorStream('OpenAI API error (524): 524 status code (no body)', CUSTOM_RESPONSES_MODEL)
        : textStream('recovered after 524', CUSTOM_RESPONSES_MODEL);
    }) as StreamFn, {
      requestRetryDelayMs: (retryCount) => {
        retryCounts.push(retryCount);
        return 0;
      },
      onProviderRetry: (event) => retryEvents.push(event),
    });

    const stream = streamFn(CUSTOM_RESPONSES_MODEL, { messages: [], tools: [] });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(attempts).toBe(5);
    expect(retryCounts).toEqual([1, 2, 3, 4]);
    expect(retryEvents).toEqual([
      { phase: 'retrying', kind: 'request', attempt: 1, maxRetries: 4 },
      { phase: 'retrying', kind: 'request', attempt: 2, maxRetries: 4 },
      { phase: 'retrying', kind: 'request', attempt: 3, maxRetries: 4 },
      { phase: 'retrying', kind: 'request', attempt: 4, maxRetries: 4 },
      { phase: 'cleared', kind: 'request', attempt: 4, maxRetries: 4 },
    ]);
    expect(events.map((event) => event.type)).toEqual(['start', 'text_start', 'text_delta', 'text_end', 'done']);
    expect(JSON.stringify(events)).not.toContain('524 status code');
    await expect(stream.result()).resolves.toMatchObject({ stopReason: 'stop' });
  });

  test('surfaces only the final 524 after the request retry budget is exhausted', async () => {
    let attempts = 0;
    const retryPhases: string[] = [];
    const streamFn = createAbortSettledStreamFn((() => {
      attempts += 1;
      return errorStream('OpenAI API error (524): 524 status code (no body)');
    }) as StreamFn, {
      requestRetryDelayMs: () => 0,
      onProviderRetry: (event) => retryPhases.push(`${event.phase}:${event.attempt}`),
    });

    const stream = streamFn(OPENAI_RESPONSES_MODEL, { messages: [], tools: [] });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(attempts).toBe(5);
    expect(retryPhases).toEqual(['retrying:1', 'retrying:2', 'retrying:3', 'retrying:4', 'cleared:4']);
    expect(events.map((event) => event.type)).toEqual(['error']);
    if (events[0]?.type !== 'error') throw new Error('Expected final error event.');
    expect(events[0].error.errorMessage).toBe('OpenAI API error (524): 524 status code (no body)');
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: 'error',
      errorMessage: 'OpenAI API error (524): 524 status code (no body)',
    });
  });

  test('classifies only Responses 5xx and bounded transport failures as request-retryable', () => {
    expect(isRetryableResponsesRequestError('OpenAI API error (500): internal error')).toBe(true);
    expect(isRetryableResponsesRequestError('OpenAI API error (524): 524 status code (no body)')).toBe(true);
    expect(isRetryableResponsesRequestError('Azure OpenAI API error (599): upstream error')).toBe(true);
    expect(isRetryableResponsesRequestError('Connection error.')).toBe(true);
    expect(isRetryableResponsesRequestError('Request timed out.')).toBe(true);
    expect(isRetryableResponsesRequestError('TypeError: fetch failed')).toBe(true);
    expect(isRetryableResponsesRequestError('read ECONNRESET')).toBe(true);

    expect(isRetryableResponsesRequestError('OpenAI API error (429): rate limited')).toBe(false);
    expect(isRetryableResponsesRequestError('OpenAI API error (401): unauthorized')).toBe(false);
    expect(isRetryableResponsesRequestError('getaddrinfo ENOTFOUND proxy.example.com')).toBe(false);
    expect(isRetryableResponsesRequestError('connect ECONNREFUSED 127.0.0.1')).toBe(false);
    expect(isRetryableResponsesRequestError('OpenAI Responses stream ended before a terminal response event')).toBe(false);
    expect(isRetryableResponsesRequestError('stream setup failed')).toBe(false);
  });

  test('uses Codex-style exponential request retry delays with bounded jitter', () => {
    expect(responsesRequestRetryDelayMs(1, () => 0)).toBe(180);
    expect(responsesRequestRetryDelayMs(1, () => 0.5)).toBe(200);
    expect(responsesRequestRetryDelayMs(1, () => 1)).toBe(220);
    expect(responsesRequestRetryDelayMs(2, () => 0.5)).toBe(400);
    expect(responsesRequestRetryDelayMs(3, () => 0.5)).toBe(800);
    expect(responsesRequestRetryDelayMs(4, () => 0.5)).toBe(1600);
  });

  test('does not retry 429 Responses request failures', async () => {
    let attempts = 0;
    const streamFn = createAbortSettledStreamFn((() => {
      attempts += 1;
      return errorStream('OpenAI API error (429): rate limited');
    }) as StreamFn, { requestRetryDelayMs: () => 0 });

    const stream = streamFn(OPENAI_RESPONSES_MODEL, { messages: [], tools: [] });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(attempts).toBe(1);
    expect(events.map((event) => event.type)).toEqual(['error']);
  });

  test('does not apply Responses request retries to other provider APIs', async () => {
    let attempts = 0;
    const streamFn = createAbortSettledStreamFn((() => {
      attempts += 1;
      return errorStream('OpenAI API error (524): 524 status code (no body)', MODEL);
    }) as StreamFn, { requestRetryDelayMs: () => 0 });

    const stream = streamFn(MODEL, { messages: [], tools: [] });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(attempts).toBe(1);
    expect(events.map((event) => event.type)).toEqual(['error']);
  });

  test('does not treat a 524 as a request failure after the Responses stream starts', async () => {
    let attempts = 0;
    const streamFn = createAbortSettledStreamFn((() => {
      attempts += 1;
      const source = createAssistantMessageEventStream();
      const message = normalizeAssistant(fauxAssistantMessage([], {
        stopReason: 'error',
        errorMessage: 'OpenAI API error (524): 524 status code (no body)',
      }), OPENAI_RESPONSES_MODEL);
      queueMicrotask(() => {
        source.push({ type: 'start', partial: message });
        source.push({ type: 'error', reason: 'error', error: message });
        source.end(message);
      });
      return source;
    }) as StreamFn, { requestRetryDelayMs: () => 0 });

    const stream = streamFn(OPENAI_RESPONSES_MODEL, { messages: [], tools: [] });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(attempts).toBe(1);
    expect(events.map((event) => event.type)).toEqual(['start', 'error']);
  });

  test('does not retry a 524 after material assistant output starts', async () => {
    let attempts = 0;
    const streamFn = createAbortSettledStreamFn((() => {
      attempts += 1;
      const source = createAssistantMessageEventStream();
      const message = normalizeAssistant(fauxAssistantMessage(fauxText('partial answer'), {
        stopReason: 'error',
        errorMessage: 'OpenAI API error (524): 524 status code (no body)',
      }), OPENAI_RESPONSES_MODEL);
      queueMicrotask(() => {
        source.push({ type: 'start', partial: message });
        source.push({ type: 'text_start', contentIndex: 0, partial: message });
        source.push({ type: 'text_delta', contentIndex: 0, delta: 'partial answer', partial: message });
        source.push({ type: 'error', reason: 'error', error: message });
        source.end(message);
      });
      return source;
    }) as StreamFn, { requestRetryDelayMs: () => 0 });

    const stream = streamFn(OPENAI_RESPONSES_MODEL, { messages: [], tools: [] });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(attempts).toBe(1);
    expect(events.map((event) => event.type)).toEqual(['start', 'text_start', 'text_delta', 'error']);
  });

  test('does not retry a 524 after a complete tool call arrives', async () => {
    let attempts = 0;
    const streamFn = createAbortSettledStreamFn((() => {
      attempts += 1;
      const source = createAssistantMessageEventStream();
      const toolCall = fauxToolCall('node_create', { parent_id: 'node:root', outline: '- Done' });
      const message = normalizeAssistant(fauxAssistantMessage([toolCall], {
        stopReason: 'error',
        errorMessage: 'OpenAI API error (524): 524 status code (no body)',
      }), CUSTOM_RESPONSES_MODEL);
      queueMicrotask(() => {
        source.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: message });
        source.push({ type: 'error', reason: 'error', error: message });
        source.end(message);
      });
      return source;
    }) as StreamFn, { requestRetryDelayMs: () => 0 });

    const stream = streamFn(CUSTOM_RESPONSES_MODEL, { messages: [], tools: [] });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(attempts).toBe(1);
    expect(events.map((event) => event.type)).toEqual(['toolcall_end', 'error']);
  });

  test('aborts during request retry backoff without starting another attempt', async () => {
    let attempts = 0;
    const retryPhases: string[] = [];
    let retryDelayStartedResolve: (() => void) | undefined;
    const retryDelayStarted = new Promise<void>((resolve) => {
      retryDelayStartedResolve = resolve;
    });
    const streamFn = createAbortSettledStreamFn((() => {
      attempts += 1;
      return errorStream('OpenAI API error (524): 524 status code (no body)');
    }) as StreamFn, {
      requestRetryDelayMs: () => {
        retryDelayStartedResolve?.();
        return 60_000;
      },
      onProviderRetry: (event) => retryPhases.push(event.phase),
    });
    const upstreamAbort = new AbortController();
    const stream = streamFn(OPENAI_RESPONSES_MODEL, { messages: [], tools: [] }, { signal: upstreamAbort.signal });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();

    await retryDelayStarted;
    upstreamAbort.abort('user stop');
    const event = await next;

    expect(attempts).toBe(1);
    expect(retryPhases).toEqual(['retrying', 'cleared']);
    expect(event.value.type).toBe('error');
    if (event.value.type !== 'error') throw new Error('Expected abort error event.');
    expect(event.value.reason).toBe('aborted');
    expect(event.value.error.errorMessage).toBe('user stop');
    await expect(stream.result()).resolves.toMatchObject({ stopReason: 'aborted' });
  });

  test('keeps request and premature-stream retry budgets independent', async () => {
    let attempts = 0;
    const streamFn = createAbortSettledStreamFn((() => {
      attempts += 1;
      if (attempts === 1) {
        return errorStream('OpenAI API error (524): 524 status code (no body)');
      }
      if (attempts === 2) {
        const source = createAssistantMessageEventStream();
        const partial = normalizeAssistant(fauxAssistantMessage(fauxThinking('working')), OPENAI_RESPONSES_MODEL);
        const error = normalizeAssistant(fauxAssistantMessage(fauxThinking('working'), {
          stopReason: 'error',
          errorMessage: 'OpenAI Responses stream ended before a terminal response event',
        }), OPENAI_RESPONSES_MODEL);
        queueMicrotask(() => {
          source.push({ type: 'start', partial });
          source.push({ type: 'thinking_start', contentIndex: 0, partial });
          source.push({ type: 'thinking_delta', contentIndex: 0, delta: 'working', partial });
          source.push({ type: 'error', reason: 'error', error });
          source.end(error);
        });
        return source;
      }
      return textStream('recovered after both failure classes');
    }) as StreamFn, { requestRetryDelayMs: () => 0 });

    const stream = streamFn(OPENAI_RESPONSES_MODEL, { messages: [], tools: [] });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(attempts).toBe(3);
    expect(events.map((event) => event.type)).toEqual(['start', 'text_start', 'text_delta', 'text_end', 'done']);
    expect(JSON.stringify(events)).not.toContain('working');
    await expect(stream.result()).resolves.toMatchObject({ stopReason: 'stop' });
  });

  test('retries thinking-only OpenAI Responses stream termination once', async () => {
    let attempts = 0;
    const retryEvents: string[] = [];
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
    }) as StreamFn, {
      onProviderRetry: (event) => retryEvents.push(`${event.phase}:${event.kind}:${event.attempt}/${event.maxRetries}`),
    });

    const stream = streamFn(OPENAI_RESPONSES_MODEL, { messages: [], tools: [] });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(attempts).toBe(2);
    expect(retryEvents).toEqual(['retrying:stream:1/1', 'cleared:stream:1/1']);
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

function errorStream(errorMessage: string, model: Model<Api> = OPENAI_RESPONSES_MODEL) {
  const source = createAssistantMessageEventStream();
  const message = normalizeAssistant(fauxAssistantMessage([], {
    stopReason: 'error',
    errorMessage,
  }), model);
  queueMicrotask(() => {
    source.push({ type: 'error', reason: 'error', error: message });
    source.end(message);
  });
  return source;
}

function textStream(text: string, model: Model<Api> = OPENAI_RESPONSES_MODEL) {
  const source = createAssistantMessageEventStream();
  const message = normalizeAssistant(fauxAssistantMessage(fauxText(text)), model);
  queueMicrotask(() => {
    source.push({ type: 'start', partial: message });
    source.push({ type: 'text_start', contentIndex: 0, partial: message });
    source.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
    source.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
    source.push({ type: 'done', reason: 'stop', message });
    source.end(message);
  });
  return source;
}
