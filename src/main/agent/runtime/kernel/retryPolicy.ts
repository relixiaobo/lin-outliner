import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Message,
  type Model,
} from '@earendil-works/pi-ai';
import { isCustomOpenAIResponsesEndpoint } from '../../../openAIResponsesCompat';
import { classifyModelFailure, isRetryableProviderFailure } from './ModelGateway';
import {
  EMPTY_USAGE,
  type ProviderRetryLifecycleEvent,
  type RetryPolicyOptions,
} from './types';

type AssistantToolCall = Extract<AssistantMessage['content'][number], { type: 'toolCall' }>;
type RetryOutcome = 'settled' | 'retry-request' | 'retry-stream' | 'retry-overflow';

const MAX_RETRYABLE_RESPONSES_REQUEST_FAILURES = 5;
const MAX_RETRYABLE_RESPONSES_TERMINATIONS = 1;
const MAX_RETRYABLE_CUSTOM_RESPONSES_STREAM_ERRORS = 3;
const RESPONSES_REQUEST_RETRY_INITIAL_DELAY_MS = 200;
const RESPONSES_REQUEST_RETRY_JITTER = 0.1;
const RETRYABLE_CUSTOM_RESPONSES_STREAM_ERROR_RE = /\bstream_read_error\b|\bstream idle timeout\b/i;

type StreamWithPolicyInput = RetryPolicyOptions & {
  model: Model<Api>;
  attempt: (messages: Message[] | null, signal: AbortSignal) => AssistantMessageEventStream
    | Promise<AssistantMessageEventStream>;
  recoverContextOverflow?: (errorMessage: string) => Promise<readonly Message[] | null>;
  signal?: AbortSignal;
};

export function streamWithPolicy(input: StreamWithPolicyInput): AssistantMessageEventStream {
  const abortCtrl = new AbortController();
  const signal = chainAbortSignals(input.signal, abortCtrl);
  let refreshedMessages: Message[] | null = null;
  const startSource = () => {
    try {
      return Promise.resolve(input.attempt(refreshedMessages, signal));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return wrapStreamWithAbortSettling(startSource(), {
    abortCtrl,
    model: input.model,
    retrySource: startSource,
    requestRetryDelayMs: input.requestRetryDelayMs,
    onProviderRetry: input.onProviderRetry,
    maxRequestRetries: input.maxRequestRetries,
    maxStreamRetries: input.maxStreamRetries,
    maxRetryDelayMs: input.maxRetryDelayMs,
    retryContextOnOverflow: input.recoverContextOverflow
      ? async (errorMessage) => {
          const messages = await input.recoverContextOverflow!(errorMessage);
          if (!messages) return false;
          refreshedMessages = [...messages];
          return true;
        }
      : undefined,
  });
}

type AbortSettlingOptions = RetryPolicyOptions & {
  abortCtrl: AbortController;
  model: Model<Api>;
  retrySource?: () => Promise<AssistantMessageEventStream>;
  retryContextOnOverflow?: (errorMessage: string) => Promise<boolean>;
};

export function wrapStreamWithAbortSettling(
  sourceInput: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  {
    abortCtrl,
    model,
    retrySource,
    requestRetryDelayMs: configuredRequestRetryDelayMs,
    onProviderRetry,
    maxRequestRetries: configuredMaxRequestRetries,
    maxStreamRetries: configuredMaxStreamRetries,
    maxRetryDelayMs,
    retryContextOnOverflow,
  }: AbortSettlingOptions,
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  let latestPartial: AssistantMessage | null = null;
  const completedToolCallIds = new Set<string>();
  let settled = false;
  const canRetryResponses = Boolean(retrySource) && isOpenAIResponsesModel(model);
  const maxRequestRetries = canRetryResponses
    ? normalizedRetryLimit(configuredMaxRequestRetries, MAX_RETRYABLE_RESPONSES_REQUEST_FAILURES)
    : 0;
  const maxStreamRetries = canRetryResponses
    ? normalizedRetryLimit(
        configuredMaxStreamRetries,
        isCustomOpenAIResponsesEndpoint(model)
          ? MAX_RETRYABLE_CUSTOM_RESPONSES_STREAM_ERRORS
          : MAX_RETRYABLE_RESPONSES_TERMINATIONS,
      )
    : 0;
  const requestRetryDelayMs = configuredRequestRetryDelayMs ?? ((retryCount: number) => {
    const delay = responsesRequestRetryDelayMs(retryCount);
    return maxRetryDelayMs === undefined || maxRetryDelayMs === 0
      ? delay
      : Math.min(delay, maxRetryDelayMs);
  });
  const canRetryOverflow = Boolean(retrySource && retryContextOnOverflow);
  let activeRetryStatus: Omit<ProviderRetryLifecycleEvent, 'phase'> | null = null;
  let pendingOverflowMessage: AssistantMessage | null = null;

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
    let overflowRetryCount = 0;
    try {
      while (!settled) {
        const outcome = await consumeSourceAttempt(
          source,
          requestRetryCount,
          streamRetryCount,
          overflowRetryCount,
        );
        if (outcome === 'settled') break;
        if (outcome === 'retry-overflow') {
          const overflow = pendingOverflowMessage as AssistantMessage | null;
          pendingOverflowMessage = null;
          if (!overflow) throw new Error('Context-overflow retry lost its provider error.');
          clearProviderRetry();
          overflowRetryCount += 1;
          const recovered = await retryContextOnOverflow?.(overflow.errorMessage ?? 'Provider context overflow');
          if (!recovered) {
            settleWithTerminalMessage(contextOverflowFailure(overflow, false), 'error');
            break;
          }
        } else if (outcome === 'retry-request') {
          requestRetryCount += 1;
          showProviderRetry('request', requestRetryCount, maxRequestRetries);
          await waitForAbortableDelay(requestRetryDelayMs(requestRetryCount), abortCtrl.signal);
          if (settled || abortCtrl.signal.aborted) break;
        } else {
          streamRetryCount += 1;
          showProviderRetry('stream', streamRetryCount, maxStreamRetries);
          await waitForAbortableDelay(requestRetryDelayMs(streamRetryCount), abortCtrl.signal);
          if (settled || abortCtrl.signal.aborted) break;
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
    overflowRetryCount: number,
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

    const contextOverflowOutcome = (
      message: AssistantMessage,
      reason: 'aborted' | 'error',
    ): RetryOutcome | null => {
      if (
        reason !== 'error'
        || sawMaterialOutput
        || completedToolCallIds.size > 0
        || classifyModelFailure(message)?.kind !== 'contextOverflow'
      ) return null;
      if (canRetryOverflow && overflowRetryCount === 0) {
        pendingOverflowMessage = message;
        return 'retry-overflow';
      }
      if (overflowRetryCount > 0) {
        bufferedEvents = [];
        settleWithTerminalMessage(contextOverflowFailure(message, true), 'error');
        return 'settled';
      }
      return null;
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
          const overflow = contextOverflowOutcome(event.error, event.reason);
          if (overflow) return overflow;
          const retry = retryOutcomeForResponsesError(
            event.error,
            event.reason,
            model,
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
        const overflow = contextOverflowOutcome(
          result,
          result.stopReason === 'aborted' ? 'aborted' : 'error',
        );
        if (overflow) return overflow;
        const retry = retryOutcomeForResponsesError(
          result,
          result.stopReason === 'aborted' ? 'aborted' : 'error',
          model,
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
      const overflow = contextOverflowOutcome(
        message,
        message.stopReason === 'aborted' ? 'aborted' : 'error',
      );
      if (overflow) return overflow;
      const retry = retryOutcomeForResponsesError(
        message,
        message.stopReason === 'aborted' ? 'aborted' : 'error',
        model,
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
  model: Model<Api>,
  requestRetryCount: number,
  maxRequestRetries: number,
  streamRetryCount: number,
  maxStreamRetries: number,
  sawStreamEvent: boolean,
  sawMaterialOutput: boolean,
  completedToolCallIds: ReadonlySet<string>,
): Exclude<RetryOutcome, 'settled' | 'retry-overflow'> | null {
  if (reason !== 'error' || completedToolCallIds.size > 0) return null;
  if (sawMaterialOutput && !isCustomOpenAIResponsesEndpoint(model)) return null;
  if (!sawStreamEvent && isRetryableProviderFailure(message)) {
    return requestRetryCount < maxRequestRetries ? 'retry-request' : null;
  }
  if (streamRetryCount < maxStreamRetries && isRetryableResponsesStreamError(message, model)) {
    return 'retry-stream';
  }
  return null;
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

function normalizedRetryLimit(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Math.max(0, Math.floor(value));
}

function contextOverflowFailure(message: AssistantMessage, exhausted: boolean): AssistantMessage {
  const prefix = exhausted
    ? 'Provider context overflow persisted after one canonical compaction retry.'
    : 'Provider rejected the canonical context as too large, but no eligible context could be compacted.';
  return {
    ...message,
    stopReason: 'error',
    errorMessage: `${prefix}${message.errorMessage ? ` ${message.errorMessage}` : ''}`,
  };
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
  if (!isTerminatedResponsesStreamError(message)) return null;
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

function isRetryableResponsesStreamError(message: AssistantMessage, model: Model<Api>): boolean {
  if (!isCustomOpenAIResponsesEndpoint(model)) {
    return isTerminatedResponsesStreamError(message);
  }
  const failure = classifyModelFailure(message);
  if (failure?.kind === 'contextOverflow' || failure?.kind === 'aborted') return false;
  if (
    failure?.status !== undefined
    && failure.status >= 400
    && failure.status < 500
    && failure.status !== 429
  ) return false;
  if (isRetryableProviderFailure(message)) {
    return true;
  }
  return isTerminatedResponsesStreamError(message)
    || RETRYABLE_CUSTOM_RESPONSES_STREAM_ERROR_RE.test(message.errorMessage ?? '');
}

function isTerminatedResponsesStreamError(message: AssistantMessage): boolean {
  const lower = message.errorMessage?.toLowerCase();
  return lower === 'terminated'
    || Boolean(lower?.includes('stream ended before a terminal response event'))
    || Boolean(lower?.includes('terminated while'));
}
