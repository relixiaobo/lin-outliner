import { validateToolArguments } from '@earendil-works/pi-ai/compat';
import { streamWithPolicy } from './retryPolicy';
import type {
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  AssistantMessage,
  KernelAgentOptions,
  KernelEvent,
  Message,
  ToolResultMessage,
} from './types';

export type KernelEventSink = (event: KernelEvent) => Promise<void> | void;

interface KernelContext {
  systemPrompt: string;
  messages: Message[];
  tools: AgentTool[];
}

export interface KernelRunResult {
  readonly messages: Message[];
  readonly interruptionError: string | null;
}

export async function runKernel(
  prompts: Message[],
  initialContext: KernelContext,
  options: KernelAgentOptions,
  emit: KernelEventSink,
  signal: AbortSignal,
  getSteeringMessages: () => Promise<Message[]>,
): Promise<KernelRunResult> {
  const newMessages: Message[] = [...prompts];
  const context: KernelContext = {
    ...initialContext,
    messages: [...initialContext.messages, ...prompts],
  };

  await emit({ type: 'agent_start' });
  await emit({ type: 'turn_start' });
  for (const prompt of prompts) {
    await emit({ type: 'message_start', message: prompt });
    await emit({ type: 'message_end', message: prompt });
  }

  let firstTurn = true;
  let providerCallCount = 0;
  let budgetWarningSent = false;
  let pendingMessages = await getSteeringMessages();
  let hasMoreToolCalls = true;
  while (hasMoreToolCalls || pendingMessages.length > 0) {
    if (!firstTurn) {
      await emit({ type: 'turn_start' });
    } else {
      firstTurn = false;
    }

    if (providerCallCount > 0) {
      const remaining = options.remainingTokenBudget?.() ?? null;
      const used = options.getTurnTokenUsage?.() ?? 0;
      if (remaining !== null && used >= remaining) {
        const interruptionError = `Token budget exhausted mid-Turn (${used} of ${remaining} tokens)`;
        await emit({ type: 'agent_end', messages: newMessages });
        return { messages: newMessages, interruptionError };
      }
      if (
        remaining !== null
        && used >= Math.ceil(remaining * 0.8)
        && !budgetWarningSent
        && options.onBudgetWarning
      ) {
        budgetWarningSent = true;
        await options.onBudgetWarning();
        pendingMessages.push(...await getSteeringMessages());
      }
    }

    for (const message of pendingMessages) {
      await emit({ type: 'message_start', message });
      await emit({ type: 'message_end', message });
      context.messages.push(message);
      newMessages.push(message);
    }
    pendingMessages = [];

    const message = await streamAssistantResponse(context, options, signal, emit);
    providerCallCount += 1;
    newMessages.push(message);
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      await emit({ type: 'turn_end', message, toolResults: [] });
      await emit({ type: 'agent_end', messages: newMessages });
      return { messages: newMessages, interruptionError: null };
    }

    const toolCalls = message.content.filter((part): part is AgentToolCall => part.type === 'toolCall');
    const toolResults: ToolResultMessage[] = [];
    hasMoreToolCalls = false;
    if (toolCalls.length > 0) {
      const batch = message.stopReason === 'length'
        ? await failTruncatedToolCalls(toolCalls, emit)
        : await executeToolCalls(context, toolCalls, signal, emit);
      toolResults.push(...batch.messages);
      hasMoreToolCalls = !batch.terminate;
      for (const result of toolResults) {
        context.messages.push(result);
        newMessages.push(result);
      }
    }

    await emit({ type: 'turn_end', message, toolResults });
    pendingMessages = await getSteeringMessages();
  }

  await emit({ type: 'agent_end', messages: newMessages });
  return { messages: newMessages, interruptionError: null };
}

async function streamAssistantResponse(
  context: KernelContext,
  options: KernelAgentOptions,
  signal: AbortSignal,
  emit: KernelEventSink,
): Promise<AssistantMessage> {
  const projectedMessages = options.transformContext
    ? await options.transformContext()
    : [...context.messages];
  const resolvedApiKey = await options.getApiKey?.(options.initialState.model.provider);
  const response = streamWithPolicy({
    model: options.initialState.model,
    signal,
    ...options.retryOptions,
    recoverContextOverflow: options.recoverContextOverflow,
    attempt: (refreshedMessages, attemptSignal) => options.gateway.stream({
      model: options.initialState.model,
      context: {
        systemPrompt: context.systemPrompt,
        messages: refreshedMessages ?? projectedMessages,
        tools: context.tools,
      },
      options: {
        ...options.providerOptions,
        apiKey: resolvedApiKey || options.providerOptions?.apiKey,
        signal: attemptSignal,
        sessionId: options.sessionId,
        reasoning: options.initialState.thinkingLevel === 'off'
          ? undefined
          : options.initialState.thinkingLevel,
      },
    }),
  });

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;
  streamEvents: for await (const event of response) {
    switch (event.type) {
      case 'start':
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        await emit({ type: 'message_start', message: { ...partialMessage } });
        break;
      case 'text_start':
      case 'text_delta':
      case 'text_end':
      case 'thinking_start':
      case 'thinking_delta':
      case 'thinking_end':
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end':
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({
            type: 'message_update',
            assistantMessageEvent: event,
            message: { ...partialMessage },
          });
        }
        break;
      case 'done':
      case 'error':
        break streamEvents;
    }
  }

  const finalMessage = await response.result();
  if (addedPartial) {
    context.messages[context.messages.length - 1] = finalMessage;
  } else {
    context.messages.push(finalMessage);
    await emit({ type: 'message_start', message: { ...finalMessage } });
  }
  await emit({ type: 'message_end', message: finalMessage });
  return finalMessage;
}

interface ExecutedToolBatch {
  messages: ToolResultMessage[];
  terminate: boolean;
}

interface PreparedToolCall {
  kind: 'prepared';
  toolCall: AgentToolCall;
  tool: AgentTool<any>;
  args: unknown;
}

interface ImmediateToolCall {
  kind: 'immediate';
  result: AgentToolResult<any>;
  isError: boolean;
}

interface ExecutedToolCall {
  result: AgentToolResult<any>;
  isError: boolean;
}

interface FinalizedToolCall extends ExecutedToolCall {
  toolCall: AgentToolCall;
}

type FinalizedToolEntry = FinalizedToolCall | (() => Promise<FinalizedToolCall>);

async function failTruncatedToolCalls(
  toolCalls: AgentToolCall[],
  emit: KernelEventSink,
): Promise<ExecutedToolBatch> {
  const messages: ToolResultMessage[] = [];
  for (const toolCall of toolCalls) {
    await emitToolExecutionStart(toolCall, emit);
    const finalized: FinalizedToolCall = {
      toolCall,
      result: errorToolResult(
        `Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
      ),
      isError: true,
    };
    await emitToolExecutionEnd(finalized, emit);
    const message = createToolResultMessage(finalized);
    await emitToolResultMessage(message, emit);
    messages.push(message);
  }
  return { messages, terminate: false };
}

async function executeToolCalls(
  context: KernelContext,
  toolCalls: AgentToolCall[],
  signal: AbortSignal,
  emit: KernelEventSink,
): Promise<ExecutedToolBatch> {
  const hasSequentialTool = toolCalls.some((call) => (
    context.tools.find((tool) => tool.name === call.name)?.executionMode === 'sequential'
  ));
  return !hasSequentialTool
    ? executeToolCallsParallel(context, toolCalls, signal, emit)
    : executeToolCallsSequential(context, toolCalls, signal, emit);
}

async function executeToolCallsSequential(
  context: KernelContext,
  toolCalls: AgentToolCall[],
  signal: AbortSignal,
  emit: KernelEventSink,
): Promise<ExecutedToolBatch> {
  const finalizedCalls: FinalizedToolCall[] = [];
  const messages: ToolResultMessage[] = [];
  for (const toolCall of toolCalls) {
    await emitToolExecutionStart(toolCall, emit);
    const preparation = await prepareToolCall(context, toolCall, signal);
    const finalized = preparation.kind === 'immediate'
      ? { toolCall, result: preparation.result, isError: preparation.isError }
      : { toolCall, ...await executePreparedToolCall(preparation, signal, emit) };
    await emitToolExecutionEnd(finalized, emit);
    const message = createToolResultMessage(finalized);
    await emitToolResultMessage(message, emit);
    finalizedCalls.push(finalized);
    messages.push(message);
    if (signal.aborted) break;
  }
  return { messages, terminate: shouldTerminateToolBatch(finalizedCalls) };
}

async function executeToolCallsParallel(
  context: KernelContext,
  toolCalls: AgentToolCall[],
  signal: AbortSignal,
  emit: KernelEventSink,
): Promise<ExecutedToolBatch> {
  const entries: FinalizedToolEntry[] = [];
  for (const toolCall of toolCalls) {
    await emitToolExecutionStart(toolCall, emit);
    const preparation = await prepareToolCall(context, toolCall, signal);
    if (preparation.kind === 'immediate') {
      const finalized = { toolCall, result: preparation.result, isError: preparation.isError };
      await emitToolExecutionEnd(finalized, emit);
      entries.push(finalized);
    } else {
      entries.push(async () => {
        const finalized = { toolCall, ...await executePreparedToolCall(preparation, signal, emit) };
        await emitToolExecutionEnd(finalized, emit);
        return finalized;
      });
    }
    if (signal.aborted) break;
  }

  const finalizedCalls = await Promise.all(entries.map((entry) => (
    typeof entry === 'function' ? entry() : Promise.resolve(entry)
  )));
  const messages: ToolResultMessage[] = [];
  for (const finalized of finalizedCalls) {
    const message = createToolResultMessage(finalized);
    await emitToolResultMessage(message, emit);
    messages.push(message);
  }
  return { messages, terminate: shouldTerminateToolBatch(finalizedCalls) };
}

async function prepareToolCall(
  context: KernelContext,
  toolCall: AgentToolCall,
  signal: AbortSignal,
): Promise<PreparedToolCall | ImmediateToolCall> {
  const tool = context.tools.find((candidate) => candidate.name === toolCall.name);
  if (!tool) {
    return { kind: 'immediate', result: errorToolResult(`Tool ${toolCall.name} not found`), isError: true };
  }
  try {
    const preparedArguments = tool.prepareArguments
      ? tool.prepareArguments(toolCall.arguments)
      : toolCall.arguments;
    const preparedCall = preparedArguments === toolCall.arguments
      ? toolCall
      : { ...toolCall, arguments: preparedArguments as Record<string, any> };
    const args = validateToolArguments(tool, preparedCall);
    if (signal.aborted) {
      return { kind: 'immediate', result: errorToolResult('Operation aborted'), isError: true };
    }
    return { kind: 'prepared', toolCall, tool, args };
  } catch (error) {
    return { kind: 'immediate', result: errorToolResult(errorMessage(error)), isError: true };
  }
}

async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal,
  emit: KernelEventSink,
): Promise<ExecutedToolCall> {
  const updates: Promise<void>[] = [];
  let acceptingUpdates = true;
  try {
    const result = await prepared.tool.execute(prepared.toolCall.id, prepared.args, signal, (partialResult) => {
      if (!acceptingUpdates) return;
      updates.push(Promise.resolve(emit({
        type: 'tool_execution_update',
        toolCallId: prepared.toolCall.id,
        toolName: prepared.toolCall.name,
        args: prepared.toolCall.arguments,
        partialResult,
      })));
    });
    acceptingUpdates = false;
    await Promise.all(updates);
    return { result, isError: false };
  } catch (error) {
    acceptingUpdates = false;
    await Promise.all(updates);
    return { result: errorToolResult(errorMessage(error)), isError: true };
  } finally {
    acceptingUpdates = false;
  }
}

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCall[]): boolean {
  return finalizedCalls.length > 0
    && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function errorToolResult(message: string): AgentToolResult<Record<string, never>> {
  return { content: [{ type: 'text', text: message }], details: {} };
}

async function emitToolExecutionStart(toolCall: AgentToolCall, emit: KernelEventSink): Promise<void> {
  await emit({
    type: 'tool_execution_start',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
  });
}

async function emitToolExecutionEnd(finalized: FinalizedToolCall, emit: KernelEventSink): Promise<void> {
  await emit({
    type: 'tool_execution_end',
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError,
  });
}

function createToolResultMessage(finalized: FinalizedToolCall): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    content: finalized.result.content ?? [],
    details: finalized.result.details,
    isError: finalized.isError,
    timestamp: Date.now(),
  };
}

async function emitToolResultMessage(message: ToolResultMessage, emit: KernelEventSink): Promise<void> {
  await emit({ type: 'message_start', message });
  await emit({ type: 'message_end', message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
