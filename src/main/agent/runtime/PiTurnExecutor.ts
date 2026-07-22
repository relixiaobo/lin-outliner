import {
  Agent,
  type AgentEvent,
  type AgentTool,
} from '@earendil-works/pi-agent-core';
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
  UserMessage,
} from '@earendil-works/pi-ai';
import type {
  DynamicToolOutputContent,
  JsonValue,
  MessagePhase,
  ThreadItem,
  ThreadUserContent,
} from '../../../core/agent/protocol';
import { resolveAgentModelEffort, resolveProviderModel } from '../../agentModelResolution';
import { getProviderRuntimeConfig } from '../../agentSettings';
import {
  piExternalProviderId,
  piResolveAuthApiKey,
  piStreamSimple,
} from '../../piModels';
import type { TurnExecutionContext, TurnExecutionResult, TurnExecutor } from './types';

export type ModelRuntimeToolFactory = (
  context: TurnExecutionContext,
) => readonly AgentTool[] | Promise<readonly AgentTool[]>;

export interface PiTurnExecutorOptions {
  readonly createTools?: ModelRuntimeToolFactory;
  readonly systemPrompt?: (context: TurnExecutionContext) => string | Promise<string>;
}

export class PiTurnExecutor implements TurnExecutor {
  constructor(private readonly options: PiTurnExecutorOptions = {}) {}

  async execute(context: TurnExecutionContext): Promise<TurnExecutionResult> {
    if (context.signal.aborted) return { status: 'interrupted' };
    const provider = await getProviderRuntimeConfig(context.thread.modelProvider);
    if (!provider) throw new Error(`Provider is not configured: ${context.thread.modelProvider}`);
    const { model, thinkingLevel } = resolveAgentModelEffort(
      context.configuration.model,
      context.configuration.reasoningEffort,
      provider,
      () => resolveProviderModel(provider),
    );
    const tools = [...(await this.options.createTools?.(context) ?? [])];
    const systemPrompt = await this.options.systemPrompt?.(context) ?? defaultSystemPrompt(context);
    const normalizer = new PiEventNormalizer(context);
    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel,
        tools,
        messages: historyMessages(context),
      },
      streamFn: piStreamSimple,
      getApiKey: async (providerId) => {
        if (piExternalProviderId(providerId) !== provider.providerId) return undefined;
        return provider.apiKey ?? piResolveAuthApiKey(model);
      },
      steeringMode: 'all',
      sessionId: context.thread.sessionId,
      toolExecution: 'parallel',
    });
    const unsubscribe = agent.subscribe((event) => normalizer.handle(event));
    const abort = () => agent.abort();
    context.signal.addEventListener('abort', abort, { once: true });
    context.onSteer((input) => agent.steer(userMessage(input.content)));
    try {
      await agent.prompt(currentPrompt(context));
      if (context.signal.aborted || normalizer.stopReason === 'aborted') {
        return { status: 'interrupted', tokensUsed: normalizer.tokensUsed };
      }
      if (agent.state.errorMessage || normalizer.stopReason === 'error') {
        return {
          status: 'failed',
          error: { message: agent.state.errorMessage ?? normalizer.errorMessage ?? 'Model execution failed' },
          tokensUsed: normalizer.tokensUsed,
        };
      }
      return { status: 'completed', tokensUsed: normalizer.tokensUsed };
    } finally {
      context.signal.removeEventListener('abort', abort);
      unsubscribe();
    }
  }
}

class PiEventNormalizer {
  tokensUsed = 0;
  stopReason: AssistantMessage['stopReason'] | null = null;
  errorMessage: string | null = null;
  private activeMessageItem: Extract<ThreadItem, { type: 'agentMessage' }> | null = null;
  private activeReasoningItem: Extract<ThreadItem, { type: 'reasoning' }> | null = null;
  private readonly toolItems = new Map<string, { item: ThreadItem; startedAt: number }>();

  constructor(private readonly context: TurnExecutionContext) {}

  async handle(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') await this.ensureMessageItem();
        return;
      case 'message_update':
        if (event.message.role !== 'assistant') return;
        if (event.assistantMessageEvent.type === 'text_delta') {
          const item = await this.ensureMessageItem();
          await this.context.recorder.delta(item.id, {
            type: 'agentMessageText',
            delta: event.assistantMessageEvent.delta,
          });
        } else if (event.assistantMessageEvent.type === 'thinking_delta') {
          const item = await this.ensureReasoningItem();
          await this.context.recorder.delta(item.id, {
            type: 'reasoningContent',
            delta: event.assistantMessageEvent.delta,
          });
        }
        return;
      case 'message_end':
        if (event.message.role === 'assistant') await this.completeAssistant(event.message);
        return;
      case 'tool_execution_start':
        await this.startTool(event.toolCallId, event.toolName, event.args);
        return;
      case 'tool_execution_end':
        await this.completeTool(event.toolCallId, event.result, event.isError);
        return;
      case 'agent_end': {
        const terminal = [...event.messages].reverse().find((message): message is AssistantMessage => message.role === 'assistant');
        if (terminal) {
          this.stopReason = terminal.stopReason;
          this.errorMessage = terminal.errorMessage ?? null;
        }
        return;
      }
      default:
        return;
    }
  }

  private async ensureMessageItem(): Promise<Extract<ThreadItem, { type: 'agentMessage' }>> {
    if (this.activeMessageItem) return this.activeMessageItem;
    const id = this.context.recorder.createItemId();
    const item: ThreadItem = {
      type: 'agentMessage',
      id,
      provenance: this.context.recorder.localProvenance(id),
      text: '',
      phase: null,
      memoryCitation: null,
    };
    this.activeMessageItem = await this.context.recorder.started(item) as Extract<ThreadItem, { type: 'agentMessage' }>;
    return this.activeMessageItem;
  }

  private async ensureReasoningItem(): Promise<Extract<ThreadItem, { type: 'reasoning' }>> {
    if (this.activeReasoningItem) return this.activeReasoningItem;
    const id = this.context.recorder.createItemId();
    const item: ThreadItem = {
      type: 'reasoning',
      id,
      provenance: this.context.recorder.localProvenance(id),
      summary: [],
      content: [],
    };
    this.activeReasoningItem = await this.context.recorder.started(item) as Extract<ThreadItem, { type: 'reasoning' }>;
    return this.activeReasoningItem;
  }

  private async completeAssistant(message: AssistantMessage): Promise<void> {
    const messageItem = await this.ensureMessageItem();
    await this.context.recorder.completed({
      ...messageItem,
      text: message.content
        .filter((part): part is TextContent => part.type === 'text')
        .map((part) => part.text)
        .join(''),
      phase: messagePhase(message),
    });
    if (this.activeReasoningItem) {
      await this.context.recorder.completed({
        ...this.activeReasoningItem,
        content: message.content
          .filter((part) => part.type === 'thinking')
          .map((part) => part.thinking),
      });
    }
    this.tokensUsed += message.usage.totalTokens;
    this.stopReason = message.stopReason;
    this.errorMessage = message.errorMessage ?? null;
    this.activeMessageItem = null;
    this.activeReasoningItem = null;
  }

  private async startTool(callId: string, providerName: string, args: unknown): Promise<void> {
    const identity = canonicalIdentity(providerName);
    const id = this.context.recorder.createItemId();
    const item: ThreadItem = {
      type: 'dynamicToolCall',
      id,
      provenance: this.context.recorder.localProvenance(id),
      namespace: identity.namespace,
      tool: identity.name,
      arguments: jsonValue(args),
      status: 'inProgress',
      contentItems: null,
      success: null,
      durationMs: null,
    };
    this.toolItems.set(callId, { item: await this.context.recorder.started(item), startedAt: Date.now() });
  }

  private async completeTool(callId: string, result: unknown, isError: boolean): Promise<void> {
    const active = this.toolItems.get(callId);
    if (!active || active.item.type !== 'dynamicToolCall') return;
    const contentItems = dynamicOutput(result);
    await this.context.recorder.completed({
      ...active.item,
      status: isError ? 'failed' : 'completed',
      contentItems,
      success: !isError,
      durationMs: Math.max(0, Date.now() - active.startedAt),
    });
    this.toolItems.delete(callId);
  }
}

function defaultSystemPrompt(context: TurnExecutionContext): string {
  return [
    'You are Tenon, an agent working directly in the user\'s Outliner and local workspace.',
    'Use Thread, Turn, Item, Goal, Subagent, Memory, and Automation as the canonical product vocabulary.',
    'You have Full Access through the tools present in this Turn. Native tool failures are authoritative.',
    'Do not invent approval, sandbox, permission-profile, or legacy agent entities.',
    ...context.configuration.developerInstructions,
    ...context.systemContext,
  ].filter(Boolean).join('\n\n');
}

function historyMessages(context: TurnExecutionContext): Message[] {
  const messages: Message[] = [];
  for (const turn of context.historyBeforeTurn) {
    for (const item of turn.items) {
      if (item.type === 'userMessage') messages.push(userMessage(item.content, turn.startedAt));
      if (item.type === 'agentMessage' && item.text) {
        messages.push(assistantHistoryMessage(item.text, turn.completedAt ?? turn.startedAt));
      }
    }
  }
  return messages;
}

function currentPrompt(context: TurnExecutionContext): UserMessage {
  const input = context.turn.items
    .filter((item) => item.type === 'userMessage')
    .flatMap((item) => item.content);
  const additional = context.additionalContext
    ? Object.entries(context.additionalContext).map(([key, entry]) => ({
        type: 'text' as const,
        text: `[${entry.kind} context: ${key}]\n${entry.value}`,
      }))
    : [];
  return userMessage([...input, ...additional], context.turn.startedAt);
}

function userMessage(content: readonly ThreadUserContent[], timestamp = Date.now()): UserMessage {
  const converted: Array<TextContent | ImageContent> = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        converted.push({ type: 'text', text: part.text });
        break;
      case 'nodeReference':
        converted.push({ type: 'text', text: `[Outliner Node ${part.nodeId}]${part.note ? ` ${part.note}` : ''}` });
        break;
      case 'attachment':
        if (part.source.kind === 'inline' && part.mimeType.startsWith('image/')) {
          converted.push({ type: 'image', data: part.source.dataBase64, mimeType: part.mimeType });
        } else {
          converted.push({
            type: 'text',
            text: `[Attachment: ${part.name}, ${part.mimeType}, ${part.sizeBytes} bytes]${part.extractedText ? `\n${part.extractedText}` : ''}`,
          });
        }
        break;
    }
  }
  if (converted.length === 0) converted.push({ type: 'text', text: 'Continue.' });
  return { role: 'user', content: converted, timestamp };
}

function assistantHistoryMessage(text: string, timestamp: number): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'openai',
    model: 'history',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp,
  };
}

function messagePhase(message: AssistantMessage): MessagePhase {
  if (message.stopReason === 'toolUse') return 'commentary';
  const signature = message.content.find((part): part is TextContent => part.type === 'text')?.textSignature;
  if (signature) {
    try {
      const parsed = JSON.parse(signature) as { phase?: unknown };
      if (parsed.phase === 'commentary' || parsed.phase === 'final_answer') return parsed.phase;
    } catch {
      // Provider signatures are opaque unless they use the documented JSON envelope.
    }
  }
  return 'final_answer';
}

function canonicalIdentity(providerName: string): { namespace: string | null; name: string } {
  const separator = providerName.indexOf('__');
  return separator < 0
    ? { namespace: null, name: providerName }
    : { namespace: providerName.slice(0, separator), name: providerName.slice(separator + 2) };
}

function dynamicOutput(result: unknown): readonly DynamicToolOutputContent[] {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return [{ type: 'json', value: jsonValue(result) }];
  }
  const content: DynamicToolOutputContent[] = [];
  for (const part of result.content) {
    if (!isRecord(part) || typeof part.type !== 'string') continue;
    if (part.type === 'text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text });
    if (part.type === 'image' && typeof part.data === 'string') {
      content.push({
        type: 'image',
        imageRef: `data:${typeof part.mimeType === 'string' ? part.mimeType : 'image/png'};base64,${part.data}`,
      });
    }
  }
  if ('details' in result && result.details !== undefined) content.push({ type: 'json', value: jsonValue(result.details) });
  return content;
}

function jsonValue(value: unknown): JsonValue {
  try {
    const encoded = JSON.stringify(value ?? null);
    return JSON.parse(encoded) as JsonValue;
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
