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
import type { ModelGateway } from './ModelGateway';

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

export interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  terminate?: boolean;
}

export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
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
}

export type KernelEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: 'message_end'; message: AgentMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: any }
  | {
      type: 'tool_execution_update';
      toolCallId: string;
      toolName: string;
      args: any;
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
  getApiKey?: (providerId: string) => Promise<string | undefined> | string | undefined;
  sessionId?: string;
  providerOptions?: SimpleStreamOptions;
}
