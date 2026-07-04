import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { isCustomOpenAIResponsesEndpoint } from './openAIResponsesCompat';

type AssistantToolCall = Extract<AssistantMessage['content'][number], { type: 'toolCall' }>;

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

const MAX_RETRYABLE_RESPONSES_TERMINATIONS = 1;

export function createAbortSettledStreamFn(sourceFn: StreamFn): StreamFn {
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
    return wrapStreamWithAbortSettling(startSource(), { abortCtrl, model, retrySource: startSource });
  }) as StreamFn;
}

type AbortSettlingOptions = {
  abortCtrl: AbortController;
  model: Model<Api>;
  retrySource?: () => Promise<AssistantMessageEventStream>;
};

export function wrapStreamWithAbortSettling(
  sourceInput: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  { abortCtrl, model, retrySource }: AbortSettlingOptions,
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  let latestPartial: AssistantMessage | null = null;
  const completedToolCallIds = new Set<string>();
  let settled = false;
  const maxRetries = retrySource && isOpenAIResponsesModel(model) ? MAX_RETRYABLE_RESPONSES_TERMINATIONS : 0;

  const settleWithTerminalMessage = (message: AssistantMessage, reason: 'aborted' | 'error') => {
    if (settled) return;
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
    let retryCount = 0;
    try {
      while (!settled) {
        const outcome = await consumeSourceAttempt(source, retryCount);
        if (outcome !== 'retry') break;
        retryCount += 1;
        source = retrySource?.() ?? source;
      }
    } finally {
      abortCtrl.signal.removeEventListener('abort', handleAbort);
    }
  })();

  async function consumeSourceAttempt(
    sourceInputAttempt: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
    retryCount: number,
  ): Promise<'settled' | 'retry'> {
    let bufferedEvents: AssistantMessageEvent[] = [];
    let flushed = false;
    let sawMaterialOutput = false;

    const flushBufferedEvents = () => {
      if (flushed) return;
      flushed = true;
      for (const bufferedEvent of bufferedEvents) out.push(bufferedEvent);
      bufferedEvents = [];
    };

    const pushNonTerminalEvent = (event: AssistantMessageEvent) => {
      if (shouldBufferBeforeRetryDecision(event, retryCount, maxRetries, flushed, sawMaterialOutput)) {
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
            flushBufferedEvents();
            settled = true;
            out.push({ type: 'done', reason: 'toolUse', message: salvage });
            out.end(salvage);
            break;
          }
          if (canRetryTerminatedResponsesStream(event.error, event.reason, retryCount, maxRetries, sawMaterialOutput, completedToolCallIds)) {
            return 'retry';
          }
          flushBufferedEvents();
          settled = true;
        } else if (event.type === 'done') {
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
        if (canRetryTerminatedResponsesStream(
          result,
          result.stopReason === 'aborted' ? 'aborted' : 'error',
          retryCount,
          maxRetries,
          sawMaterialOutput,
          completedToolCallIds,
        )) {
          return 'retry';
        }
        flushBufferedEvents();
        settled = true;
        out.end(result);
      }
    } catch (error) {
      if (settled) return 'settled';
      const message = buildTerminalAssistantMessage(
        model,
        error instanceof Error ? error.message : String(error),
        abortCtrl.signal.aborted ? 'aborted' : 'error',
        latestPartial,
      );
      if (canRetryTerminatedResponsesStream(
        message,
        message.stopReason === 'aborted' ? 'aborted' : 'error',
        retryCount,
        maxRetries,
        sawMaterialOutput,
        completedToolCallIds,
      )) {
        return 'retry';
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

function canRetryTerminatedResponsesStream(
  message: AssistantMessage,
  reason: 'aborted' | 'error',
  retryCount: number,
  maxRetries: number,
  sawMaterialOutput: boolean,
  completedToolCallIds: ReadonlySet<string>,
): boolean {
  return retryCount < maxRetries
    && reason === 'error'
    && !sawMaterialOutput
    && completedToolCallIds.size === 0
    && isTerminatedResponsesStreamError(message.errorMessage);
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
