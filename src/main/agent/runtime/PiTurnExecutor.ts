import {
  Agent,
  type AgentEvent,
  type AgentOptions,
  type AgentState,
  type AgentTool,
} from '@earendil-works/pi-agent-core';
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai';
import type {
  DynamicToolOutputContent,
  JsonValue,
  MessagePhase,
  ThreadItem,
  ThreadUserContent,
} from '../../../core/agent/protocol';
import { resolveAgentModelEffort, resolveProviderModel } from '../capabilities/agentModelResolution';
import { getProviderRuntimeConfig } from '../capabilities/agentSettings';
import { persistedToolResultDetails } from '../capabilities/agentToolResultPersistence';
import {
  piExternalProviderId,
  piResolveAuthApiKey,
  piStreamSimple,
} from '../../piModels';
import type { TurnExecutionContext, TurnExecutionResult, TurnExecutor } from './types';

export const MAX_PERSISTED_TOOL_ARGUMENT_CHARS = 32_000;
export const MAX_PERSISTED_TOOL_OUTPUT_CHARS = 50_000;
export const MAX_PERSISTED_TOOL_OUTPUT_IMAGES = 16;
const MAX_PERSISTED_TOOL_STRING_CHARS = 8_000;
const MAX_PERSISTED_WEB_RESULTS = 50;

export type ModelRuntimeToolFactory = (
  context: TurnExecutionContext,
) => readonly AgentTool[] | Promise<readonly AgentTool[]>;

export interface PiTurnExecutorOptions {
  readonly createTools?: ModelRuntimeToolFactory;
  readonly systemPrompt?: (context: TurnExecutionContext) => string | Promise<string>;
  readonly skillListing?: (context: TurnExecutionContext) => string | null | Promise<string | null>;
  readonly resolveRuntime?: (context: TurnExecutionContext) => Promise<PiRuntimeSelection>;
  readonly createAgent?: (options: AgentOptions) => PiAgentRuntime;
}

export interface PiRuntimeSelection {
  readonly model: Model<Api>;
  readonly thinkingLevel: AgentState['thinkingLevel'];
  getApiKey(providerId: string): Promise<string | undefined>;
}

export interface PiAgentRuntime {
  readonly state: Pick<AgentState, 'errorMessage'>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  abort(): void;
  steer(message: Message): void;
  prompt(message: Message): Promise<void>;
}

export class PiTurnExecutor implements TurnExecutor {
  constructor(private readonly options: PiTurnExecutorOptions = {}) {}

  async execute(context: TurnExecutionContext): Promise<TurnExecutionResult> {
    if (context.signal.aborted) return { status: 'interrupted' };
    let agent: PiAgentRuntime | null = null;
    let unsubscribe: (() => void) | null = null;
    const abort = () => agent?.abort();
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      const runtime = await (this.options.resolveRuntime ?? resolveDefaultRuntime)(context);
      if (context.signal.aborted) return { status: 'interrupted' };
      const tools = [...(await this.options.createTools?.(context) ?? [])];
      if (context.signal.aborted) return { status: 'interrupted' };
      const skillListing = await this.options.skillListing?.(context) ?? null;
      if (context.signal.aborted) return { status: 'interrupted' };
      const systemPrompt = await this.options.systemPrompt?.(context) ?? defaultSystemPrompt(context, skillListing);
      if (context.signal.aborted) return { status: 'interrupted' };
      const normalizer = new PiEventNormalizer(context);
      agent = (this.options.createAgent ?? ((options) => new Agent(options)))({
        initialState: {
          systemPrompt,
          model: runtime.model,
          thinkingLevel: runtime.thinkingLevel,
          tools,
          messages: historyMessages(context, runtime.model),
        },
        streamFn: piStreamSimple,
        getApiKey: runtime.getApiKey,
        steeringMode: 'all',
        sessionId: context.thread.sessionId,
        toolExecution: 'parallel',
      });
      if (context.signal.aborted) {
        agent.abort();
        return { status: 'interrupted' };
      }
      unsubscribe = agent.subscribe((event) => normalizer.handle(event));
      context.onSteer((input) => agent?.steer(modelUserMessage(input.content)));
      await agent.prompt(currentPrompt(context));
      await normalizer.flush();
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
      unsubscribe?.();
    }
  }
}

async function resolveDefaultRuntime(context: TurnExecutionContext): Promise<PiRuntimeSelection> {
  const provider = await getProviderRuntimeConfig(context.thread.modelProvider);
  if (!provider) throw new Error(`Provider is not configured: ${context.thread.modelProvider}`);
  const { model, thinkingLevel } = resolveAgentModelEffort(
    context.configuration.model,
    context.configuration.reasoningEffort,
    provider,
    () => resolveProviderModel(provider),
  );
  return {
    model,
    thinkingLevel,
    getApiKey: async (providerId) => {
      if (piExternalProviderId(providerId) !== provider.providerId) return undefined;
      return provider.apiKey ?? piResolveAuthApiKey(model);
    },
  };
}

export class PiEventNormalizer {
  tokensUsed = 0;
  stopReason: AssistantMessage['stopReason'] | null = null;
  errorMessage: string | null = null;
  private activeMessageItem: Extract<ThreadItem, { type: 'agentMessage' }> | null = null;
  private activeReasoningItem: Extract<ThreadItem, { type: 'reasoning' }> | null = null;
  private readonly toolItems = new Map<string, { item: ThreadItem; startedAt: number }>();
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly context: TurnExecutionContext) {}

  handle(event: AgentEvent): void {
    this.tail = this.tail.then(() => this.process(event));
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  private async process(event: AgentEvent): Promise<void> {
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
    const item = startedToolItem(this.context, callId, identity, args);
    this.toolItems.set(callId, { item: await this.context.recorder.started(item), startedAt: Date.now() });
  }

  private async completeTool(callId: string, result: unknown, isError: boolean): Promise<void> {
    const active = this.toolItems.get(callId);
    if (!active) return;
    await this.context.recorder.completed(await completedToolItem(
      this.context,
      active.item,
      result,
      isError,
      Math.max(0, Date.now() - active.startedAt),
    ));
    this.toolItems.delete(callId);
  }
}

function startedToolItem(
  context: TurnExecutionContext,
  itemId: string,
  identity: { namespace: string | null; name: string },
  args: unknown,
): ThreadItem {
  const base = {
    id: itemId,
    provenance: context.recorder.localProvenance(itemId),
  };
  if (identity.namespace === 'collaboration' && isCollaborationToolName(identity.name)) {
    const input = isRecord(args) ? args : {};
    return {
      ...base,
      type: 'collabAgentToolCall',
      tool: identity.name,
      status: 'inProgress',
      senderThreadId: context.thread.id,
      receiverThreadIds: [],
      prompt: typeof input.message === 'string' ? boundedText(input.message, MAX_PERSISTED_TOOL_STRING_CHARS) : null,
      model: typeof input.model === 'string' ? boundedText(input.model, MAX_PERSISTED_TOOL_STRING_CHARS) : null,
      reasoningEffort: typeof input.reasoning_effort === 'string'
        ? boundedText(input.reasoning_effort, MAX_PERSISTED_TOOL_STRING_CHARS)
        : null,
      agentsStates: {},
    };
  }
  if (identity.name === 'bash' && identity.namespace === null) {
    const input = isRecord(args) ? args : {};
    return {
      ...base,
      type: 'commandExecution',
      command: boundedText(
        typeof input.command === 'string' ? input.command : JSON.stringify(boundedJsonValue(args)),
        MAX_PERSISTED_TOOL_ARGUMENT_CHARS,
      ),
      cwd: boundedText(typeof input.cwd === 'string' ? input.cwd : context.thread.cwd, MAX_PERSISTED_TOOL_STRING_CHARS),
      processId: null,
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
  }
  if (identity.namespace === null && isFileMutationTool(identity.name)) {
    const input = isRecord(args) ? args : {};
    const path = typeof input.path === 'string'
      ? input.path
      : typeof input.file_path === 'string'
        ? input.file_path
        : '(unknown path)';
    return {
      ...base,
      type: 'fileChange',
      changes: [{
        path,
        kind: identity.name === 'file_delete' ? 'delete' : identity.name === 'file_write' ? 'add' : 'update',
      }],
      status: 'inProgress',
    };
  }
  if (identity.name === 'web_search' && identity.namespace === null) {
    const input = isRecord(args) ? args : {};
    return {
      ...base,
      type: 'webSearch',
      query: typeof input.query === 'string' ? input.query : '',
      status: 'inProgress',
      results: [],
      error: null,
    };
  }
  if (identity.namespace && context.configuration.mcpServers.includes(identity.namespace)) {
    return {
      ...base,
      type: 'mcpToolCall',
      server: identity.namespace,
      tool: identity.name,
      status: 'inProgress',
      arguments: boundedJsonValue(args),
      pluginId: null,
      result: null,
      error: null,
      durationMs: null,
    };
  }
  return {
    ...base,
    type: 'dynamicToolCall',
    namespace: identity.namespace,
    tool: identity.name,
    arguments: boundedJsonValue(args),
    status: 'inProgress',
    contentItems: null,
    success: null,
    durationMs: null,
  };
}

async function completedToolItem(
  context: TurnExecutionContext,
  item: ThreadItem,
  result: unknown,
  isError: boolean,
  durationMs: number,
): Promise<ThreadItem> {
  const status = isError ? 'failed' : 'completed';
  switch (item.type) {
    case 'commandExecution': {
      const details = toolDetails(result);
      const data = isRecord(details) && isRecord(details.data) ? details.data : details;
      return {
        ...item,
        status,
        processId: isRecord(data) && typeof data.processId === 'string' ? data.processId : item.processId,
        aggregatedOutput: boundedText(toolResultText(result), MAX_PERSISTED_TOOL_OUTPUT_CHARS),
        exitCode: isRecord(data) && typeof data.exitCode === 'number' ? data.exitCode : isError ? 1 : 0,
        durationMs,
      };
    }
    case 'fileChange':
      return { ...item, status };
    case 'webSearch':
      return {
        ...item,
        status,
        results: webResults(result),
        error: isError
          ? boundedText(toolResultText(result) || 'Web search failed', MAX_PERSISTED_TOOL_STRING_CHARS)
          : null,
      };
    case 'mcpToolCall':
      return {
        ...item,
        status,
        result: isError ? null : boundedJsonValue(toolDetails(result), MAX_PERSISTED_TOOL_OUTPUT_CHARS),
        error: isError
          ? boundedText(toolResultText(result) || 'MCP tool failed', MAX_PERSISTED_TOOL_STRING_CHARS)
          : null,
        durationMs,
      };
    case 'dynamicToolCall':
      return {
        ...item,
        status,
        contentItems: await dynamicOutput(context, item, result),
        success: !isError,
        durationMs,
      };
    case 'collabAgentToolCall': {
      const views = collaborationViews(result);
      const receiverThreadIds = views.flatMap((view) => typeof view.threadId === 'string' ? [view.threadId] : []);
      const agentsStates = Object.fromEntries(views.flatMap((view) => {
        if (typeof view.threadId !== 'string') return [];
        return [[view.threadId, collaborationStatus(view.status, isError)]];
      }));
      return {
        ...item,
        status,
        receiverThreadIds,
        agentsStates,
      };
    }
    default:
      throw new Error(`Unexpected executable Thread Item: ${item.type}`);
  }
}

function isCollaborationToolName(value: string): value is Extract<ThreadItem, { type: 'collabAgentToolCall' }>['tool'] {
  return [
    'spawn_agent',
    'send_message',
    'followup_task',
    'wait_agent',
    'list_agents',
    'interrupt_agent',
  ].includes(value);
}

function isFileMutationTool(value: string): boolean {
  return value === 'file_edit' || value === 'file_write' || value === 'file_delete';
}

function toolDetails(result: unknown): unknown {
  return isRecord(result) && 'details' in result ? result.details : result;
}

function toolResultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return '';
  return result.content.flatMap((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string'
    ? [part.text]
    : []).join('\n');
}

function webResults(result: unknown): Array<{ title: string; url: string; snippet?: string }> {
  const details = toolDetails(result);
  const data = isRecord(details) && isRecord(details.data) ? details.data : details;
  const entries = isRecord(data) && Array.isArray(data.results) ? data.results : [];
  return entries.slice(0, MAX_PERSISTED_WEB_RESULTS).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.title !== 'string' || typeof entry.url !== 'string') return [];
    return [{
      title: boundedText(entry.title, MAX_PERSISTED_TOOL_STRING_CHARS),
      url: boundedText(entry.url, MAX_PERSISTED_TOOL_STRING_CHARS),
      ...(typeof entry.snippet === 'string'
        ? { snippet: boundedText(entry.snippet, MAX_PERSISTED_TOOL_STRING_CHARS) }
        : {}),
    }];
  });
}

function collaborationViews(result: unknown): Array<Record<string, unknown>> {
  const details = toolDetails(result);
  if (Array.isArray(details)) return details.filter(isRecord);
  if (!isRecord(details)) return [];
  if (typeof details.thread_id === 'string') {
    return [{ threadId: details.thread_id, status: 'running' }];
  }
  return [details];
}

function collaborationStatus(value: unknown, isError: boolean): 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'notFound' {
  if (isError) return 'errored';
  if (
    value === 'pendingInit'
    || value === 'running'
    || value === 'interrupted'
    || value === 'completed'
    || value === 'errored'
    || value === 'notFound'
  ) return value;
  return 'completed';
}

function defaultSystemPrompt(context: TurnExecutionContext, skillListing: string | null): string {
  return [
    'You are Tenon, an agent working directly in the user\'s Outliner and local workspace.',
    'Use Thread, Turn, Item, Goal, Subagent, Memory, and Automation as the canonical product vocabulary.',
    'You have Full Access through the tools present in this Turn. Native tool failures are authoritative.',
    'Do not invent approval, sandbox, permission-profile, or legacy agent entities.',
    ...context.configuration.developerInstructions,
    ...context.systemContext,
    skillListing,
  ].filter(Boolean).join('\n\n');
}

export function historyMessages(context: TurnExecutionContext, model: Model<Api>): Message[] {
  const messages: Message[] = [];
  for (const turn of context.historyBeforeTurn) {
    let assistantContent: Array<TextContent | ToolCall> = [];
    let toolResults: ToolResultMessage[] = [];
    const flushAssistant = () => {
      if (assistantContent.length > 0) {
        messages.push(assistantHistoryMessage(
          assistantContent,
          turn.completedAt ?? turn.startedAt,
          model,
          toolResults.length > 0 ? 'toolUse' : 'stop',
        ));
      }
      messages.push(...toolResults);
      assistantContent = [];
      toolResults = [];
    };
    for (const item of turn.items) {
      if (item.type === 'userMessage') {
        flushAssistant();
        messages.push(modelUserMessage(item.content, turn.startedAt));
        continue;
      }
      if (isToolItem(item)) {
        const tool = historyTool(item, turn.completedAt ?? turn.startedAt);
        assistantContent.push(tool.call);
        toolResults.push(tool.result);
        continue;
      }
      if (toolResults.length > 0) flushAssistant();
      switch (item.type) {
        case 'agentMessage':
          if (item.text) assistantContent.push({ type: 'text', text: item.text });
          break;
        case 'reasoning':
          if (item.summary.length > 0 || item.content.length > 0) {
            assistantContent.push({
              type: 'text',
              text: `[Reasoning]\n${[...item.summary, ...item.content].join('\n')}`,
            });
          }
          break;
        case 'plan':
          if (item.text) assistantContent.push({ type: 'text', text: `[Plan]\n${item.text}` });
          break;
        case 'subAgentActivity':
          assistantContent.push({
            type: 'text',
            text: `[Subagent ${item.kind}: ${item.agentPath} (${item.agentThreadId})]`,
          });
          break;
        case 'imageView':
          assistantContent.push({ type: 'text', text: `[Viewed image: ${item.path}]` });
          break;
        case 'contextCompaction':
          assistantContent.push({ type: 'text', text: '[Context compacted]' });
          break;
      }
    }
    flushAssistant();
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
  return modelUserMessage([...input, ...additional], context.turn.startedAt);
}

export function modelUserMessage(content: readonly ThreadUserContent[], timestamp = Date.now()): UserMessage {
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
          const location = part.source.kind === 'localFile'
            ? `\nReadable path: ${part.source.path}\nUse file_read with this path to inspect the attachment.`
            : part.source.kind === 'asset'
              ? `\nAsset id: ${part.source.assetId}`
              : '';
          converted.push({
            type: 'text',
            text: `[Attachment: ${part.name}, ${part.mimeType}, ${part.sizeBytes} bytes]${location}${part.extractedText ? `\n${part.extractedText}` : ''}`,
          });
        }
        break;
    }
  }
  if (converted.length === 0) converted.push({ type: 'text', text: 'Continue.' });
  return { role: 'user', content: converted, timestamp };
}

function assistantHistoryMessage(
  content: AssistantMessage['content'],
  timestamp: number,
  model: Model<Api>,
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
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
    stopReason,
    timestamp,
  };
}

type HistoryToolItem = Extract<ThreadItem, {
  type:
    | 'commandExecution'
    | 'fileChange'
    | 'mcpToolCall'
    | 'dynamicToolCall'
    | 'collabAgentToolCall'
    | 'webSearch';
}>;

function isToolItem(item: ThreadItem): item is HistoryToolItem {
  return item.type === 'commandExecution'
    || item.type === 'fileChange'
    || item.type === 'mcpToolCall'
    || item.type === 'dynamicToolCall'
    || item.type === 'collabAgentToolCall'
    || item.type === 'webSearch';
}

function historyTool(item: HistoryToolItem, timestamp: number): { call: ToolCall; result: ToolResultMessage } {
  const identity = historyToolIdentity(item);
  const toolName = identity.namespace ? `${identity.namespace}__${identity.name}` : identity.name;
  const call: ToolCall = {
    type: 'toolCall',
    id: item.id,
    name: toolName,
    arguments: historyToolArguments(item),
  };
  const result: ToolResultMessage = {
    role: 'toolResult',
    toolCallId: item.id,
    toolName,
    content: [{ type: 'text', text: historyToolResultText(item) }],
    isError: item.status !== 'completed',
    timestamp,
  };
  return { call, result };
}

function historyToolIdentity(item: HistoryToolItem): { namespace: string | null; name: string } {
  switch (item.type) {
    case 'commandExecution':
      return { namespace: null, name: 'bash' };
    case 'fileChange': {
      const kinds = new Set(item.changes.map((change) => change.kind));
      const name = kinds.size === 1 && kinds.has('add')
        ? 'file_write'
        : kinds.size === 1 && kinds.has('delete')
          ? 'file_delete'
          : 'file_edit';
      return { namespace: null, name };
    }
    case 'mcpToolCall':
      return { namespace: item.server, name: item.tool };
    case 'dynamicToolCall':
      return { namespace: item.namespace, name: item.tool };
    case 'collabAgentToolCall':
      return { namespace: 'collaboration', name: item.tool };
    case 'webSearch':
      return { namespace: null, name: 'web_search' };
  }
}

function historyToolArguments(item: HistoryToolItem): Record<string, unknown> {
  switch (item.type) {
    case 'commandExecution':
      return { command: item.command, cwd: item.cwd };
    case 'fileChange':
      return { changes: item.changes };
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return isRecord(item.arguments) ? item.arguments : { value: item.arguments };
    case 'collabAgentToolCall':
      return {
        ...(item.prompt === null ? {} : { message: item.prompt }),
        ...(item.model === null ? {} : { model: item.model }),
        ...(item.reasoningEffort === null ? {} : { reasoning_effort: item.reasoningEffort }),
      };
    case 'webSearch':
      return { query: item.query };
  }
}

function historyToolResultText(item: HistoryToolItem): string {
  switch (item.type) {
    case 'commandExecution':
      return item.aggregatedOutput ?? JSON.stringify({ status: item.status, exitCode: item.exitCode });
    case 'fileChange':
      return JSON.stringify({ status: item.status, changes: item.changes });
    case 'mcpToolCall':
      return item.error ?? JSON.stringify(item.result ?? { status: item.status });
    case 'dynamicToolCall':
      return (item.contentItems ?? []).map((content) => {
        if (content.type === 'text') return content.text;
        if (content.type === 'image') return `[Image output: ${content.imageRef}]`;
        return JSON.stringify(content.value);
      }).join('\n') || JSON.stringify({ status: item.status, success: item.success });
    case 'collabAgentToolCall':
      return JSON.stringify({
        status: item.status,
        receiverThreadIds: item.receiverThreadIds,
        agentsStates: item.agentsStates,
      });
    case 'webSearch':
      return item.error ?? JSON.stringify(item.results);
  }
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

async function dynamicOutput(
  context: TurnExecutionContext,
  item: Extract<ThreadItem, { type: 'dynamicToolCall' }>,
  result: unknown,
): Promise<readonly DynamicToolOutputContent[]> {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return [{ type: 'json', value: boundedJsonValue(result, MAX_PERSISTED_TOOL_OUTPUT_CHARS) }];
  }
  const content: DynamicToolOutputContent[] = [];
  let remainingText = MAX_PERSISTED_TOOL_OUTPUT_CHARS;
  let imageIndex = 0;
  let persistedImages = 0;
  for (const part of result.content) {
    if (!isRecord(part) || typeof part.type !== 'string') continue;
    if (part.type === 'text' && typeof part.text === 'string' && remainingText > 0) {
      const text = boundedText(part.text, remainingText);
      content.push({ type: 'text', text });
      remainingText -= text.length;
    }
    if (part.type === 'image' && typeof part.data === 'string') {
      const sourceImageIndex = imageIndex;
      imageIndex += 1;
      if (persistedImages >= MAX_PERSISTED_TOOL_OUTPUT_IMAGES) continue;
      const mimeType = typeof part.mimeType === 'string' ? part.mimeType : 'image/png';
      const existingPath = toolImagePath(item.tool, result, sourceImageIndex);
      const imageRef = existingPath ?? await context.persistOutputImage(
        item.id,
        sourceImageIndex,
        part.data,
        mimeType,
      );
      content.push({
        type: 'image',
        imageRef,
      });
      persistedImages += 1;
    }
  }
  const persistedDetails = persistedToolResultDetails({ toolName: item.tool, details: result.details });
  if (persistedDetails !== undefined) {
    content.push({ type: 'json', value: boundedJsonValue(persistedDetails, MAX_PERSISTED_TOOL_OUTPUT_CHARS) });
  } else if (content.length === 0 && result.details !== undefined) {
    content.push({ type: 'json', value: boundedJsonValue(result.details, MAX_PERSISTED_TOOL_OUTPUT_CHARS) });
  }
  return content;
}

function toolImagePath(toolName: string, result: Record<string, unknown>, imageIndex: number): string | null {
  const details = toolDetails(result);
  if (!isRecord(details) || !isRecord(details.data)) return null;
  if (toolName === 'file_read' && isRecord(details.data.file)) {
    if (details.data.type === 'image' && typeof details.data.file.filePath === 'string') {
      return details.data.file.filePath;
    }
  }
  if (toolName === 'generate_image' && Array.isArray(details.data.images)) {
    const image = details.data.images[imageIndex];
    if (isRecord(image) && typeof image.path === 'string') return image.path;
  }
  return null;
}

function boundedJsonValue(
  value: unknown,
  maxChars = MAX_PERSISTED_TOOL_ARGUMENT_CHARS,
): JsonValue {
  const normalized = jsonValue(value);
  const encoded = JSON.stringify(normalized);
  if (encoded.length <= maxChars) return normalized;
  const previewBudget = Math.max(0, maxChars - 160);
  return {
    truncated: true,
    originalChars: encoded.length,
    preview: boundedText(encoded, previewBudget),
  };
}

function boundedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return '';
  const marker = `\n... ${value.length - maxChars} chars omitted ...\n`;
  if (marker.length >= maxChars) return value.slice(0, maxChars);
  const available = maxChars - marker.length;
  const head = Math.ceil(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (available - head))}`;
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
