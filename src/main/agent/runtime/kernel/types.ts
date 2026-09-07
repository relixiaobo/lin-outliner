import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  Tool,
  ToolResultMessage,
  Usage,
} from '@earendil-works/pi-ai';
import type { Static, TSchema } from 'typebox';
import type { JsonValue, ModelToolIdentity, ThreadResourceReference, TurnError } from '../../../../core/agent/protocol';
import type { ModelGateway } from './ModelGateway';
import type {
  ToolCallAdmissionDecision,
  ToolCallAdmissionRequest,
} from '../toolCallHistory';

export type {
  Api,
  AssistantImages,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  ImagesContext,
  Message,
  Model,
  ProviderResponse,
  SimpleStreamOptions,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai';

export type StreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export type ToolExecutionMode = 'sequential' | 'parallel';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AgentMessage = Message;
export type AgentToolCall = Extract<AssistantMessage['content'][number], { type: 'toolCall' }>;

export const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface AgentToolResultBase<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  terminate?: boolean;
  /** Host-only durable artifact manifest; never copied into the provider ToolResultMessage. */
  resourceRefs?: readonly ThreadResourceReference[];
  /** Host-only substitutions applied only when the tool result enters durable history. */
  persistedTextReplacements?: readonly AgentToolTextReplacement[];
}

export interface NativeAgentToolResult<T> extends AgentToolResultBase<T> {
  readonly kind: 'native';
}

export type TenonToolOutcome =
  | { readonly ok: true; readonly status?: 'unchanged' | 'partial' }
  | {
      readonly ok: false;
      readonly status?: 'denied';
      readonly error: { readonly code: string; readonly message: string };
    };

/** Host-owned semantic result. The Kernel is the only model-visible compiler. */
export interface TenonAgentToolResult<T> extends AgentToolResultBase<T> {
  readonly kind: 'tenon';
  readonly outcome: TenonToolOutcome;
  readonly data?: JsonValue;
  readonly instructions?: string;
  readonly warnings?: readonly string[];
}

export type AgentToolResult<T> = NativeAgentToolResult<T> | TenonAgentToolResult<T>;

export interface AgentToolTextReplacement {
  readonly value: string;
  readonly replacement: string;
}

export interface AgentToolLargeTextBinding {
  readonly kind: 'internalText';
  readonly path: string;
  readonly maxBytes: number;
  readonly historyPolicy: 'secretScanText';
}

export interface AgentToolLargeTextArguments {
  readonly maxBindings: number;
  readonly maxAggregateBytes: number;
  readonly select: (canonicalArguments: JsonValue) => readonly AgentToolLargeTextBinding[];
}

export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
  label: string;
  readonly canonicalIdentity?: ModelToolIdentity;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  readonly largeTextArguments?: AgentToolLargeTextArguments;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  executionMode?: ToolExecutionMode;
}

export interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
  readonly interruptionError?: TurnError;
}

export type KernelEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_restart'; message: AgentMessage }
  | { type: 'message_update'; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: 'message_end'; message: AgentMessage }
  | {
      type: 'tool_call_admission';
      toolCallId: string;
      providerToolCallId: string;
      providerResponsePartIndex: number;
      toolName: string;
      decision: ToolCallAdmissionDecision;
    }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string }
  | {
      type: 'tool_execution_update';
      toolCallId: string;
      toolName: string;
      partialResult: any;
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result: any;
      isError: boolean;
    };

export type AgentEvent = KernelEvent;

export interface ModelError {
  kind: 'contextOverflow' | 'rateLimit' | 'serverError' | 'transport' | 'badRequest' | 'aborted';
  status?: number;
  message: string;
}

export interface ProviderRetryLifecycleEvent {
  phase: 'retrying' | 'cleared';
  kind: 'request' | 'stream';
  attempt: number;
  maxRetries: number;
}

export interface RetryPolicyOptions {
  requestRetryDelayMs?: (retryCount: number) => number;
  onProviderRetry?: (event: ProviderRetryLifecycleEvent) => void;
  maxRequestRetries?: number;
  maxStreamRetries?: number;
  maxRetryDelayMs?: number;
}

export interface KernelAgentOptions {
  initialState: {
    systemPrompt: string;
    model: Model<Api>;
    thinkingLevel: ThinkingLevel;
    tools: readonly AgentTool[];
    messages: readonly Message[];
  };
  gateway: ModelGateway;
  retryOptions?: RetryPolicyOptions;
  transformContext?: () => Promise<Message[]>;
  recoverContextOverflow?: () => Promise<Message[] | null>;
  recoverOptionalContextOverflow?: () => Promise<Message[] | null>;
  admitToolCall?: (request: ToolCallAdmissionRequest) => Promise<ToolCallAdmissionDecision>;
  getApiKey?: (providerId: string) => Promise<string | undefined> | string | undefined;
  sessionId?: string;
  providerOptions?: SimpleStreamOptions;
}
