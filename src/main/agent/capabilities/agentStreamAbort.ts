import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { isCustomOpenAIResponsesEndpoint } from '../../openAIResponsesCompat';

type AssistantToolCall = Extract<AssistantMessage['content'][number], { type: 'toolCall' }>;
type RetryOutcome = 'settled' | 'retry-request' | 'retry-stream';
type RequestRetryDelayMs = (retryCount: number) => number;

export interface ProviderRetryLifecycleEvent {
  phase: 'retrying' | 'cleared';
  kind: 'request' | 'stream';
  attempt: number;
  maxRetries: number;
}

type ProviderRetryLifecycleHandler = (event: ProviderRetryLifecycleEvent) => void;

const EMPTY_USAGE = {
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

const MAX_RETRYABLE_RESPONSES_REQUEST_FAILURES = 4;
const MAX_RETRYABLE_RESPONSES_TERMINATIONS = 1;
const RESPONSES_REQUEST_RETRY_INITIAL_DELAY_MS = 200;
const RESPONSES_REQUEST_RETRY_JITTER = 0.1;
const RESPONSES_API_STATUS_RE = /\b(?:Azure )?OpenAI API error \((\d{3})\):/i;
const RETRYABLE_RESPONSES_TRANSPORT_RE = /\b(?:connection error|request timed out|failed to fetch|fetch failed|network error|socket hang up|socket connection (?:was )?closed|connection reset|econnreset|etimedout|econnaborted|epipe|und_err_socket|err_connection_reset|err_network_changed)\b/i;

export function createAbortSettledStreamFn(
  sourceFn: StreamFn,
  retryOptions: {
    requestRetryDelayMs?: RequestRetryDelayMs;
    onProviderRetry?: ProviderRetryLifecycleHandler;
  } = {},
): StreamFn {
  return ((model, context, options = {}) => {
    const abortCtrl = new AbortController();
    const signal = chainAbortSignals(options.signal, abortCtrl);
    const startSource = () => {
      try {
        return Promise.resolve(sourceFn(model, context, {
          ...options,
          signal,
        }));
      } catch (error) {
        return Promise.reject(error);
      }
    };
    return wrapStreamWithAbortSettling(startSource(), {
      abortCtrl,
      model,
      retrySource: startSource,
      requestRetryDelayMs: retryOptions.requestRetryDelayMs,
      onProviderRetry: retryOptions.onProviderRetry,
    });
  }) as StreamFn;
}

type AbortSettlingOptions = {
  abortCtrl: AbortController;
  model: Model<Api>;
  retrySource?: () => Promise<AssistantMessageEventStream>;
  requestRetryDelayMs?: RequestRetryDelayMs;
  onProviderRetry?: ProviderRetryLifecycleHandler;
};

export function wrapStreamWithAbortSettling(
  sourceInput: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  {
    abortCtrl,
    model,
    retrySource,
    requestRetryDelayMs = responsesRequestRetryDelayMs,
    onProviderRetry,
  }: AbortSettlingOptions,
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  let latestPartial: AssistantMessage | null = null;
  const completedToolCallIds = new Set<string>();
  let settled = false;
  const canRetryResponses = Boolean(retrySource) && isOpenAIResponsesModel(model);
  const maxRequestRetries = canRetryResponses ? MAX_RETRYABLE_RESPONSES_REQUEST_FAILURES : 0;
  const maxStreamRetries = canRetryResponses ? MAX_RETRYABLE_RESPONSES_TERMINATIONS : 0;
  let activeRetryStatus: Omit<ProviderRetryLifecycleEvent, 'phase'> | null = null;

  const emitProviderRetry = (event: ProviderRetryLifecycleEvent) => {
    try {
      onProviderRetry?.(event);
    } catch {
      // Observability must never change provider stream behavior.
    }
  };

  const showProviderRetry = (kind: ProviderRetryLifecycleEvent['kind'], attempt: number, maxRetries: number) => {
    activeRetryStatus = { kind, attempt, maxRetries };
    emitProviderRetry({ phase: 'retrying', ...activeRetryStatus });
  };

  const clearProviderRetry = () => {
    if (!activeRetryStatus) return;
    const status = activeRetryStatus;
    activeRetryStatus = null;
    emitProviderRetry({ phase: 'cleared', ...status });
  };

  const settleWithTerminalMessage = (message: AssistantMessage, reason: 'aborted' | 'error') => {
    if (settled) return;
    clearProviderRetry();
    const salvage = salvageTerminatedCustomResponsesToolUse(message, model, reason, completedToolCallIds);
    if (salvage) {
      settled = true;
      out.push({ type: 'done', reason: 'toolUse', message: salvage });
      out.end(salvage);
      return;
    }
    settled = true;
    out.push({ type: 'error', reason, error: message });
    out.end(message);
  };

  const handleAbort = () => {
    const message = buildTerminalAssistantMessage(
      model,
      abortMessage(abortCtrl.signal.reason),
      'aborted',
      latestPartial,
    );
    settleWithTerminalMessage(message, 'aborted');
  };

  if (abortCtrl.signal.aborted) {
    handleAbort();
  } else {
    abortCtrl.signal.addEventListener('abort', handleAbort, { once: true });
  }

  void (async () => {
    let source = Promise.resolve(sourceInput);
    let requestRetryCount = 0;
    let streamRetryCount = 0;
    try {
      while (!settled) {
        const outcome = await consumeSourceAttempt(source, requestRetryCount, streamRetryCount);
        if (outcome === 'settled') break;
        if (outcome === 'retry-request') {
          requestRetryCount += 1;
          showProviderRetry('request', requestRetryCount, maxRequestRetries);
          await waitForAbortableDelay(requestRetryDelayMs(requestRetryCount), abortCtrl.signal);
          if (settled || abortCtrl.signal.aborted) break;
        } else {
          streamRetryCount += 1;
          showProviderRetry('stream', streamRetryCount, maxStreamRetries);
        }
        source = retrySource?.() ?? source;
      }
    } catch (error) {
      if (!settled) {
        const reason = abortCtrl.signal.aborted ? 'aborted' : 'error';
        const errorMessage = reason === 'aborted'
          ? abortMessage(abortCtrl.signal.reason)
          : thrownErrorMessage(error);
        settleWithTerminalMessage(buildTerminalAssistantMessage(
          model,
          errorMessage,
          reason,
          latestPartial,
        ), reason);
      }
    } finally {
      abortCtrl.signal.removeEventListener('abort', handleAbort);
    }
  })();

  async function consumeSourceAttempt(
    sourceInputAttempt: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
    requestRetryCount: number,
    streamRetryCount: number,
  ): Promise<RetryOutcome> {
    let bufferedEvents: AssistantMessageEvent[] = [];
    let flushed = false;
    let sawStreamEvent = false;
    let sawMaterialOutput = false;

    const flushBufferedEvents = () => {
      if (flushed) return;
      flushed = true;
      for (const bufferedEvent of bufferedEvents) out.push(bufferedEvent);
      bufferedEvents = [];
    };

    const pushNonTerminalEvent = (event: AssistantMessageEvent) => {
      clearProviderRetry();
      sawStreamEvent = true;
      if (shouldBufferBeforeRetryDecision(event, streamRetryCount, maxStreamRetries, flushed, sawMaterialOutput)) {
        bufferedEvents.push(event);
        return;
      }
      if (isMaterialStreamEvent(event)) {
        sawMaterialOutput = true;
        flushBufferedEvents();
      }
      if (!flushed && bufferedEvents.length > 0) flushBufferedEvents();
      out.push(event);
    };

    try {
      const source = await sourceInputAttempt;
      completedToolCallIds.clear();
      latestPartial = null;
      for await (const event of source) {
        if (settled) break;
        if ('partial' in event) latestPartial = event.partial;
        if (event.type === 'toolcall_end') completedToolCallIds.add(event.toolCall.id);
        if (event.type === 'error') {
          const salvage = salvageTerminatedCustomResponsesToolUse(event.error, model, event.reason, completedToolCallIds);
          if (salvage) {
            clearProviderRetry();
            flushBufferedEvents();
            settled = true;
            out.push({ type: 'done', reason: 'toolUse', message: salvage });
            out.end(salvage);
            break;
          }
          const retry = retryOutcomeForResponsesError(
            event.error,
            event.reason,
            requestRetryCount,
            maxRequestRetries,
            streamRetryCount,
            maxStreamRetries,
            sawStreamEvent,
            sawMaterialOutput,
            completedToolCallIds,
          );
          if (retry) {
            return retry;
          }
          clearProviderRetry();
          flushBufferedEvents();
          settled = true;
        } else if (event.type === 'done') {
          clearProviderRetry();
          flushBufferedEvents();
          settled = true;
        }
        if (event.type === 'error' || event.type === 'done') {
          out.push(event);
        } else {
          pushNonTerminalEvent(event);
        }
      }
      if (!settled) {
        const result = await source.result();
        const retry = retryOutcomeForResponsesError(
          result,
          result.stopReason === 'aborted' ? 'aborted' : 'error',
          requestRetryCount,
          maxRequestRetries,
          streamRetryCount,
          maxStreamRetries,
          sawStreamEvent,
          sawMaterialOutput,
          completedToolCallIds,
        );
        if (retry) {
          return retry;
        }
        clearProviderRetry();
        flushBufferedEvents();
        settled = true;
        out.end(result);
      }
    } catch (error) {
      if (settled) return 'settled';
      const message = buildTerminalAssistantMessage(
        model,
        thrownErrorMessage(error),
        abortCtrl.signal.aborted ? 'aborted' : 'error',
        latestPartial,
      );
      const retry = retryOutcomeForResponsesError(
        message,
        message.stopReason === 'aborted' ? 'aborted' : 'error',
        requestRetryCount,
        maxRequestRetries,
        streamRetryCount,
        maxStreamRetries,
        sawStreamEvent,
        sawMaterialOutput,
        completedToolCallIds,
      );
      if (retry) {
        return retry;
      }
      flushBufferedEvents();
      settleWithTerminalMessage(message, message.stopReason === 'aborted' ? 'aborted' : 'error');
    }
    return 'settled';
  }

  return out;
}

function shouldBufferBeforeRetryDecision(
  event: AssistantMessageEvent,
  retryCount: number,
  maxRetries: number,
  flushed: boolean,
  sawMaterialOutput: boolean,
): boolean {
  return retryCount < maxRetries
    && !flushed
    && !sawMaterialOutput
    && (event.type === 'start' || event.type === 'thinking_start' || event.type === 'thinking_delta' || event.type === 'thinking_end');
}

function isMaterialStreamEvent(event: AssistantMessageEvent): boolean {
  return event.type === 'text_start'
    || event.type === 'text_delta'
    || event.type === 'text_end'
    || event.type === 'toolcall_start'
    || event.type === 'toolcall_delta'
    || event.type === 'toolcall_end';
}

function retryOutcomeForResponsesError(
  message: AssistantMessage,
  reason: 'aborted' | 'error',
  requestRetryCount: number,
  maxRequestRetries: number,
  streamRetryCount: number,
  maxStreamRetries: number,
  sawStreamEvent: boolean,
  sawMaterialOutput: boolean,
  completedToolCallIds: ReadonlySet<string>,
): Exclude<RetryOutcome, 'settled'> | null {
  if (reason !== 'error' || sawMaterialOutput || completedToolCallIds.size > 0) return null;
  if (!sawStreamEvent
    && requestRetryCount < maxRequestRetries
    && isRetryableResponsesRequestError(message.errorMessage)) {
    return 'retry-request';
  }
  if (streamRetryCount < maxStreamRetries && isTerminatedResponsesStreamError(message.errorMessage)) {
    return 'retry-stream';
  }
  return null;
}

export function isRetryableResponsesRequestError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const statusMatch = RESPONSES_API_STATUS_RE.exec(errorMessage);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return status >= 500 && status <= 599;
  }
  return RETRYABLE_RESPONSES_TRANSPORT_RE.test(errorMessage);
}

export function responsesRequestRetryDelayMs(
  retryCount: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.floor(retryCount) - 1);
  const baseDelay = RESPONSES_REQUEST_RETRY_INITIAL_DELAY_MS * (2 ** exponent);
  const jitter = 1 - RESPONSES_REQUEST_RETRY_JITTER + random() * RESPONSES_REQUEST_RETRY_JITTER * 2;
  return Math.round(baseDelay * jitter);
}

async function waitForAbortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delayMs);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function chainAbortSignals(upstream: AbortSignal | undefined, local: AbortController): AbortSignal {
  if (!upstream) return local.signal;
  if (upstream.aborted) {
    if (!local.signal.aborted) local.abort(upstream.reason);
    return local.signal;
  }
  upstream.addEventListener('abort', () => {
    if (!local.signal.aborted) local.abort(upstream.reason);
  }, { once: true });
  return local.signal;
}

function buildTerminalAssistantMessage(
  model: Model<Api>,
  errorMessage: string,
  stopReason: 'aborted' | 'error',
  partial?: AssistantMessage | null,
): AssistantMessage {
  return {
    ...partial,
    role: 'assistant',
    content: partial?.content ?? [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: partial?.usage ?? EMPTY_USAGE,
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

function abortMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  return 'Aborted';
}

function thrownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function salvageTerminatedCustomResponsesToolUse(
  message: AssistantMessage,
  model: Model<Api>,
  reason: 'aborted' | 'error',
  completedToolCallIds: ReadonlySet<string>,
): AssistantMessage | null {
  if (reason !== 'error') return null;
  if (!isCustomOpenAIResponsesEndpoint(model)) return null;
  if (!isTerminatedResponsesStreamError(message.errorMessage)) return null;
  const toolCalls = message.content.filter(isToolCall);
  if (toolCalls.length === 0) return null;
  if (!toolCalls.every((toolCall) => completedToolCallIds.has(toolCall.id))) return null;
  const { errorMessage: _errorMessage, ...rest } = message;
  return {
    ...rest,
    stopReason: 'toolUse',
  };
}

function isToolCall(part: AssistantMessage['content'][number]): part is AssistantToolCall {
  return part.type === 'toolCall';
}

function isOpenAIResponsesModel(model: Model<Api>): boolean {
  return model.api === 'openai-responses' || model.api === 'azure-openai-responses';
}

function isTerminatedResponsesStreamError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return lower === 'terminated'
    || lower.includes('stream ended before a terminal response event')
    || lower.includes('terminated while');
}
