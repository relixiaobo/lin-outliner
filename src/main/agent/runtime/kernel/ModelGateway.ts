import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderResponse,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import {
  createAssistantMessageEventStream,
  isRetryableAssistantError,
} from '@earendil-works/pi-ai';
import { piStreamSimple } from '../../../piModels';
import type { ModelError, StreamFn } from './types';

export interface ModelGatewayRequest {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions;
}

export interface ModelGateway {
  stream(request: ModelGatewayRequest): AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
}

export interface PiModelGatewayOptions {
  streamSimple?: StreamFn;
  onProviderContext?: (context: Context) => void | Promise<void>;
  onProviderAttempt?: () => void | Promise<void>;
  onPayload?: SimpleStreamOptions['onPayload'];
  onResponse?: (response: ProviderResponse) => void;
}

export class PiModelGateway implements ModelGateway {
  constructor(private readonly hooks: PiModelGatewayOptions = {}) {}

  async stream(request: ModelGatewayRequest): Promise<AssistantMessageEventStream> {
    await this.hooks.onProviderContext?.(request.context);
    const streamSimple = this.hooks.streamSimple ?? piStreamSimple;
    const streamOptions = {
      ...request.options,
      maxRetries: 0,
      onPayload: this.hooks.onPayload,
      onResponse: this.hooks.onResponse,
    };
    const openStream = async (context: Context, options: SimpleStreamOptions) => {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Provider request aborted');
      await this.hooks.onProviderAttempt?.();
      return streamSimple(request.model, context, options);
    };
    if (!hasSignedThinking(request.context)) {
      return await openStream(request.context, streamOptions);
    }

    let payloadPrepared = false;
    const source = await openStream(request.context, {
      ...streamOptions,
      onPayload: async (payload, model) => {
        payloadPrepared = true;
        return await this.hooks.onPayload?.(payload, model);
      },
    });
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        const shouldRetry = await forwardProviderStream(source, output, () => !payloadPrepared);
        if (!shouldRetry) return;
        const fallback = await openStream(
          withoutSignedThinking(request.context),
          streamOptions,
        );
        await forwardProviderStream(fallback, output, () => false);
      } catch (error) {
        const failure = providerPreparationFailure(request.model, error);
        output.push(failure);
        output.end(failure.error);
      }
    })();
    return output;
  }
}

function hasSignedThinking(context: Context): boolean {
  return context.messages.some((message) => message.role === 'assistant'
    && message.content.some((part) => part.type === 'thinking' && Boolean(part.thinkingSignature)));
}

function withoutSignedThinking(context: Context): Context {
  return {
    ...context,
    messages: context.messages.map((message) => message.role === 'assistant'
      ? {
          ...message,
          content: message.content.filter((part) => (
            part.type !== 'thinking' || !part.thinkingSignature
          )),
        }
      : message),
  };
}

async function forwardProviderStream(
  source: AssistantMessageEventStream,
  output: AssistantMessageEventStream,
  shouldDropPreparationError: () => boolean,
): Promise<boolean> {
  let finalMessage: AssistantMessage | undefined;
  for await (const event of source) {
    if (event.type === 'error' && shouldDropPreparationError()) return true;
    if (event.type === 'done') finalMessage = event.message;
    if (event.type === 'error') finalMessage = event.error;
    output.push(event);
  }
  output.end(finalMessage);
  return false;
}

function providerPreparationFailure(
  model: Model<Api>,
  error: unknown,
): Extract<AssistantMessageEvent, { type: 'error' }> {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
  return { type: 'error', reason: 'error', error: message };
}

const RESPONSES_API_STATUS_RE = /\b(?:Azure )?OpenAI API error \((\d{3})\):/i;
const RETRYABLE_RESPONSES_TRANSPORT_RE = /\b(?:connection error|request timed out|failed to fetch|fetch failed|network error|socket hang up|socket connection (?:was )?closed|connection reset|econnreset|etimedout|econnaborted|epipe|und_err_socket|err_connection_reset|err_network_changed)\b/i;
const CONTEXT_OVERFLOW_RE = /\bcontext[_ -]?length[_ -]?exceeded\b|\bmaximum context length\b|\bcontext window(?: limit)? (?:is )?(?:exceeded|too (?:large|small))\b|\bprompt is too long\b|\binput (?:token count )?(?:is )?too long\b|\btoo many (?:input )?tokens\b|\btoken count exceeds (?:the )?(?:model['’]?s )?maximum\b/i;

export function classifyModelFailure(message: AssistantMessage): ModelError | null {
  if (message.stopReason === 'aborted') {
    return { kind: 'aborted', message: message.errorMessage ?? 'Aborted' };
  }
  if (message.stopReason !== 'error') return null;
  return classifyErrorMessage(message.errorMessage ?? 'Model request failed');
}

export function isRetryableProviderFailure(message: AssistantMessage): boolean {
  return isRetryableAssistantError(message);
}

function classifyErrorMessage(errorMessage: string): ModelError {
  const statusMatch = RESPONSES_API_STATUS_RE.exec(errorMessage);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 429) return { kind: 'rateLimit', status, message: errorMessage };
    if (status >= 500 && status <= 599) return { kind: 'serverError', status, message: errorMessage };
  }
  if (CONTEXT_OVERFLOW_RE.test(errorMessage)) {
    return { kind: 'contextOverflow', message: errorMessage };
  }
  if (statusMatch) return { kind: 'badRequest', status: Number(statusMatch[1]), message: errorMessage };
  if (RETRYABLE_RESPONSES_TRANSPORT_RE.test(errorMessage)) {
    return { kind: 'transport', message: errorMessage };
  }
  return { kind: 'badRequest', message: errorMessage };
}

export function isRetryableResponsesRequestError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const failure = classifyErrorMessage(errorMessage);
  return failure?.kind === 'rateLimit'
    || failure?.kind === 'serverError'
    || failure?.kind === 'transport';
}
