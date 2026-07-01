import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { isCustomOpenAIResponsesEndpoint } from './openAIResponsesCompat';

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

export function createAbortSettledStreamFn(sourceFn: StreamFn): StreamFn {
  return ((model, context, options = {}) => {
    const abortCtrl = new AbortController();
    const signal = chainAbortSignals(options.signal, abortCtrl);
    let source: Promise<AssistantMessageEventStream>;
    try {
      source = Promise.resolve(sourceFn(model, context, {
        ...options,
        signal,
      }));
    } catch (error) {
      source = Promise.reject(error);
    }
    return wrapStreamWithAbortSettling(source, { abortCtrl, model });
  }) as StreamFn;
}

export function wrapStreamWithAbortSettling(
  sourceInput: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  { abortCtrl, model }: { abortCtrl: AbortController; model: Model<Api> },
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  let latestPartial: AssistantMessage | null = null;
  let settled = false;

  const settleWithTerminalMessage = (message: AssistantMessage, reason: 'aborted' | 'error') => {
    if (settled) return;
    const salvage = salvageTerminatedCustomResponsesToolUse(message, model, reason);
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
    try {
      const source = await sourceInput;
      for await (const event of source) {
        if (settled) break;
        if ('partial' in event) latestPartial = event.partial;
        if (event.type === 'error') {
          const salvage = salvageTerminatedCustomResponsesToolUse(event.error, model, event.reason);
          if (salvage) {
            settled = true;
            out.push({ type: 'done', reason: 'toolUse', message: salvage });
            out.end(salvage);
            break;
          }
          settled = true;
        } else if (event.type === 'done') {
          settled = true;
        }
        out.push(event);
      }
      if (!settled) {
        settled = true;
        out.end(await source.result());
      }
    } catch (error) {
      if (settled) return;
      const message = buildTerminalAssistantMessage(
        model,
        error instanceof Error ? error.message : String(error),
        abortCtrl.signal.aborted ? 'aborted' : 'error',
        latestPartial,
      );
      settleWithTerminalMessage(message, message.stopReason === 'aborted' ? 'aborted' : 'error');
    } finally {
      abortCtrl.signal.removeEventListener('abort', handleAbort);
    }
  })();

  return out;
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
): AssistantMessage | null {
  if (reason !== 'error') return null;
  if (!isCustomOpenAIResponsesEndpoint(model)) return null;
  if (!isTerminatedResponsesStreamError(message.errorMessage)) return null;
  const hasToolCall = message.content.some((part) => part.type === 'toolCall');
  if (!hasToolCall) return null;
  const { errorMessage: _errorMessage, ...rest } = message;
  return {
    ...rest,
    stopReason: 'toolUse',
  };
}

function isTerminatedResponsesStreamError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return lower === 'terminated'
    || lower.includes('stream ended before a terminal response event')
    || lower.includes('terminated while');
}
