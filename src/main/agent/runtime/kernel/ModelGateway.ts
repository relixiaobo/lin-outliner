import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderResponse,
  SimpleStreamOptions,
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
  onPayload?: SimpleStreamOptions['onPayload'];
  onResponse?: (response: ProviderResponse) => void;
}

export class PiModelGateway implements ModelGateway {
  constructor(private readonly hooks: PiModelGatewayOptions = {}) {}

  async stream(request: ModelGatewayRequest): Promise<AssistantMessageEventStream> {
    await this.hooks.onProviderContext?.(request.context);
    return await (this.hooks.streamSimple ?? piStreamSimple)(request.model, request.context, {
      ...request.options,
      maxRetries: 0,
      onPayload: this.hooks.onPayload,
      onResponse: this.hooks.onResponse,
    });
  }
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
